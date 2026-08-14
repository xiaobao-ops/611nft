const WRITE_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_submitTransaction",
  "eth_submitWork",
  "eth_submitHashrate",
])

const REALTIME_CACHE_METHODS = new Set([
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockReceipts",
  "eth_getLogs",
  "eth_getStorageAt",
])

const HEAVY_READ_METHODS = new Set(["eth_getLogs", "eth_getBlockReceipts"])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function rpcError(value, url) {
  const error = new Error(value?.message || `RPC request failed at ${new URL(url).hostname}`)
  error.isRpcError = true
  if (value?.code !== undefined) error.code = value.code
  if (value?.data !== undefined) error.data = value.data
  return error
}

function stableKey(method, params) {
  return `${method}:${JSON.stringify(params || [])}`
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createRpcPool({
  urls,
  fetchImpl = fetch,
  timeoutMs = 12000,
  hedgeDelayMs = 900,
  maxAttempts = 3,
  cacheTtlMs = 2000,
  circuitFailureThreshold = 3,
  circuitWindowSize = 8,
  halfOpenAfterMs = 15000,
} = {}) {
  const uniqueUrls = [...new Set((urls || []).map(String).map((value) => value.trim()).filter(Boolean))]
  if (!uniqueUrls.length) throw new Error("RPC pool requires at least one upstream")
  const upstreams = uniqueUrls.map((url) => ({
    url,
    failures: [],
    circuitOpenUntil: 0,
    latencyMs: null,
    requests: 0,
    successes: 0,
    lastError: "",
  }))
  const cache = new Map()
  const inflight = new Map()

  function availableUpstreams({ rank = true } = {}) {
    const now = Date.now()
    const available = upstreams.filter((item) => item.circuitOpenUntil <= now)
    const selected = available.length ? available : [...upstreams].sort((a, b) => a.circuitOpenUntil - b.circuitOpenUntil).slice(0, 1)
    return rank
      ? selected.sort((a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER))
      : selected
  }

  function record(upstream, { ok, latencyMs, error = "", countFailure = true }) {
    upstream.requests += 1
    upstream.latencyMs = upstream.latencyMs === null ? latencyMs : Math.round(upstream.latencyMs * 0.7 + latencyMs * 0.3)
    if (ok) {
      upstream.successes += 1
      upstream.lastError = ""
      upstream.failures = []
      upstream.circuitOpenUntil = 0
      return
    }
    upstream.lastError = error
    if (!countFailure) return
    upstream.failures.push(Date.now())
    upstream.failures = upstream.failures.slice(-circuitWindowSize)
    if (upstream.failures.length >= circuitFailureThreshold) upstream.circuitOpenUntil = Date.now() + halfOpenAfterMs
  }

  async function call(upstream, request, signal) {
    const started = performance.now()
    try {
      const response = await fetchImpl(upstream.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: request.method, params: request.params || [] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) error.isRpcError = true
        throw error
      }
      if (!payload) throw new Error("RPC returned non-JSON content")
      if (payload.error) throw rpcError(payload.error, upstream.url)
      record(upstream, { ok: true, latencyMs: Math.round(performance.now() - started) })
      return payload.result
    } catch (error) {
      if (!signal.aborted) {
        record(upstream, {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          error: errorMessage(error),
          countFailure: !error?.isRpcError,
        })
      }
      throw error
    }
  }

  async function hedgedRead(request) {
    const candidates = availableUpstreams({ rank: !HEAVY_READ_METHODS.has(request.method) })
    const errors = []
    for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
      const primary = candidates[attempt % candidates.length]
      const secondary = !HEAVY_READ_METHODS.has(request.method) && candidates.length > 1
        ? candidates[(attempt + 1) % candidates.length]
        : null
      const controllers = [new AbortController(), new AbortController()]
      try {
        const tasks = [call(primary, request, controllers[0].signal)]
        if (secondary && secondary !== primary) tasks.push(wait(hedgeDelayMs).then(() => {
          if (controllers[1].signal.aborted) throw new DOMException("Hedged request cancelled", "AbortError")
          return call(secondary, request, controllers[1].signal)
        }))
        const result = await Promise.any(tasks)
        controllers.forEach((controller) => controller.abort())
        return result
      } catch (error) {
        const attemptErrors = error instanceof AggregateError ? error.errors : [error]
        errors.push(...attemptErrors)
        controllers.forEach((controller) => controller.abort())
        if (attemptErrors.length && attemptErrors.every((item) => item?.isRpcError)) break
      }
    }
    throw new Error(`All RPC upstreams failed for ${request.method}: ${errors.map(errorMessage).join(" | ")}`)
  }

  async function request(request) {
    if (WRITE_METHODS.has(request.method)) {
      const upstream = availableUpstreams({ rank: false })[0]
      return call(upstream, request, new AbortController().signal)
    }
    const cacheable = REALTIME_CACHE_METHODS.has(request.method)
    const key = stableKey(request.method, request.params)
    const cached = cache.get(key)
    if (cacheable && cached && cached.expiresAt > Date.now()) return cached.value
    if (cacheable && inflight.has(key)) return inflight.get(key)
    const pending = hedgedRead(request)
      .then((value) => {
        if (cacheable && value !== null && value !== undefined) cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs })
        return value
      })
      .finally(() => inflight.delete(key))
    if (cacheable) inflight.set(key, pending)
    return pending
  }

  function status() {
    const timestamp = Date.now()
    return upstreams.map((item) => ({
      url: item.url,
      host: new URL(item.url).hostname,
      state: item.circuitOpenUntil > timestamp ? "open" : "ready",
      latencyMs: item.latencyMs,
      requests: item.requests,
      successes: item.successes,
      lastError: item.lastError,
      retryAfterMs: Math.max(0, item.circuitOpenUntil - timestamp),
    }))
  }

  return { request, status }
}
