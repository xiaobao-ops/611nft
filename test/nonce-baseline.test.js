import assert from "node:assert/strict"
import test from "node:test"
import { baseNonce, pendingGap } from "../server/nonce-baseline.js"

// A pending transaction already owns nonce 140. Starting from latest would replace it;
// every newly signed transaction must begin after the highest count seen by the writer.
test("a pending transaction advances the batch beyond the mined nonce", () => {
  assert.equal(baseNonce({ latest: 140, pending: 141 }), 141)
})

test("the common case, nothing in flight, uses the agreed value", () => {
  assert.equal(baseNonce({ latest: 140, pending: 140 }), 140)
  assert.equal(baseNonce({ latest: 0, pending: 0 }), 0)
})

test("a large pending gap is preserved instead of reusing an occupied nonce", () => {
  assert.equal(baseNonce({ latest: 140, pending: 180 }), 180)
})

test("a pending count behind the mined count is ignored rather than trusted", () => {
  // A lagging replica can report fewer pending than are mined; reusing a mined nonce would
  // be rejected as "nonce too low" for the whole batch.
  assert.equal(baseNonce({ latest: 140, pending: 138 }), 140)
})

test("an unreadable pending count falls back to the mined count", () => {
  // getTransactionCount(pending) is allowed to fail; the mined count alone still works.
  assert.equal(baseNonce({ latest: 140, pending: null }), 140)
  assert.equal(baseNonce({ latest: 140, pending: undefined }), 140)
  assert.equal(baseNonce({ latest: 140, pending: "oops" }), 140)
})

test("an unreadable mined count falls back to pending rather than failing the batch", () => {
  assert.equal(baseNonce({ latest: null, pending: 141 }), 141)
})

test("neither count readable is an error, not a silent zero", () => {
  // Defaulting to 0 here would re-send the account's entire history.
  assert.throws(() => baseNonce({ latest: null, pending: null }), /交易序号/)
  assert.throws(() => baseNonce({}), /交易序号/)
})

test("a negative count is refused rather than used", () => {
  assert.throws(() => baseNonce({ latest: -1, pending: -1 }), /交易序号/)
  assert.equal(baseNonce({ latest: -1, pending: 5 }), 5)
})

test("the gap is reported so a stuck transaction is visible, not worked around silently", () => {
  assert.equal(pendingGap({ latest: 140, pending: 141 }), 1)
  assert.equal(pendingGap({ latest: 140, pending: 180 }), 40)
})

test("no gap is reported when the counts agree or pending lags", () => {
  assert.equal(pendingGap({ latest: 140, pending: 140 }), 0)
  assert.equal(pendingGap({ latest: 140, pending: 138 }), 0)
  assert.equal(pendingGap({ latest: 140, pending: null }), 0)
})
