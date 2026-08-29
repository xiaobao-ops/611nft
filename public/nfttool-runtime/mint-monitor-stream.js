const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000])
const WATCHDOG_MS = 45_000

export function createMonitorStreamCoordinator({
  chainId,
  getCursor = () => null,
  onMessage = () => {},
  onState = () => {},
  onNeedSynchronize = () => {},
  EventSourceClass = globalThis.EventSource,
  backoffMs = DEFAULT_BACKOFF_MS,
  watchdogMs = WATCHDOG_MS,
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  urlFor = (id, cursor) => `/api/mint-monitor/stream?chainId=${Number(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
} = {}) {
  let source = null
  let reconnectTimer = null
  let watchdogTimer = null
  let stopped = true
  let attempt = 0
  let reconnects = 0
  let lastMessageAt = null
  let lastEventId = getCursor() || null
  let state = "offline"

  function notify(next, extra = {}) { state = next; onState({ state, reconnects, attempt, lastEventId, lastMessageAt, ...extra }) }
  function clearTimers() {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    if (watchdogTimer !== null) clearInterval(watchdogTimer)
    reconnectTimer = null; watchdogTimer = null
  }
  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return
    const delay = Number(backoffMs[Math.min(attempt, backoffMs.length - 1)] || backoffMs.at(-1) || 15000)
    attempt += 1; reconnects += 1
    notify("degraded", { retryInMs: delay })
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
    reconnectTimer?.unref?.()
  }
  function closeSource() {
    if (!source) return
    source.onopen = null; source.onerror = null; source.onmessage = null
    source.close?.(); source = null
  }
  function watchdog() {
    if (stopped || !source || lastMessageAt === null) return
    if (now() - lastMessageAt >= watchdogMs) { closeSource(); scheduleReconnect() }
  }
  function connect() {
    if (stopped || typeof EventSourceClass !== "function") { notify("degraded", { reason: "eventsource_unavailable" }); return null }
    closeSource(); clearTimers()
    const cursor = lastEventId || getCursor() || null
    try { source = new EventSourceClass(urlFor(chainId, cursor)) }
    catch (error) { notify("degraded", { reason: "connect_failed", error: error.message }); scheduleReconnect(); return null }
    notify("connecting")
    source.onopen = () => { attempt = 0; lastMessageAt = now(); notify("live") }
    source.onerror = () => { if (!stopped) { closeSource(); scheduleReconnect() } }
    source.onmessage = (message) => {
      if (stopped) return
      lastMessageAt = now()
      const messageCursor = message?.lastEventId ? String(message.lastEventId) : null
      if (messageCursor) lastEventId = messageCursor
      let value
      try { value = JSON.parse(message?.data || "null") } catch (error) { onState({ state, parseError: error.message }); return }
      if (value?.type === "replay_reset") { onNeedSynchronize(value); return }
      onMessage({ cursor: messageCursor, value, message })
      notify(state)
    }
    watchdogTimer = setInterval(watchdog, Math.max(1000, Math.min(watchdogMs, 5000)))
    watchdogTimer?.unref?.()
    return source
  }
  function start() { if (!stopped) return source; stopped = false; return connect() }
  function stop() { stopped = true; clearTimers(); closeSource(); notify("offline") }
  function reconnect() { if (stopped) return; closeSource(); clearTimers(); scheduleReconnect() }
  function setCursor(cursor) { lastEventId = cursor ? String(cursor) : null }
  function status() { return { state, reconnects, attempt, lastEventId, lastMessageAt, stopped } }
  return { connect, reconnect, setCursor, start, status, stop }
}

export { DEFAULT_BACKOFF_MS, WATCHDOG_MS }
