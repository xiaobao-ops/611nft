import assert from "node:assert/strict"
import test from "node:test"
import { broadcastConnectionFailure, broadcastUncertain } from "../server/broadcast-classify.js"

function rpcError(message, code) {
  return Object.assign(new Error(message), code ? { code } : {})
}

// The error that failed 34 of 40 entries: this endpoint answers a lone send normally, but
// under batch load returns a capability error instead of a rate-limit one. The next endpoint
// in the pool would have accepted every one of them.
const POCKET_REFUSAL = 'The method "eth_sendRawTransaction" does not exist / is not available.\n\nURL: https://robinhood.api.pocket.network/'

test("an endpoint refusing to serve the method is a failover, not a dead entry", () => {
  assert.equal(broadcastConnectionFailure(rpcError(POCKET_REFUSAL)), true)
  assert.equal(broadcastUncertain(rpcError(POCKET_REFUSAL)), false, "it never reached a mempool")
})

test("the other ways an endpoint declines are all failovers", () => {
  for (const message of [
    "Method not found",
    "method not supported",
    "unsupported method eth_sendRawTransaction",
    "429 Too Many Requests",
    "rate limit exceeded",
    "monthly quota exceeded",
    "403 Forbidden",
    "401 Unauthorized",
    "402 Payment Required",
    "503 Service Unavailable",
    "502 Bad Gateway",
  ]) {
    assert.equal(broadcastConnectionFailure(rpcError(message)), true, message)
  }
  // Not "504 Gateway Timeout": it reads as a timeout first, so it is classed uncertain and
  // deliberately not failed over. See the ordering test below.
})

test("network-level failures remain failovers", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
    assert.equal(broadcastConnectionFailure(rpcError("boom", code)), true, code)
  }
  for (const message of ["connection refused", "socket hang up", "network is unreachable", "DNS lookup failed"]) {
    assert.equal(broadcastConnectionFailure(rpcError(message)), true, message)
  }
})

test("a timeout is uncertain and must never fail over", () => {
  // The transaction may already be in the mempool; sending it again on the same nonce would
  // either replace a live transaction or double-spend.
  for (const message of ["request timed out", "timeout of 5000ms exceeded", "deadline exceeded", "ETIMEDOUT", "The operation was aborted"]) {
    assert.equal(broadcastUncertain(rpcError(message)), true, message)
    assert.equal(broadcastConnectionFailure(rpcError(message)), false, `${message} must not fail over`)
  }
})

test("an explicitly uncertain error wins over any refusal wording it also contains", () => {
  // Ordering matters: 'gateway timeout' matches both patterns, and uncertainty must win.
  const error = rpcError("504 Gateway Timeout")
  assert.equal(broadcastUncertain(error), true)
  assert.equal(broadcastConnectionFailure(error), false)

  const flagged = Object.assign(new Error("rate limit exceeded"), { broadcastUncertain: true })
  assert.equal(broadcastConnectionFailure(flagged), false, "a flagged error is never retried elsewhere")
})

test("the uncertain marker is honoured in both its forms", () => {
  assert.equal(broadcastUncertain({ broadcastUncertain: true }), true)
  assert.equal(broadcastUncertain({ code: "BROADCAST_UNCERTAIN" }), true)
})

test("a rejection by the chain itself is not an endpoint problem", () => {
  // These are verdicts on the transaction: another endpoint would say exactly the same, and
  // failing over just repeats the rejection.
  for (const message of [
    "nonce too low",
    "nonce too high: address 0x66, tx: 141 state: 140",
    "insufficient funds for gas * price + value",
    "intrinsic gas too low",
    "execution reverted",
    "already known",
    "replacement transaction underpriced",
    "max fee per gas less than block base fee",
  ]) {
    assert.equal(broadcastConnectionFailure(rpcError(message)), false, message)
    assert.equal(broadcastUncertain(rpcError(message)), false, message)
  }
})

test("an empty or missing error is neither uncertain nor retryable", () => {
  assert.equal(broadcastUncertain(undefined), false)
  assert.equal(broadcastUncertain(null), false)
  assert.equal(broadcastConnectionFailure(undefined), false)
  assert.equal(broadcastConnectionFailure(new Error("")), false)
})
