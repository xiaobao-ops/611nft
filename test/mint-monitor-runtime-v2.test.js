import assert from "node:assert/strict"
import test from "node:test"
import { createMonitorCache, MONITOR_CACHE_VERSION } from "../apps/nfttool/runtime/mint-monitor-cache.js"
import { createRegionSignatures, createRenderScheduler } from "../apps/nfttool/runtime/mint-monitor-renderer.js"
import { createMonitorStore, MAX_PENDING_MESSAGES, MAX_SEEN_CURSORS } from "../apps/nfttool/runtime/mint-monitor-store.js"
import { createMonitorStreamCoordinator } from "../apps/nfttool/runtime/mint-monitor-stream.js"
import { createRuntimeDiagnostics } from "../apps/nfttool/runtime/runtime-diagnostics.js"

function memoryStorage() {
  const map = new Map()
  return { get length() { return map.size }, getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key), key: (index) => [...map.keys()][index] }
}

test("monitor cache enforces ten minute TTL, schema and public-only fields", async () => {
  const storage = memoryStorage(); let now = 1_000_000
  const cache = createMonitorCache({ storage, now: () => now, requestIdleCallback: null, indexedDB: null })
  cache.save(1, 1800, { cursor: "1-7", overview: { events: [{ id: "e" }], wallet: "private" }, events: [{ id: "e", calldata: "0xdead" }] }, { immediate: true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const value = await cache.load(1, 1800)
  assert.equal(value.version, MONITOR_CACHE_VERSION)
  assert.equal(JSON.stringify(value).includes("0xdead"), false)
  assert.equal(JSON.stringify(value).includes("private"), false)
  now += 10 * 60 * 1000 + 1
  assert.equal(await cache.load(1, 1800), null)
})

test("store atomically applies a snapshot then replays only post-checkpoint events", () => {
  const store = createMonitorStore({ chainId: 1, overviewWindow: 60 })
  store.beginSynchronizing()
  store.receive({ cursor: "1-3", value: { type: "mint", id: "post", timestamp: 3 } })
  store.receive({ cursor: "1-2", value: { type: "mint", id: "checkpoint", timestamp: 2 } })
  store.applySnapshot({ overview: { events: [{ type: "mint", id: "snapshot", timestamp: 1 }] } }, { cursor: "1-2" })
  const state = store.getState()
  assert.equal(state.status, "live")
  assert.deepEqual(state.realtime.events.map((event) => event.id), ["post", "snapshot"])
  assert.equal(store.receive({ cursor: "1-3", value: { type: "mint", id: "duplicate", timestamp: 4 } }), false)
})

test("store bounds replay cursor and synchronization queues", () => {
  const store = createMonitorStore({ chainId: 1, maxPending: 3, maxSeenCursors: 3 })
  store.beginSynchronizing()
  for (let index = 1; index <= 8; index += 1) {
    store.receive({ cursor: `1-${index}`, value: { type: "mint", id: `queued-${index}` } })
  }
  let state = store.getState()
  assert.equal(state.pending.length, 3)
  assert.equal(state.pendingDropped, 5)
  store.applySnapshot({ overview: { events: [] } }, { cursor: "1-8" })
  for (let index = 9; index <= 20; index += 1) store.receive({ cursor: `1-${index}`, value: { type: "mint", id: `event-${index}` } })
  state = store.getState()
  assert.equal(state.seenCursors.size <= 3, true)
  assert.equal(state.seenCursorOrder.length <= 3, true)
  assert.equal(MAX_PENDING_MESSAGES > 0, true)
  assert.equal(MAX_SEEN_CURSORS > 0, true)
})

test("stream coordinator keeps cursor and uses 1/2/4/8/15 second reconnect backoff", () => {
  let clock = 0; let source; const timers = []; const states = []; const messages = []
  class FakeEventSource { constructor(url) { this.url = url; source = this; } close() { this.closed = true } }
  const coordinator = createMonitorStreamCoordinator({
    chainId: 1, EventSourceClass: FakeEventSource, now: () => clock, setInterval: () => 1, clearInterval: () => {},
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length }, clearTimeout: () => {},
    onState: (value) => states.push(value), onMessage: (value) => messages.push(value),
  })
  coordinator.start(); source.onopen(); source.onmessage({ data: JSON.stringify({ type: "mint", id: "one" }), lastEventId: "1-9" })
  assert.equal(coordinator.status().lastEventId, "1-9"); assert.equal(messages[0].cursor, "1-9")
  source.onerror(); assert.equal(timers[0].delay, 1000); timers.shift().callback(); source.onerror(); assert.equal(timers[0].delay, 2000)
  assert.equal(states.some((state) => state.state === "degraded"), true)
  coordinator.stop()
})

test("diagnostics are capped and redact sensitive fields; scheduler merges a burst", async () => {
  const diagnostics = createRuntimeDiagnostics({ limit: 2, now: () => 0 })
  diagnostics.record("rpc", "request", { rpcUrl: "https://token:secret@rpc.example/path", confirmationToken: "secret" })
  diagnostics.record("render", "one"); diagnostics.record("render", "two")
  assert.equal(diagnostics.list().length, 2); assert.equal(diagnostics.exportJson().includes("secret"), false)
  const committed = []; let microtask; let frame
  const scheduler = createRenderScheduler({ queueMicrotask: (callback) => { microtask = callback }, requestAnimationFrame: (callback) => { frame = callback; return 1 }, render: (regions) => committed.push(regions) })
  scheduler.invalidate("feed", "a"); scheduler.invalidate("feed", "b"); microtask(); frame()
  assert.equal(committed.length, 1); assert.equal(committed[0][0].signature, "b")
  assert.deepEqual(Object.keys(createRegionSignatures({ feed: ["a"] })), ["metrics", "toolbar", "feed", "detail", "actionPanel"])
})
