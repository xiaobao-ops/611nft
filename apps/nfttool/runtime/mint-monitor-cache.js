export const MONITOR_CACHE_VERSION = 1
export const MONITOR_CACHE_TTL_MS = 10 * 60 * 1000
const DB_NAME = "nfttool-monitor"
const STORE_NAME = "monitorSnapshots"
const SHELL_PREFIX = "nfttool:monitor-shell:v1:"

function cacheKey(chainId, overviewWindow) { return `v${MONITOR_CACHE_VERSION}:${Number(chainId)}:${Number(overviewWindow)}` }
function shellKey(chainId, overviewWindow) { return `${SHELL_PREFIX}${Number(chainId)}:${Number(overviewWindow)}` }
function timestamp(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }

function publicValue(value, key = "", depth = 0) {
  if (depth > 8) return undefined
  const blocked = /(private|secret|password|token|signature|signed|calldata|credential|authorization|cookie|wallet|confirm|task|rpc.?url|mnemonic|seed|auth.?header|request.?body)/i
  if (blocked.test(key)) return undefined
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && /^(?:https?|wss?):\/\//i.test(value) && /(rpc|provider|endpoint)/i.test(value)) return undefined
    return value
  }
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => publicValue(item, key, depth + 1)).filter((item) => item !== undefined)
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, publicValue(entryValue, entryKey, depth + 1)]).filter(([, entryValue]) => entryValue !== undefined))
}

function isValid(entry, chainId, overviewWindow, now, ttlMs) {
  return Boolean(entry && Number(entry.version) === MONITOR_CACHE_VERSION
    && Number(entry.chainId) === Number(chainId)
    && Number(entry.overviewWindow) === Number(overviewWindow)
    && timestamp(entry.savedAt) > 0
    && now - timestamp(entry.savedAt) <= ttlMs)
}

function idleSchedule(callback, { requestIdleCallback, setTimeout }) {
  if (typeof requestIdleCallback === "function") return requestIdleCallback(callback, { timeout: 1000 })
  return setTimeout(callback, 0)
}

function idleCancel(handle, { cancelIdleCallback, clearTimeout }) {
  if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle)
  else clearTimeout(handle)
}

export function createMonitorCache({
  storage = globalThis.localStorage,
  indexedDB = globalThis.indexedDB,
  now = Date.now,
  ttlMs = MONITOR_CACHE_TTL_MS,
  diagnostics = null,
  requestIdleCallback = globalThis.requestIdleCallback,
  cancelIdleCallback = globalThis.cancelIdleCallback,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
} = {}) {
  let dbPromise = null
  const pendingIdle = new Map()
  const report = (message, details) => diagnostics?.record?.("cache", message, details)

  function openDb() {
    if (!indexedDB?.open) return Promise.resolve(null)
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, MONITOR_CACHE_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" })
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => { report("indexeddb_open_failed", request.error?.message); resolve(null) }
      } catch (error) { report("indexeddb_open_failed", error.message); resolve(null) }
    })
    return dbPromise
  }

  async function idbRead(key) {
    const db = await openDb(); if (!db) return null
    return new Promise((resolve) => {
      try {
        const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)
        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => { report("indexeddb_read_failed", request.error?.message); resolve(null) }
      } catch (error) { report("indexeddb_read_failed", error.message); resolve(null) }
    })
  }

  async function idbWrite(entry) {
    const db = await openDb(); if (!db) return false
    return new Promise((resolve) => {
      try {
        const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(entry)
        request.onsuccess = () => resolve(true)
        request.onerror = () => { report("indexeddb_write_failed", request.error?.message); resolve(false) }
      } catch (error) { report("indexeddb_write_failed", error.message); resolve(false) }
    })
  }

  async function idbDelete(key) {
    const db = await openDb(); if (!db) return
    try { db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key) }
    catch (error) { report("indexeddb_delete_failed", error.message) }
  }

  function readShell(chainId, overviewWindow) {
    const key = shellKey(chainId, overviewWindow)
    try {
      const value = JSON.parse(storage?.getItem(key) || "null")
      if (!isValid(value, chainId, overviewWindow, now(), ttlMs)) {
        storage?.removeItem(key)
        return null
      }
      return value
    } catch (error) { report("shell_read_failed", error.message); try { storage?.removeItem(key) } catch {} ; return null }
  }

  function writeShell(chainId, overviewWindow, value) {
    const entry = publicValue({
      version: MONITOR_CACHE_VERSION,
      savedAt: now(),
      chainId: Number(chainId),
      overviewWindow: Number(overviewWindow),
      cursor: value?.cursor || null,
      metrics: value?.metrics || value?.overview?.chainMetrics || null,
      events: (value?.events || value?.overview?.events || []).slice(0, 24),
    })
    try { storage?.setItem(shellKey(chainId, overviewWindow), JSON.stringify(entry)); return entry }
    catch (error) { report("shell_write_failed", error.message); return null }
  }

  async function load(chainId, overviewWindow) {
    const shell = readShell(chainId, overviewWindow)
    const key = cacheKey(chainId, overviewWindow)
    const stored = await idbRead(key)
    if (stored && !isValid(stored, chainId, overviewWindow, now(), ttlMs)) { await idbDelete(key); report("expired", { chainId, overviewWindow }) }
    const entry = stored && isValid(stored, chainId, overviewWindow, now(), ttlMs) ? stored : null
    return entry ? { ...entry, shell } : shell ? { ...shell, partial: true } : null
  }

  function save(chainId, overviewWindow, value, { immediate = false } = {}) {
    const key = cacheKey(chainId, overviewWindow)
    const entry = publicValue({
      version: MONITOR_CACHE_VERSION,
      savedAt: now(),
      key,
      chainId: Number(chainId),
      overviewWindow: Number(overviewWindow),
      cursor: value?.cursor || value?.realtimeCursor || null,
      overview: value?.overview || value?.data || null,
      events: value?.events || value?.realtime?.events || [],
      trending: value?.trending || null,
      radar: value?.radar || null,
      flags: value?.flags || [],
      status: value?.status || null,
    })
    writeShell(chainId, overviewWindow, entry)
    const run = () => { pendingIdle.delete(key); void idbWrite(entry) }
    const previous = pendingIdle.get(key)
    if (previous !== undefined) idleCancel(previous, { cancelIdleCallback, clearTimeout })
    pendingIdle.set(key, immediate ? setTimeout(run, 0) : idleSchedule(run, { requestIdleCallback, setTimeout }))
    return entry
  }

  async function clear(chainId, overviewWindow) {
    const key = cacheKey(chainId, overviewWindow)
    const pending = pendingIdle.get(key)
    if (pending !== undefined) idleCancel(pending, { cancelIdleCallback, clearTimeout })
    pendingIdle.delete(key)
    try { storage?.removeItem(shellKey(chainId, overviewWindow)) } catch (error) { report("shell_delete_failed", error.message) }
    await idbDelete(key)
  }

  async function clearAll() {
    try {
      for (let index = storage?.length - 1; index >= 0; index -= 1) {
        const key = storage?.key(index)
        if (key?.startsWith(SHELL_PREFIX)) storage.removeItem(key)
      }
    } catch (error) { report("shell_clear_failed", error.message) }
    const db = await openDb(); if (!db) return
    try { db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear() }
    catch (error) { report("indexeddb_clear_failed", error.message) }
  }

  return { cacheKey, clear, clearAll, load, readShell, save, shellKey, writeShell }
}

export { cacheKey as monitorCacheKey, publicValue as sanitizeMonitorCacheValue }
