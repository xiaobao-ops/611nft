import assert from "node:assert/strict"
import test from "node:test"
import { createRealtimeStream, formatSseMessage } from "../server/realtime-stream.js"

function manualClock() {
  let now = 0
  let id = 0
  const timers = new Map()

  function schedule(callback, delay, interval = false) {
    const timerId = ++id
    timers.set(timerId, { callback, at: now + delay, delay, interval })
    return timerId
  }

  function tick(ms) {
    const target = now + ms
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      const [timerId, timer] = next
      now = timer.at
      if (timer.interval) timer.at += timer.delay
      else timers.delete(timerId)
      timer.callback()
    }
    now = target
  }

  return {
    now: () => now,
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: (timerId) => timers.delete(timerId),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: (timerId) => timers.delete(timerId),
    tick,
  }
}

test("per-chain replay buffers retain 500 events and reset stale or cross-chain cursors", () => {
  const clock = manualClock()
  const stream = createRealtimeStream({ ...clock, heartbeatMs: 0 })
  for (let index = 1; index <= 501; index += 1) {
    stream.emit(1, { type: "collection_patch", chainId: 1, address: `0x${index.toString(16).padStart(40, "0")}` })
  }

  const stale = []
  stream.subscribe(1, "1-1", (message) => stale.push(message))()
  assert.equal(stale.length, 1)
  assert.equal(stale[0].value.type, "replay_reset")
  assert.equal(stale[0].cursor, "1-501")

  const replayed = []
  stream.subscribe(1, "1-500", (message) => replayed.push(message))()
  assert.deepEqual(replayed.map((message) => message.cursor), ["1-501"])
  assert.equal(replayed[0].replayed, true)

  const crossChain = []
  stream.subscribe(1, "2-3", (message) => crossChain.push(message))()
  assert.equal(crossChain[0].value.type, "replay_reset")
  assert.equal(stream.status(1).buffered, 500)
  stream.stop()
})

test("replay subscriptions queue nested live publications behind the replay snapshot", () => {
  const clock = manualClock()
  const stream = createRealtimeStream({ ...clock, heartbeatMs: 0 })
  stream.emit(1, { type: "collection_patch", marker: 1 })
  stream.emit(1, { type: "collection_patch", marker: 2 })
  const markers = []
  const unsubscribe = stream.subscribe(1, "1-1", (message) => {
    markers.push(message.value.marker)
    if (message.value.marker === 2) stream.emit(1, { type: "collection_patch", marker: 3 })
  })
  assert.deepEqual(markers, [2, 3])
  unsubscribe()
  stream.stop()
})

test("raw mint events project into per-contract batches with token ranges and rate samples", () => {
  const clock = manualClock()
  const stream = createRealtimeStream({ ...clock, batchMs: 2000, heartbeatMs: 0 })
  const received = []
  stream.subscribe(1, "", (message) => received.push(message))

  stream.accept(1, {
    type: "mint",
    id: "event-1",
    chainId: 1,
    address: "0x1111111111111111111111111111111111111111",
    timestamp: 100,
    quantity: "2",
    tokenIds: ["10", "11"],
    name: "First",
  })
  stream.accept(1, {
    type: "mint",
    id: "event-1",
    chainId: 1,
    address: "0x1111111111111111111111111111111111111111",
    timestamp: 100,
    quantity: "2",
    tokenIds: ["10", "11"],
  })
  clock.tick(1000)
  stream.accept(1, {
    type: "mint",
    id: "event-2",
    chainId: 1,
    address: "0x1111111111111111111111111111111111111111",
    timestamp: 101,
    quantity: "3",
    tokenIds: ["12", "14"],
    name: "Second",
  })
  stream.accept(1, {
    type: "mint",
    id: "event-other",
    chainId: 1,
    address: "0x2222222222222222222222222222222222222222",
    timestamp: 101,
    quantity: "1",
    tokenIds: ["99"],
  })
  clock.tick(1000)

  const batch = received.find((message) => message.value.eventIds?.includes("event-1"))?.value
  assert.equal(batch.type, "mint_batch")
  assert.deepEqual(batch.eventIds, ["event-1", "event-2"])
  assert.equal(batch.count, 5)
  assert.deepEqual(batch.tokenIdRange, { start: "10", end: "14" })
  assert.equal(batch.firstTimestamp, 100)
  assert.equal(batch.lastTimestamp, 101)
  assert.equal(batch.id, batch.batchId)

  const heartbeat = stream.heartbeat(1)
  assert.equal(heartbeat.type, "heartbeat")
  assert.equal(heartbeat.mintRateSamples.length, 60)
  assert.equal(heartbeat.mintRateSamples.reduce((sum, sample) => sum + sample.count, 0), 6)
  assert.equal(received.at(-1).cursor, null)
  assert.equal(stream.status(1).latestCursor, "1-1")
  stream.stop()
})

test("heartbeat includes the current transport source and measured latency", () => {
  const clock = manualClock()
  const statuses = []
  const stream = createRealtimeStream({
    ...clock,
    heartbeatMs: 0,
    getHealth(chainId, monitorStatus) {
      statuses.push({ chainId, monitorStatus })
      return { source: "HTTP RPC", latencyMs: 42 }
    },
  })
  stream.accept(1, { type: "monitor_status", status: "live", chainId: 1 })

  const heartbeat = stream.heartbeat(1)

  assert.equal(heartbeat.source, "HTTP RPC")
  assert.equal(heartbeat.latencyMs, 42)
  assert.deepEqual(statuses, [{ chainId: 1, monitorStatus: { type: "monitor_status", status: "live", chainId: 1 } }])
  stream.stop()
})

test("SSE formatting keeps the transport cursor separate from the business id", () => {
  const output = formatSseMessage({
    cursor: "1-7",
    value: { type: "mint_batch", id: "batch-business-id" },
  })
  assert.equal(output, 'id: 1-7\ndata: {"type":"mint_batch","id":"batch-business-id"}\n\n')
})

test("collection updates become patches and discards prune pending batch members", () => {
  const clock = manualClock()
  const stream = createRealtimeStream({ ...clock, batchMs: 2000, heartbeatMs: 0 })
  const received = []
  stream.subscribe(1, "", (message) => received.push(message.value))
  const address = "0x1111111111111111111111111111111111111111"

  stream.accept(1, { type: "collection_update", chainId: 1, address, collection_snapshot: { version: 2 } })
  stream.accept(1, { type: "mint", id: "keep", chainId: 1, address, timestamp: 10, quantity: "1", tokenIds: ["1"] })
  stream.accept(1, { type: "mint", id: "remove", chainId: 1, address, timestamp: 11, quantity: "4", tokenIds: ["2"] })
  stream.accept(1, { type: "discard", chainId: 1, eventIds: ["remove"] })
  clock.tick(2000)

  assert.deepEqual(received[0], { type: "collection_patch", chainId: 1, address, collection_snapshot: { version: 2 } })
  assert.equal(received[1].type, "discard")
  const batch = received.find((value) => value.type === "mint_batch")
  assert.deepEqual(batch.eventIds, ["keep"])
  assert.equal(batch.count, 1)
  stream.stop()
})
