import { mergeSnapshotIntoEvent } from "./collection-snapshot.js"

const DEFAULT_LIMIT = 100
const RATE_SAMPLE_LIMIT = 60

export function createRealtimeFeedState() {
  return {
    events: [],
    mintRate: null,
    rateSamples: [],
    latencyMs: null,
    source: "",
    replayResetVersion: 0,
  }
}

export function realtimeEventKey(event) {
  return String(event?.batchId || event?.id || `${event?.txHash || ""}:${event?.address || ""}`)
}

function eventTimestamp(event) {
  return Number(event?.lastTimestamp ?? event?.timestamp ?? 0)
}

function capped(events, limit = DEFAULT_LIMIT) {
  return events.slice(0, limit)
}

function uniqueIds(values) {
  return [...new Set((values || []).map(String).filter(Boolean))]
}

function normalizeRateSample(sample) {
  const value = typeof sample === "object" && sample !== null
    ? sample.mintRate ?? sample.rate ?? sample.value ?? sample.count
    : sample
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function heartbeatState(state, value) {
  const rate = normalizeRateSample(value.mintRate)
  const incomingSamples = Array.isArray(value.rateSamples) ? value.rateSamples : value.mintRateSamples
  const provided = Array.isArray(incomingSamples)
    ? incomingSamples.map(normalizeRateSample).filter((sample) => sample !== null)
    : []
  const rateSamples = provided.length
    ? provided.slice(-RATE_SAMPLE_LIMIT)
    : rate === null
      ? state.rateSamples
      : [...state.rateSamples, rate].slice(-RATE_SAMPLE_LIMIT)
  const rawLatency = value.latencyMs ?? value.monitorStatus?.latencyMs
  const latency = rawLatency === null || rawLatency === undefined || rawLatency === "" ? null : Number(rawLatency)
  return {
    ...state,
    mintRate: rate ?? state.mintRate,
    rateSamples,
    latencyMs: latency !== null && Number.isFinite(latency) && latency >= 0 ? latency : state.latencyMs,
    source: String(value.source || value.monitorStatus?.source || state.source || ""),
  }
}

function upsertMint(events, value, limit) {
  const existingBatch = events.find((event) => event.eventIds?.includes(value.id))
  if (existingBatch) {
    if (existingBatch.latestEventId !== value.id) return events
    return events.map((event) => event === existingBatch ? { ...event, ...value, id: event.id, latestEventId: event.latestEventId, batchId: event.batchId, eventIds: event.eventIds, count: event.count, tokenIdRange: event.tokenIdRange, firstTimestamp: event.firstTimestamp, lastTimestamp: event.lastTimestamp } : event)
  }
  const key = realtimeEventKey(value)
  return capped([value, ...events.filter((event) => realtimeEventKey(event) !== key)], limit)
}

function applyBatch(events, value, limit) {
  const batchId = String(value.batchId || value.id || "")
  const eventIds = uniqueIds(value.eventIds)
  const batch = { ...value, id: batchId, latestEventId: value.latestEventId || eventIds.at(-1) || value.id, batchId, eventIds }
  const members = new Set(eventIds)
  return capped([
    batch,
    ...events.filter((event) => {
      if (realtimeEventKey(event) === batchId || members.has(String(event.id || ""))) return false
      return !(event.eventIds || []).some((id) => members.has(String(id)))
    }),
  ], limit)
}

function applyUpdate(events, value) {
  return events.map((event) => event.id === value.id || event.latestEventId === value.id
    ? { ...event, ...value, id: event.id, latestEventId: event.latestEventId, batchId: event.batchId, eventIds: event.eventIds, count: event.count, tokenIdRange: event.tokenIdRange, firstTimestamp: event.firstTimestamp, lastTimestamp: event.lastTimestamp }
    : event)
}

function applyPatch(events, value) {
  const address = String(value.address || "").toLowerCase()
  return events.map((event) => String(event.address || "").toLowerCase() === address
    ? mergeSnapshotIntoEvent(event, value.collection_snapshot)
    : event)
}

function applyDiscard(events, value) {
  const ids = new Set(uniqueIds(value.eventIds))
  const batchId = String(value.batchId || "")
  return events.filter((event) => {
    if (batchId && realtimeEventKey(event) === batchId) return false
    if (ids.has(String(event.id || ""))) return false
    return !(event.eventIds || []).some((id) => ids.has(String(id)))
  })
}

export function reduceRealtimeFeed(state, value, { limit = DEFAULT_LIMIT } = {}) {
  const current = state || createRealtimeFeedState()
  if (!value || typeof value !== "object") return current
  if (value.type === "heartbeat") return heartbeatState(current, value)
  if (value.type === "replay_reset") return { ...current, events: [], replayResetVersion: current.replayResetVersion + 1 }
  if (value.type === "mint") return { ...current, events: upsertMint(current.events, value, limit) }
  if (value.type === "mint_batch") return { ...current, events: applyBatch(current.events, value, limit) }
  if (value.type === "mint_update") return { ...current, events: applyUpdate(current.events, value) }
  if (["collection_patch", "collection_update"].includes(value.type)) return { ...current, events: applyPatch(current.events, value) }
  if (value.type === "discard") return { ...current, events: applyDiscard(current.events, value) }
  return current
}

export function replaceRealtimeOverview(state, overviewEvents, { limit = DEFAULT_LIMIT } = {}) {
  const current = state || createRealtimeFeedState()
  const currentBatchMembers = new Set(current.events.flatMap((event) => event.eventIds || []).map(String))
  const byKey = new Map()
  for (const event of overviewEvents || []) {
    if (!event || currentBatchMembers.has(String(event.id || ""))) continue
    byKey.set(realtimeEventKey(event), event)
  }
  for (const event of current.events) {
    const key = realtimeEventKey(event)
    const snapshot = byKey.get(key)
    if (!snapshot) byKey.set(key, event)
    else if (eventTimestamp(event) > eventTimestamp(snapshot)) byKey.set(key, { ...snapshot, ...event })
    else byKey.set(key, { ...event, ...snapshot })
  }
  const events = [...byKey.values()].sort((left, right) => eventTimestamp(right) - eventTimestamp(left))
  return { ...current, events: capped(events, limit) }
}
