// Classifying a failed broadcast. Two questions, in order, and the order matters:
//
//   1. Might the transaction have reached a mempool? If so it is *uncertain*: it may still
//      confirm, so nothing may be re-sent on that nonce and the batch must stop.
//   2. If it definitely did not, was the endpoint at fault rather than the transaction? If
//      so the next endpoint in the pool should be tried.
//
// Getting (1) wrong risks double-sending. Getting (2) wrong fails entries a healthy endpoint
// would have accepted — 34 of 40 in one observed disperse. So uncertainty always wins: any
// error that might have landed is never treated as a retryable endpoint failure.
export function broadcastUncertain(error) {
  if (error?.broadcastUncertain || error?.code === "BROADCAST_UNCERTAIN") return true
  return /(?:timed? ?out|timeout|deadline exceeded|ETIMEDOUT|aborted)/i.test(String(error?.message || ""))
}

const NETWORK_CODES = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]
const NETWORK_MESSAGE = /(?:connection refused|connection reset|name resolution|dns|host unreachable|network is unreachable|socket hang up)/i

// An endpoint declining to serve the request at all. Each of these is refused before the
// transaction could reach a mempool, so no nonce was consumed and failing over is safe.
//
// Observed under load: robinhood.api.pocket.network answers a lone eth_sendRawTransaction
// normally but, once a batch pushes it, returns 'The method "eth_sendRawTransaction" does
// not exist / is not available' — rate limiting wearing a capability error's clothes. Read
// as a permanent capability gap it failed every entry that touched that endpoint; read as
// "this endpoint is refusing", the next one accepts them.
const REFUSAL_MESSAGE = /(?:does not exist|is not available|method not found|not supported|unsupported method|rate ?limit|too many requests|quota|forbidden|unauthorized|payment required|service unavailable|bad gateway|gateway timeout)/i

export function broadcastConnectionFailure(error) {
  // Never fail over on something that might already be in flight.
  if (broadcastUncertain(error)) return false
  const code = String(error?.code || "").toUpperCase()
  if (NETWORK_CODES.includes(code)) return true
  const message = String(error?.message || "")
  return NETWORK_MESSAGE.test(message) || REFUSAL_MESSAGE.test(message)
}
