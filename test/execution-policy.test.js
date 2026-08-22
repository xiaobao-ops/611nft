import assert from "node:assert/strict"
import test from "node:test"
import { ABORT_REASON, abortsRemaining, assignNonces, sendersOf, skippedEntries } from "../server/execution-policy.js"

const ENTRIES = Array.from({ length: 10 }, (_, index) => ({ walletId: `w${index + 1}`, to: `0x${index}`, valueWei: "1" }))

test("a definite rejection never stops the wallets behind it", () => {
  // A revert or an insufficient-funds refusal never reached the mempool, so the sender's
  // nonce is untouched and entries 3..10 are still perfectly sendable. Treating this as
  // fatal is what turned a 10-wallet disperse into a single executed transfer.
  assert.equal(abortsRemaining({ mode: "sequential", uncertain: false }), false)
  assert.equal(abortsRemaining({ mode: "burst", uncertain: false }), false)
})

test("an uncertain broadcast does stop them, because the nonce state is unknown", () => {
  // The transaction may already be in the mempool. Sending the next entry would either
  // replace it or leave a nonce gap that stalls everything behind it.
  assert.equal(abortsRemaining({ mode: "sequential", uncertain: true }), true)
})

test("burst mode never aborts: its nonces were assigned up front", () => {
  // Concurrent sending is now the default for disperse and collection. It is only safe
  // because every entry carries a nonce assigned before the first send, so one failure
  // cannot shift the sequence for the others.
  assert.equal(abortsRemaining({ mode: "burst", uncertain: true }), false)
  assert.equal(abortsRemaining({ mode: "burst", uncertain: false }), false)
})

test("entries the run never reached are reported, not silently dropped", () => {
  // The original bug was invisible: eight untouched wallets simply did not appear in the
  // results, so the operator saw "1 executed" with no indication anything was pending.
  const skipped = skippedEntries(ENTRIES, 2, ABORT_REASON)
  assert.equal(skipped.length, 8)
  assert.deepEqual(skipped.map((entry) => entry.walletId), ["w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"])
  assert.ok(skipped.every((entry) => entry.status === "skipped" && entry.ok === false && entry.skipped === true))
  assert.match(skipped[0].error, /nonce/)
  // The original entry fields survive so the report can name the wallet and amount.
  assert.equal(skipped[0].to, "0x2")
  assert.equal(skipped[0].valueWei, "1")
})

test("a run that reached every entry reports nothing as skipped", () => {
  assert.equal(skippedEntries(ENTRIES, ENTRIES.length, ABORT_REASON).length, 0)
  assert.equal(skippedEntries(ENTRIES, 99, ABORT_REASON).length, 0)
})

test("a batch that failed on the very first entry reports the other nine", () => {
  assert.equal(skippedEntries(ENTRIES, 1, ABORT_REASON).length, 9)
})

test("nonces come from one read per sender, so no two entries collide", () => {
  // The observed failure: 11 transfers from one wallet, and exactly every other one was
  // rejected because the node still reported the pre-send nonce. One read plus an offset
  // removes the race entirely.
  const entries = Array.from({ length: 11 }, () => ({ walletId: "sender" }))
  assignNonces(entries, new Map([["sender", 42]]))
  assert.deepEqual(entries.map((entry) => entry.nonce), [42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52])
  assert.equal(new Set(entries.map((entry) => entry.nonce)).size, 11, "every nonce must be distinct")
})

test("each sender keeps its own independent sequence", () => {
  const entries = [
    { walletId: "a" }, { walletId: "b" }, { walletId: "a" }, { walletId: "b" }, { walletId: "a" },
  ]
  assignNonces(entries, new Map([["a", 5], ["b", 100]]))
  assert.deepEqual(entries.map((entry) => entry.nonce), [5, 100, 6, 101, 7])
})

test("a nonce the caller already pinned is left alone", () => {
  const entries = [{ walletId: "a", nonce: 9 }, { walletId: "a" }, { walletId: "a" }]
  assignNonces(entries, new Map([["a", 20]]))
  assert.deepEqual(entries.map((entry) => entry.nonce), [9, 20, 21], "only the unset ones are filled")
})

test("an entry whose sender was never read keeps no nonce rather than a wrong one", () => {
  const entries = [{ walletId: "unknown" }]
  assignNonces(entries, new Map())
  assert.equal(entries[0].nonce, undefined)
})

test("sendersOf lists each wallet once", () => {
  assert.deepEqual(sendersOf([{ walletId: "a" }, { walletId: "b" }, { walletId: "a" }]), ["a", "b"])
  assert.deepEqual(sendersOf([]), [])
})
