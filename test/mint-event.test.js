import assert from "node:assert/strict"
import test from "node:test"
import { canonicalDedupeKey, canonicalEventId, normalizeMintEvent } from "../server/mint-event.js"

const txHash = `0x${"aa".repeat(32)}`
const contract = "0x1111111111111111111111111111111111111111"

test("canonical mint identity includes chain, contract and log index", () => {
  const event = normalizeMintEvent({ chainId: 1, txHash, contract, logIndex: 7, quantity: "2" }, { source: "rpc" })
  assert.equal(event.eventId, `1:${txHash}:${contract}:7`)
  assert.equal(event.dedupeKey, event.eventId)
  assert.equal(event.status, "confirmed")
  assert.equal(event.source, "rpc")
  assert.equal(event.valueWei, null)
})

test("canonical identity falls back without log index and preserves lifecycle fields", () => {
  const pending = { chainId: 8453, txHash, contract, status: "pending", source: "wss", quantity: null }
  assert.equal(canonicalDedupeKey(pending), `8453:${txHash}:${contract}`)
  assert.equal(canonicalEventId(pending), `8453:${txHash}:${contract}`)
  const normalized = normalizeMintEvent(pending)
  assert.equal(normalized.status, "pending")
  assert.equal(normalized.quantity, null)
  assert.equal(normalized.observedAt.length > 0, true)
})
