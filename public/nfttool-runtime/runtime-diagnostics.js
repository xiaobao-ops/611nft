const DEFAULT_LIMIT = 200
const SENSITIVE_KEY = /(private|secret|password|token|signature|signed|calldata|credential|authorization|cookie|wallet|confirm|task|request.?body|rpc.?url|mnemonic|seed)/i
const URL_VALUE = /^(?:https?|wss?):\/\//i

function safeValue(value, key = "", depth = 0) {
  if (depth > 5) return "[truncated]"
  if (SENSITIVE_KEY.test(key)) return "[redacted]"
  if (typeof value === "string") {
    if (URL_VALUE.test(value) && /(rpc|provider|alchemy|infura|quicknode|endpoint)/i.test(value)) {
      try { return new URL(value).hostname } catch { return "[redacted-url]" }
    }
    return value.length > 1000 ? `${value.slice(0, 997)}...` : value
  }
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, key, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([entryKey, entryValue]) => [entryKey, safeValue(entryValue, entryKey, depth + 1)]))
}

export function sanitizeDiagnostic(value) {
  return safeValue(value)
}

export function createRuntimeDiagnostics({ limit = DEFAULT_LIMIT, now = Date.now } = {}) {
  const maxEntries = Math.max(1, Number(limit) || DEFAULT_LIMIT)
  const entries = []
  let sequence = 0

  function record(category, message, details = undefined) {
    const entry = {
      id: ++sequence,
      at: new Date(now()).toISOString(),
      category: String(category || "runtime"),
      message: String(message || ""),
    }
    if (details !== undefined) entry.details = sanitizeDiagnostic(details)
    entries.push(entry)
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
    return entry
  }

  function list() { return entries.map((entry) => ({ ...entry })) }
  function clear() { entries.splice(0) }
  function exportPayload(extra = {}) {
    return {
      version: 1,
      exportedAt: new Date(now()).toISOString(),
      ...sanitizeDiagnostic(extra),
      entries: list(),
    }
  }
  function exportJson(extra = {}) { return JSON.stringify(exportPayload(extra), null, 2) }

  return { clear, entries: list, exportJson, exportPayload, list, record, size: () => entries.length }
}

export const runtimeDiagnostics = createRuntimeDiagnostics()
