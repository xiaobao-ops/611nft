function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function eventQuantity(value) {
  try {
    const quantity = BigInt(value ?? 0)
    return quantity >= 0n ? quantity : 0n
  } catch {
    return 0n
  }
}

function jsonCount(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
}

function numericTokenRange(events) {
  const values = []
  for (const event of events) {
    for (const tokenId of event.tokenIds || []) {
      try {
        values.push(BigInt(tokenId))
      } catch {
        // Token ids from malformed upstream data are omitted from the numeric range.
      }
    }
  }
  if (!values.length) return null
  let start = values[0]
  let end = values[0]
  for (const value of values.slice(1)) {
    if (value < start) start = value
    if (value > end) end = value
  }
  return { start: start.toString(), end: end.toString() }
}

function cursorFor(chainId, sequence) {
  return `${Number(chainId)}-${sequence}`
}

export function parseStreamCursor(value) {
  const match = /^(\d+)-(\d+)$/.exec(String(value || "").trim())
  if (!match) return null
  const chainId = Number(match[1])
  const sequence = Number(match[2])
  if (!Number.isSafeInteger(chainId) || !Number.isSafeInteger(sequence)) return null
  return { chainId, sequence }
}

export function formatSseMessage(message) {
  const id = message?.cursor ? `id: ${message.cursor}\n` : ""
  return `${id}data: ${JSON.stringify(message?.value ?? null)}\n\n`
}

export function createRealtimeStream({
  bufferSize = 500,
  batchMs = 2000,
  heartbeatMs = 1000,
  rateWindowSeconds = 60,
  now = Date.now,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  setInterval: scheduleInterval = globalThis.setInterval,
  clearInterval: cancelInterval = globalThis.clearInterval,
  getHealth = () => ({}),
} = {}) {
  const chains = new Map()
  const replayLimit = positiveInteger(bufferSize, 500)
  const windowSeconds = positiveInteger(rateWindowSeconds, 60)
  let stopped = false

  function stateFor(chainId) {
    const id = Number(chainId)
    if (!chains.has(id)) {
      const state = {
        chainId: id,
        sequence: 0,
        buffer: [],
        subscribers: new Set(),
        batches: new Map(),
        batchSequence: 0,
        rateBuckets: new Map(),
        seenMintIds: new Map(),
        latestStatus: null,
        heartbeatTimer: null,
      }
      if (heartbeatMs > 0) {
        state.heartbeatTimer = scheduleInterval(() => heartbeat(id), Math.max(100, heartbeatMs))
        state.heartbeatTimer?.unref?.()
      }
      chains.set(id, state)
    }
    return chains.get(id)
  }

  function deliver(subscriber, message) {
    if (subscriber.replaying) subscriber.pending.push(message)
    else subscriber.listener(message)
  }

  function broadcast(state, message) {
    for (const subscriber of state.subscribers) deliver(subscriber, message)
  }

  function emit(chainId, value) {
    if (stopped) return null
    const state = stateFor(chainId)
    state.sequence += 1
    const message = {
      cursor: cursorFor(state.chainId, state.sequence),
      value,
      replayed: false,
    }
    state.buffer.push(message)
    if (state.buffer.length > replayLimit) state.buffer.splice(0, state.buffer.length - replayLimit)
    broadcast(state, message)
    return message
  }

  function transient(chainId, value, cursor = null) {
    if (stopped) return null
    const state = stateFor(chainId)
    const message = { cursor, value, replayed: false }
    broadcast(state, message)
    return message
  }

  function resetMessage(state, lastEventId, reason) {
    const latestCursor = state.sequence ? cursorFor(state.chainId, state.sequence) : null
    return {
      cursor: latestCursor,
      replayed: false,
      value: {
        type: "replay_reset",
        chainId: state.chainId,
        lastEventId: String(lastEventId || ""),
        latestCursor,
        reason,
      },
    }
  }

  function subscribe(chainId, lastEventId, listener) {
    if (typeof lastEventId === "function") {
      listener = lastEventId
      lastEventId = ""
    }
    if (typeof listener !== "function") throw new TypeError("Realtime stream subscriber must be a function")
    const state = stateFor(chainId)
    const subscriber = { listener, pending: [], replaying: true }
    state.subscribers.add(subscriber)

    if (lastEventId) {
      const parsed = parseStreamCursor(lastEventId)
      if (!parsed || parsed.chainId !== state.chainId) {
        listener(resetMessage(state, lastEventId, parsed ? "chain_mismatch" : "invalid_cursor"))
      } else if (parsed.sequence === state.sequence) {
        // The client already has the latest replayable event.
      } else {
        const index = state.buffer.findIndex((message) => message.cursor === String(lastEventId))
        if (index < 0 || parsed.sequence > state.sequence) {
          listener(resetMessage(state, lastEventId, "cursor_outside_buffer"))
        } else {
          for (const message of state.buffer.slice(index + 1)) listener({ ...message, replayed: true })
        }
      }
    }

    subscriber.replaying = false
    for (const message of subscriber.pending.splice(0)) listener(message)
    return () => state.subscribers.delete(subscriber)
  }

  function addRateSample(state, quantity) {
    const second = Math.floor(now() / 1000)
    state.rateBuckets.set(second, (state.rateBuckets.get(second) || 0n) + quantity)
    const oldest = second - windowSeconds + 1
    for (const key of state.rateBuckets.keys()) if (key < oldest) state.rateBuckets.delete(key)
  }

  function batchKey(event) {
    return String(event.address || "").toLowerCase()
  }

  function flushBatch(chainId, key) {
    const state = stateFor(chainId)
    const batch = state.batches.get(key)
    if (!batch) return null
    state.batches.delete(key)
    if (batch.timer) cancelTimeout(batch.timer)
    if (!batch.events.length) return null
    const first = batch.events[0]
    const last = batch.events.at(-1)
    const count = batch.events.reduce((sum, event) => sum + eventQuantity(event.quantity), 0n)
    const eventIds = batch.events.map((event) => event.id).filter(Boolean)
    const batchId = `${state.chainId}:${key || "unknown"}:${batch.number}`
    const value = {
      ...first,
      id: batchId,
      type: "mint_batch",
      batchId,
      eventIds,
      count: jsonCount(count),
      tokenIdRange: numericTokenRange(batch.events),
      firstTimestamp: first.timestamp ?? null,
      lastTimestamp: last.timestamp ?? first.timestamp ?? null,
    }
    return emit(state.chainId, value)
  }

  function queueMint(chainId, event) {
    const state = stateFor(chainId)
    if (event.id && state.seenMintIds.has(event.id)) return
    if (event.id) {
      state.seenMintIds.set(event.id, now())
      if (state.seenMintIds.size > 5000) {
        const cutoff = now() - 5 * 60 * 1000
        for (const [eventId, seenAt] of state.seenMintIds) {
          if (seenAt < cutoff || state.seenMintIds.size > 5000) state.seenMintIds.delete(eventId)
          if (state.seenMintIds.size <= 5000 && seenAt >= cutoff) break
        }
      }
    }
    const key = batchKey(event)
    addRateSample(state, eventQuantity(event.quantity))
    let batch = state.batches.get(key)
    if (!batch) {
      batch = { number: ++state.batchSequence, events: [], timer: null }
      batch.timer = scheduleTimeout(() => flushBatch(state.chainId, key), Math.max(0, batchMs))
      batch.timer?.unref?.()
      state.batches.set(key, batch)
    }
    if (!event.id || !batch.events.some((candidate) => candidate.id === event.id)) batch.events.push(event)
  }

  function prunePendingBatches(state, eventIds) {
    const removed = new Set(eventIds)
    for (const eventId of removed) state.seenMintIds.delete(eventId)
    for (const [key, batch] of state.batches) {
      batch.events = batch.events.filter((event) => !removed.has(event.id))
      if (!batch.events.length) {
        if (batch.timer) cancelTimeout(batch.timer)
        state.batches.delete(key)
      }
    }
  }

  function accept(chainId, value) {
    if (!value || stopped) return null
    const id = Number(chainId ?? value.chainId)
    if (value.type === "mint") {
      queueMint(id, value)
      return null
    }
    if (value.type === "collection_update") {
      return emit(id, { ...value, type: "collection_patch", chainId: id })
    }
    if (value.type === "discard") {
      const eventIds = [...new Set(value.eventIds || value.ids || [])]
      const state = stateFor(id)
      prunePendingBatches(state, eventIds)
      return emit(id, { ...value, type: "discard", chainId: id, eventIds })
    }
    if (value.type === "monitor_status") {
      stateFor(id).latestStatus = value
      return null
    }
    if (["collection_patch", "mint_batch"].includes(value.type)) return emit(id, { ...value, chainId: id })
    if (["heartbeat", "replay_reset"].includes(value.type)) return transient(id, { ...value, chainId: id })
    return null
  }

  function heartbeat(chainId) {
    const state = stateFor(chainId)
    const currentSecond = Math.floor(now() / 1000)
    const firstSecond = currentSecond - windowSeconds + 1
    const mintRateSamples = Array.from({ length: windowSeconds }, (_, index) => {
      const timestamp = firstSecond + index
      return { timestamp, count: jsonCount(state.rateBuckets.get(timestamp) || 0n) }
    })
    const total = mintRateSamples.reduce((sum, sample) => sum + BigInt(sample.count), 0n)
    let health = {}
    try {
      health = getHealth(state.chainId, state.latestStatus) || {}
    } catch {
      // Transport health is supplementary; rate heartbeats must keep flowing.
    }
    const source = String(health.source || state.latestStatus?.source || "")
    const rawLatency = health.latencyMs ?? state.latestStatus?.latencyMs
    const latency = rawLatency === null || rawLatency === undefined || rawLatency === "" ? null : Number(rawLatency)
    const value = {
      type: "heartbeat",
      chainId: state.chainId,
      timestamp: Math.floor(now() / 1000),
      mintRate: Number((Number(total) / windowSeconds).toFixed(4)),
      mintRateSamples,
      windowMintCount: jsonCount(total),
      source,
      latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
      monitorStatus: state.latestStatus,
    }
    transient(state.chainId, value)
    return value
  }

  function flush(chainId = null) {
    const targets = chainId === null ? [...chains.values()] : [stateFor(chainId)]
    for (const state of targets) {
      for (const key of [...state.batches.keys()]) flushBatch(state.chainId, key)
    }
  }

  function attach(monitor, chainIds) {
    const unsubscribers = (chainIds || []).map((chainId) => monitor.subscribe(chainId, (value) => accept(chainId, value)))
    return () => unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
  }

  function status(chainId) {
    const state = stateFor(chainId)
    return {
      chainId: state.chainId,
      sequence: state.sequence,
      latestCursor: state.sequence ? cursorFor(state.chainId, state.sequence) : null,
      buffered: state.buffer.length,
      subscribers: state.subscribers.size,
      pendingBatches: state.batches.size,
    }
  }

  function stop() {
    if (stopped) return
    flush()
    stopped = true
    for (const state of chains.values()) {
      if (state.heartbeatTimer) cancelInterval(state.heartbeatTimer)
      for (const batch of state.batches.values()) if (batch.timer) cancelTimeout(batch.timer)
      state.batches.clear()
      state.subscribers.clear()
    }
  }

  return { accept, attach, emit, flush, heartbeat, status, stop, subscribe }
}
