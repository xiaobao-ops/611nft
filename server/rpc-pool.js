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
  const upstreamSpecific = /rate.?limit|quota|usage limit|archive request|personal token|upgrade|payment|unauthori[sz]ed|forbidden/i.test(error.message)
  error.isRpcError = !upstreamSpecific
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

function isRateLimitError(error) {
  return Number(error?.status) === 429 || /rate.?limit|too many requests|\b429\b|quota/i.test(errorMessage(error))
}

function retryAfterMs(response, fallbackMs) {
  const raw = response?.headers?.get?.("retry-after") || response?.headers?.get?.("Retry-After")
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return fallbackMs
}

function closeClient(client) {
  if (!client) return
  if (typeof client === "function") client()
  else if (typeof client.close === "function") client.close()
  else if (typeof client.stop === "function") client.stop()
  else if (typeof client.unsubscribe === "function") client.unsubscribe()
  else if (typeof client.disconnect === "function") client.disconnect()
}

export function createRpcPool({
  urls,
  chainId = null,
  fetchImpl = fetch,
  timeoutMs = 12000,
  hedgeDelayMs = 900,
  maxAttempts = 3,
  cacheTtlMs = 2000,
  circuitFailureThreshold = 3,
  circuitWindowSize = 8,
  halfOpenAfterMs = 15000,
  mismatchBackoffMs = 5 * 60 * 1000,
  rateLimitBackoffMs = [2000, 4000, 8000, 16000, 30000],
} = {}) {
  const uniqueUrls = [...new Set((urls || []).map(String).map((value) => value.trim()).filter(Boolean))]
  if (!uniqueUrls.length) throw new Error("RPC pool requires at least one upstream")
  const upstreams = uniqueUrls.map((url, index) => ({
    id: `rpc-${index}`,
    url,
    failures: [],
    state: chainId === null || chainId === undefined ? "ready" : "probing",
    reportedChainId: null,
    mismatchUntil: 0,
    backoffUntil: 0,
    probeAt: 0,
    circuitOpenUntil: 0,
    latencyMs: null,
    lastLatencyMs: null,
    requests: 0,
    successes: 0,
    httpFallbacks: 0,
    rateLimitCount: 0,
    lastError: "",
    failureCount: 0,
    retryAfterMs: 0,
  }))
  const cache = new Map()
  const inflight = new Map()
  let preferredUrl = null

  function availableUpstreams({ rank = true, includeFallback = false } = {}) {
    const now = Date.now()
    for (const item of upstreams) {
      if (item.state === "mismatch" && item.mismatchUntil <= now) item.state = "probing"
      if (item.state === "backoff" && item.backoffUntil <= now) item.state = "ready"
      if (item.state === "open" && item.circuitOpenUntil <= now) item.state = "probing"
    }
    const available = upstreams.filter((item) => item.circuitOpenUntil <= now && item.backoffUntil <= now && item.mismatchUntil <= now && item.state !== "mismatch")
    const fallback = chainId === null || chainId === undefined ? upstreams : upstreams.filter((item) => item.state !== "mismatch")
    const preferred = preferredUrl && available.find((item) => item.url === preferredUrl)
    const selected = preferred
      ? (includeFallback ? [preferred, ...available.filter((item) => item !== preferred)] : [preferred])
      : available.length ? available : [...fallback].sort((a, b) => a.circuitOpenUntil - b.circuitOpenUntil).slice(0, 1)
    if (!rank || !preferred || selected[0] !== preferred) {
      return rank
        ? selected.sort((a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER))
        : selected
    }
    return [preferred, ...selected.slice(1).sort((a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER))]
  }

  function record(upstream, { ok, latencyMs, error = "", countFailure = true }) {
    upstream.requests += 1
    upstream.lastLatencyMs = latencyMs
    upstream.latencyMs = upstream.latencyMs === null ? latencyMs : Math.round(upstream.latencyMs * 0.7 + latencyMs * 0.3)
    if (ok) {
      upstream.successes += 1
      upstream.state = "ready"
      upstream.lastError = ""
      upstream.retryAfterMs = 0
      upstream.backoffUntil = 0
      upstream.failures = []
      upstream.circuitOpenUntil = 0
      return
    }
    upstream.lastError = error
    upstream.failureCount += 1
    if (!countFailure) return
    upstream.failures.push(Date.now())
    upstream.failures = upstream.failures.slice(-circuitWindowSize)
    if (upstream.failures.length >= circuitFailureThreshold) {
      upstream.circuitOpenUntil = Date.now() + halfOpenAfterMs
      upstream.state = "open"
    } else if (upstream.state !== "mismatch") upstream.state = "backoff"
  }

  async function probe(upstream) {
    if (chainId === null || chainId === undefined) return true
    const timestamp = Date.now()
    if (upstream.state === "ready" && upstream.reportedChainId === Number(chainId)) return true
    if (upstream.state === "mismatch" && upstream.mismatchUntil > timestamp) return false
    upstream.state = "probing"; upstream.probeAt = timestamp
    const started = performance.now()
    try {
      const response = await fetchImpl(upstream.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.error) throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`), { status: response.status })
      const reported = Number(BigInt(payload?.result || "0x0"))
      upstream.reportedChainId = Number.isFinite(reported) ? reported : null
      const latencyMs = Math.round(performance.now() - started)
      upstream.lastLatencyMs = latencyMs
      upstream.latencyMs = upstream.latencyMs === null ? latencyMs : Math.round(upstream.latencyMs * 0.7 + latencyMs * 0.3)
      if (reported !== Number(chainId)) {
        upstream.state = "mismatch"; upstream.mismatchUntil = Date.now() + mismatchBackoffMs; upstream.lastError = `reported chainId ${reported}`; return false
      }
      upstream.state = "ready"; upstream.lastError = ""; upstream.backoffUntil = 0; return true
    } catch (error) {
      upstream.lastError = errorMessage(error); upstream.state = "backoff"; upstream.backoffUntil = Date.now() + halfOpenAfterMs; return false
    }
  }

  async function ensureReady() {
    if (chainId === null || chainId === undefined) return
    await Promise.all(upstreams.filter((item) => item.state === "probing" || item.reportedChainId === null).map(probe))
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
        error.status = response.status
        error.retryAfterMs = retryAfterMs(response, rateLimitBackoffMs[Math.min(upstream.rateLimitCount, rateLimitBackoffMs.length - 1)] || 30000)
        throw error
      }
      if (!payload) throw new Error("RPC returned non-JSON content")
      if (payload.error) throw rpcError(payload.error, upstream.url)
      record(upstream, { ok: true, latencyMs: Math.round(performance.now() - started) })
      return payload.result
    } catch (error) {
      if (!signal.aborted) {
        if (isRateLimitError(error)) {
          upstream.rateLimitCount += 1
          upstream.retryAfterMs = Number(error.retryAfterMs || rateLimitBackoffMs[Math.min(upstream.rateLimitCount - 1, rateLimitBackoffMs.length - 1)] || 30000)
          upstream.backoffUntil = Date.now() + upstream.retryAfterMs
          upstream.state = "backoff"
        }
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
    const candidates = availableUpstreams({ rank: !HEAVY_READ_METHODS.has(request.method), includeFallback: true })
    const errors = []
    for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
      const primary = candidates[attempt % candidates.length]
      const secondary = !HEAVY_READ_METHODS.has(request.method) && candidates.length > 1
        ? candidates[(attempt + 1) % candidates.length]
        : null
      const controllers = [new AbortController(), new AbortController()]
      try {
        if (attempt > 0) primary.httpFallbacks += 1
        const tasks = [call(primary, request, controllers[0].signal)]
        if (secondary && secondary !== primary) tasks.push(wait(hedgeDelayMs).then(() => {
          if (controllers[1].signal.aborted) throw new DOMException("Hedged request cancelled", "AbortError")
          secondary.httpFallbacks += 1
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
    await ensureReady()
    if (chainId !== null && chainId !== undefined && !upstreams.some((item) => item.state !== "mismatch" && item.circuitOpenUntil <= Date.now() && item.backoffUntil <= Date.now() && item.mismatchUntil <= Date.now())) {
      throw new Error(`All RPC upstreams are backing off for chain ${chainId}`)
    }
    if (!availableUpstreams({ rank: false }).length) throw new Error(`No verified RPC upstream for chain ${chainId}`)
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
    const active = activeEndpoint()
    return upstreams.map((item) => ({
      id: item.id,
      host: new URL(item.url).hostname,
      protocol: "http",
      active: active?.id === item.id,
      preferred: preferredUrl === item.url,
      state: item.mismatchUntil > timestamp ? "mismatch" : item.circuitOpenUntil > timestamp ? "open" : item.backoffUntil > timestamp ? "backoff" : item.state,
      latencyMs: item.latencyMs,
      lastLatencyMs: item.lastLatencyMs,
      requests: item.requests,
      successes: item.successes,
      wssHits: 0,
      httpFallbacks: item.httpFallbacks,
      rateLimitCount: item.rateLimitCount,
      lastError: item.lastError,
      retryAfterMs: Math.max(0, Math.max(item.circuitOpenUntil, item.backoffUntil, item.mismatchUntil) - timestamp),
      retryAfter: Math.max(0, Math.max(item.circuitOpenUntil, item.backoffUntil, item.mismatchUntil) - timestamp),
      reportedChainId: item.reportedChainId,
      failureRate: item.requests ? Number(((item.requests - item.successes) / item.requests).toFixed(4)) : 0,
      successRate: item.requests ? Number((item.successes / item.requests).toFixed(4)) : 0,
      fallback: item.httpFallbacks,
    }))
  }

  async function verifiedEndpoint() {
    await ensureReady()
    const upstream = availableUpstreams({ rank: false }).find((item) => chainId === null || chainId === undefined || item.reportedChainId === Number(chainId))
    if (!upstream) throw new Error(`No verified RPC write endpoint for chain ${chainId}`)
    return upstream.url
  }

  async function setPreferredEndpoint(id) {
    const key = String(id || "").trim()
    const upstream = upstreams.find((item) => item.id === key)
    if (!upstream) throw new Error(`Unknown RPC endpoint ${key || ""}`.trim())
    const verified = await probe(upstream)
    if (!verified) throw new Error(`RPC endpoint ${new URL(upstream.url).hostname} failed chain verification`)
    preferredUrl = upstream.url
    cache.clear()
    return upstream.id
  }

  function clearPreferredEndpoint() {
    preferredUrl = null
    cache.clear()
  }

  function preferredEndpoint() {
    return upstreams.find((item) => item.url === preferredUrl)?.id || null
  }

  function activeEndpoint() {
    return availableUpstreams({ rank: false })[0] || null
  }

  return { chainId, request, status, verifiedEndpoint, setPreferredEndpoint, clearPreferredEndpoint, preferredEndpoint, activeEndpoint }
}

export function createRpcManager({ chainId, urls, ...options } = {}) {
  const pool = createRpcPool({ chainId, urls, ...options })
  const lanes = new Map(["interactive", "monitor", "write"].map((name) => [name, { requests: 0, successes: 0, failures: 0 }]))
  async function request(lane, input) {
    const stats = lanes.get(lane) || lanes.get("interactive")
    stats.requests += 1
    try { const result = await pool.request(input); stats.successes += 1; return result }
    catch (error) { stats.failures += 1; throw error }
  }
  const channel = (name) => ({ request: (input) => request(name, input), status: () => ({ lane: name, ...lanes.get(name) }) })
  return {
    chainId: Number(chainId),
    pool,
    request: (input) => request("interactive", input),
    interactive: channel("interactive"),
    monitor: channel("monitor"),
    write: channel("write"),
    getVerifiedWriteEndpoint: () => pool.verifiedEndpoint(),
    setPreferredEndpoint: (id) => pool.setPreferredEndpoint(id),
    clearPreferredEndpoint: () => pool.clearPreferredEndpoint(),
    status() {
      const upstreams = pool.status()
      const active = upstreams.find((item) => item.active) || upstreams.find((item) => ["ready", "probing"].includes(item.state)) || upstreams[0]
      return {
        chainId: Number(chainId),
        activeHost: active?.host || null,
        activeId: active?.id || null,
        preferredId: pool.preferredEndpoint(),
        state: active?.state || "unconfigured",
        upstreams,
        lanes: Object.fromEntries([...lanes].map(([name, stats]) => [name, { lane: name, ...stats }])),
      }
    },
  }
}

export async function createViemWssClient({
  url,
  chain,
  events,
  mintFrom,
  createPublicClient,
  webSocketTransport,
  onEvent = () => {},
  onDisconnect = () => {},
  onError = () => {},
} = {}) {
  if (typeof createPublicClient !== "function") throw new TypeError("Viem WSS client requires createPublicClient")
  if (typeof webSocketTransport !== "function") throw new TypeError("Viem WSS client requires webSocketTransport")
  if (!Array.isArray(events) || !events.length) throw new TypeError("Viem WSS client requires event definitions")

  const transport = webSocketTransport(url, { retryCount: 0, keepAlive: true, reconnect: false })
  const client = createPublicClient({ chain, transport })
  const unwatch = []
  let rpcClient = null
  let socket = null
  let closed = false
  const reportError = (error) => {
    if (!closed) onError(error)
  }
  const reportDisconnect = (error) => {
    if (!closed) onDisconnect(error instanceof Error ? error : new Error("WSS socket closed"))
  }

  try {
    const connectedChainId = await client.getChainId()
    rpcClient = await client.transport?.getRpcClient?.()
    if (Number(connectedChainId) !== Number(chain?.id)) throw new Error(`WSS chain id mismatch: ${connectedChainId}`)
    socket = rpcClient?.socket || null
    socket?.addEventListener?.("close", reportDisconnect)
    unwatch.push(client.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (blockNumber) => {
        if (!closed) onEvent({ type: "head", blockNumber })
      },
      onError: reportError,
    }))
    for (const definition of events) {
      const descriptor = definition?.event ? definition : { event: definition, args: { from: mintFrom } }
      const watch = {
        event: descriptor.event,
        strict: true,
        onLogs: (logs) => {
          if (!closed) onEvent({
            type: "logs",
            ...(descriptor.scope ? { scope: descriptor.scope } : {}),
            logs,
          })
        },
        onError: reportError,
      }
      if (descriptor.address) watch.address = descriptor.address
      if (descriptor.args) watch.args = descriptor.args
      unwatch.push(client.watchEvent(watch))
    }
  } catch (error) {
    closed = true
    socket?.removeEventListener?.("close", reportDisconnect)
    for (const stop of unwatch.splice(0)) closeClient(stop)
    closeClient(rpcClient)
    throw error
  }

  return {
    close() {
      if (closed) return
      closed = true
      socket?.removeEventListener?.("close", reportDisconnect)
      for (const stop of unwatch.splice(0)) closeClient(stop)
      closeClient(rpcClient)
    },
  }
}

export function createWssFailoverManager({
  urls,
  createClient,
  onEvent = () => {},
  onStatus = () => {},
  reconnectDelayMs = 1000,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
} = {}) {
  const uniqueUrls = [...new Set((urls || []).map(String).map((value) => value.trim()).filter(Boolean))]
  if (!uniqueUrls.length) throw new Error("WSS failover manager requires at least one upstream")
  if (typeof createClient !== "function") throw new TypeError("WSS failover manager requires createClient")
  const upstreams = uniqueUrls.map((url) => ({
    url,
    state: "idle",
    attempts: 0,
    wssHits: 0,
    httpFallbacks: 0,
    rateLimitCount: 0,
    lastLatencyMs: null,
    lastError: "",
  }))
  let running = false
  let stopped = false
  let active = null
  let connecting = null
  let reconnectTimer = null
  let generation = 0
  let totalWssHits = 0
  let totalHttpFallbacks = 0
  let lastLatencyMs = null
  let lastError = ""

  function notify() {
    onStatus(status())
  }

  function recordFailure(upstream, error, latencyMs) {
    upstream.state = "failed"
    upstream.lastLatencyMs = latencyMs
    upstream.lastError = errorMessage(error)
    lastLatencyMs = latencyMs
    lastError = upstream.lastError
    if (isRateLimitError(error)) upstream.rateLimitCount += 1
  }

  function scheduleReconnect(startIndex) {
    if (!running || stopped || reconnectTimer) return
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null
      void connectFrom(startIndex)
    }, Math.max(0, reconnectDelayMs))
    reconnectTimer?.unref?.()
  }

  function disconnected(token, index, error) {
    if (!running || stopped || active?.token !== token) return
    const current = active
    active = null
    generation += 1
    try {
      closeClient(current.client)
    } catch {
      // The upstream already reported closure.
    }
    recordFailure(upstreams[index], error || new Error("WSS disconnected"), upstreams[index].lastLatencyMs)
    notify()
    void connectFrom((index + 1) % upstreams.length)
  }

  async function connectFrom(startIndex = 0) {
    if (!running || stopped) return false
    if (connecting) return connecting
    connecting = (async () => {
      for (let offset = 0; offset < upstreams.length; offset += 1) {
        if (!running || stopped) return false
        const index = (startIndex + offset) % upstreams.length
        const upstream = upstreams[index]
        const token = ++generation
        upstream.state = "connecting"
        upstream.attempts += 1
        upstream.lastError = ""
        const startedAt = performance.now()
        let setupError = null
        const handleConnectionError = (error) => {
          if (active?.token === token) {
            disconnected(token, index, error)
          } else if (running && !stopped && token === generation) {
            setupError = error || new Error("WSS disconnected during setup")
          }
        }
        notify()
        try {
          const client = await createClient({
            url: upstream.url,
            host: new URL(upstream.url).hostname,
            onEvent(value) {
              if (!running || stopped || active?.token !== token) return
              const hits = Array.isArray(value) ? value.length : 1
              upstream.wssHits += hits
              totalWssHits += hits
              onEvent(value, { host: new URL(upstream.url).hostname, index })
            },
            onDisconnect(error) {
              handleConnectionError(error)
            },
            onError(error) {
              handleConnectionError(error)
            },
          })
          if (!running || stopped || token !== generation) {
            closeClient(client)
            return false
          }
          if (setupError) {
            const latencyMs = Math.round(performance.now() - startedAt)
            closeClient(client)
            recordFailure(upstream, setupError, latencyMs)
            notify()
            continue
          }
          const latencyMs = Math.round(performance.now() - startedAt)
          upstream.state = "active"
          upstream.lastLatencyMs = latencyMs
          upstream.lastError = ""
          lastLatencyMs = latencyMs
          lastError = ""
          active = { client, index, token }
          notify()
          return true
        } catch (error) {
          recordFailure(upstream, error, Math.round(performance.now() - startedAt))
          notify()
        }
      }
      scheduleReconnect(startIndex)
      return false
    })().finally(() => {
      connecting = null
    })
    return connecting
  }

  function start() {
    if (running && !stopped) return connecting || Promise.resolve(Boolean(active))
    stopped = false
    running = true
    return connectFrom(active?.index || 0)
  }

  function recordHttpFallback(count = 1) {
    const increment = Math.max(0, Number(count) || 0)
    totalHttpFallbacks += increment
    if (active) upstreams[active.index].httpFallbacks += increment
    notify()
  }

  function status() {
    const rateLimitCount = upstreams.reduce((sum, upstream) => sum + upstream.rateLimitCount, 0)
    return {
      state: stopped ? "stopped" : active ? "active" : running ? "connecting" : "idle",
      activeHost: active ? new URL(upstreams[active.index].url).hostname : null,
      wssHits: totalWssHits,
      httpFallbacks: totalHttpFallbacks,
      rateLimitCount,
      lastLatencyMs,
      lastError,
      upstreams: upstreams.map((upstream) => ({
        host: new URL(upstream.url).hostname,
        protocol: "wss",
        state: upstream.state,
        attempts: upstream.attempts,
        wssHits: upstream.wssHits,
        httpFallbacks: upstream.httpFallbacks,
        rateLimitCount: upstream.rateLimitCount,
        lastLatencyMs: upstream.lastLatencyMs,
        lastError: upstream.lastError,
      })),
    }
  }

  function stop() {
    if (stopped) return
    stopped = true
    running = false
    generation += 1
    if (reconnectTimer) cancelTimeout(reconnectTimer)
    reconnectTimer = null
    const current = active
    active = null
    if (current) closeClient(current.client)
    for (const upstream of upstreams) if (["active", "connecting"].includes(upstream.state)) upstream.state = "stopped"
    notify()
  }

  return { recordHttpFallback, start, status, stop }
}
