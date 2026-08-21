import { createRealtimeState, reduceRealtimeState, replaceRealtimeOverview } from "./mint-monitor-data.js"

export const MONITOR_STORE_STATES = Object.freeze(["cold", "cached", "synchronizing", "live", "degraded"])
export const MAX_PENDING_MESSAGES = 500
export const MAX_SEEN_CURSORS = 2000

function cursorParts(value) {
  const match = /^(\d+)-(\d+)$/.exec(String(value || ""))
  return match ? { chainId: Number(match[1]), sequence: Number(match[2]) } : null
}

function cursorOrder(left, right) {
  const a = cursorParts(left); const b = cursorParts(right)
  if (!a || !b) return 0
  return a.sequence - b.sequence
}

export function createMonitorStore({ chainId, overviewWindow = 1800, limit = 250, maxPending = MAX_PENDING_MESSAGES, maxSeenCursors = MAX_SEEN_CURSORS, now = Date.now } = {}) {
  const id = Number(chainId)
  const windowSeconds = Number(overviewWindow)
  const state = {
    chainId: id,
    overviewWindow: windowSeconds,
    status: "cold",
    data: null,
    realtime: createRealtimeState(),
    cursor: null,
    snapshotCursor: null,
    snapshotVersion: 0,
    pending: [],
    synchronizing: false,
    seenCursors: new Set(),
    seenCursorOrder: [],
    maxPending: Math.max(1, Number(maxPending) || MAX_PENDING_MESSAGES),
    maxSeenCursors: Math.max(1, Number(maxSeenCursors) || MAX_SEEN_CURSORS),
    pendingDropped: 0,
    lastMessageAt: null,
    updatedAt: now(),
  }
  const listeners = new Set()
  let syncing = false

  function notify(reason) {
    state.updatedAt = now()
    for (const listener of listeners) listener({ ...state, reason, pending: state.pending.slice() })
  }
  function setStatus(status, reason = "state") {
    if (!MONITOR_STORE_STATES.includes(status)) throw new Error(`Unknown monitor store state: ${status}`)
    state.status = status; notify(reason)
  }
  function beginSynchronizing(reason = "bootstrap") { syncing = true; state.synchronizing = true; setStatus("synchronizing", reason) }
  function applyValue(value, cursor = null) {
    if (!value || typeof value !== "object") return false
    if (cursor && state.seenCursors.has(String(cursor))) return false
    if (cursor) {
      const parsed = cursorParts(cursor)
      if (parsed && parsed.chainId !== id) return false
      if (state.cursor && cursorOrder(cursor, state.cursor) <= 0) return false
      const normalizedCursor = String(cursor)
      state.seenCursors.add(normalizedCursor)
      state.seenCursorOrder.push(normalizedCursor)
      while (state.seenCursorOrder.length > state.maxSeenCursors) state.seenCursors.delete(state.seenCursorOrder.shift())
      state.cursor = normalizedCursor
    }
    state.realtime = reduceRealtimeState(state.realtime, value, { limit })
    state.lastMessageAt = now()
    return true
  }
  function flushPending() {
    const queue = state.pending.splice(0).sort((a, b) => cursorOrder(a.cursor, b.cursor))
    for (const message of queue) applyValue(message.value, message.cursor)
  }
  function applySnapshot(snapshot, { cursor = null, snapshotVersion = 1 } = {}) {
    const overview = snapshot?.overview || snapshot?.data || snapshot || {}
    state.data = overview
    state.realtime = replaceRealtimeOverview(state.realtime, overview.events || [], { limit })
    state.snapshotCursor = cursor || snapshot?.realtimeCursor || null
    state.snapshotVersion = Number(snapshotVersion || snapshot?.snapshotVersion || 1)
    if (state.snapshotCursor) state.cursor = String(state.snapshotCursor)
    syncing = false
    state.synchronizing = false
    flushPending()
    state.status = state.data ? "live" : "degraded"
    notify("snapshot")
    return state
  }
  function receive(messageOrValue, cursor = null) {
    const message = messageOrValue?.value ? messageOrValue : { value: messageOrValue, cursor }
    const value = message.value
    if (value?.type === "replay_reset") {
      state.pending = []; state.seenCursors.clear(); state.seenCursorOrder = []; state.pendingDropped = 0; state.realtime = reduceRealtimeState(state.realtime, value, { limit }); syncing = true; state.status = "synchronizing"; notify("replay_reset"); return false
    }
    if (syncing) {
      state.pending.push({ cursor: message.cursor ? String(message.cursor) : null, value })
      if (state.pending.length > state.maxPending) {
        state.pending.splice(0, state.pending.length - state.maxPending)
        state.pendingDropped += 1
      }
      notify("queued")
      return true
    }
    const changed = applyValue(value, message.cursor || cursor)
    if (changed) notify("event")
    return changed
  }
  function markCached(snapshot) { state.data = snapshot?.overview || snapshot?.data || snapshot; state.realtime = replaceRealtimeOverview(state.realtime, state.data?.events || [], { limit }); state.cursor = snapshot?.cursor || snapshot?.realtimeCursor || null; state.status = "cached"; notify("cache") }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  function reset(reason = "reset") { state.pending = []; state.seenCursors.clear(); state.seenCursorOrder = []; state.pendingDropped = 0; state.cursor = null; state.snapshotCursor = null; state.data = null; state.realtime = createRealtimeState(); syncing = false; state.synchronizing = false; setStatus("cold", reason) }
  return { applySnapshot, beginSynchronizing, getState: () => ({ ...state, pending: state.pending.slice() }), markCached, receive, reset, setStatus, subscribe }
}

export function createMonitorStoreRegistry(options = {}) {
  const stores = new Map()
  function key(chainId, overviewWindow) { return `${Number(chainId)}:${Number(overviewWindow)}` }
  function get(chainId, overviewWindow = 1800) {
    const storeKey = key(chainId, overviewWindow)
    if (!stores.has(storeKey)) stores.set(storeKey, createMonitorStore({ ...options, chainId, overviewWindow }))
    return stores.get(storeKey)
  }
  function dispose(chainId = null) {
    for (const [storeKey, store] of stores) if (chainId === null || storeKey.startsWith(`${Number(chainId)}:`)) { store.reset("dispose"); stores.delete(storeKey) }
  }
  return { dispose, get, has: (chainId, window) => stores.has(key(chainId, window)), keys: () => [...stores.keys()] }
}

export { cursorOrder, cursorParts }
