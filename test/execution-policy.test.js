import assert from "node:assert/strict"
import test from "node:test"
import { ABORT_REASON, abortsRemaining, createNonceAllocator, sendersOf, skippedEntries } from "../server/execution-policy.js"

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

test("an uncertain broadcast stops that sender in every mode", () => {
  assert.equal(abortsRemaining({ mode: "burst", uncertain: true }), true)
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

test("the allocator advances only after an accepted broadcast", () => {
  const allocator = createNonceAllocator(new Map([["sender", 42]]))
  assert.equal(allocator.current("sender"), 42)
  allocator.accept("sender", 42)
  assert.equal(allocator.current("sender"), 43)
  allocator.reject("sender", 43)
  assert.equal(allocator.current("sender"), 43, "a definite refusal does not consume the nonce")
  allocator.accept("sender", 43)
  assert.equal(allocator.current("sender"), 44)
})

test("each sender keeps an independent sequence", () => {
  const allocator = createNonceAllocator(new Map([["a", 5], ["b", 100]]))
  allocator.accept("a", 5)
  assert.equal(allocator.current("a"), 6)
  assert.equal(allocator.current("b"), 100)
  allocator.accept("b", 100)
  assert.equal(allocator.current("b"), 101)
})

test("an unknown broadcast blocks only its sender", () => {
  const allocator = createNonceAllocator(new Map([["a", 5], ["b", 100]]))
  allocator.block("a", 5)
  assert.equal(allocator.blocked("a"), true)
  assert.equal(allocator.current("a"), null)
  assert.equal(allocator.blocked("b"), false)
  assert.equal(allocator.current("b"), 100)
})

test("an unknown sender and an out-of-order acceptance are refused", () => {
  const allocator = createNonceAllocator(new Map([["a", 5]]))
  assert.equal(allocator.current("unknown"), null)
  assert.throws(() => allocator.accept("a", 6), /nonce/i)
  assert.throws(() => allocator.accept("unknown", 0), /nonce/i)
})

test("sendersOf lists each wallet once", () => {
  assert.deepEqual(sendersOf([{ walletId: "a" }, { walletId: "b" }, { walletId: "a" }]), ["a", "b"])
  assert.deepEqual(sendersOf([]), [])
})
