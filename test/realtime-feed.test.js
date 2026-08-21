import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { liveFeedOrderSnapshot, visibleLiveFeedEvents } from "../src/live-feed.js"
import {
  createRealtimeFeedState,
  realtimeEventKey,
  reduceRealtimeFeed,
  replaceRealtimeOverview,
} from "../src/realtime-feed.js"

const mint = (id, overrides = {}) => ({
  type: "mint",
  id,
  chainId: 1,
  address: "0x1111111111111111111111111111111111111111",
  timestamp: 100,
  tokenIds: ["1"],
  ...overrides,
})

test("mint_batch replaces its member events with one stable aggregate", () => {
  let state = createRealtimeFeedState()
  state = reduceRealtimeFeed(state, mint("mint-1", { timestamp: 101 }))
  state = reduceRealtimeFeed(state, mint("mint-2", { timestamp: 102, name: "Latest" }))
  state = reduceRealtimeFeed(state, {
    ...mint("mint-2", { timestamp: 102, name: "Latest" }),
    type: "mint_batch",
    batchId: "batch-1",
    eventIds: ["mint-1", "mint-2"],
    count: 8,
    tokenIdRange: { start: "10", end: "17" },
    firstTimestamp: 101,
    lastTimestamp: 102,
  })

  assert.equal(state.events.length, 1)
  assert.equal(realtimeEventKey(state.events[0]), "batch-1")
  assert.equal(state.events[0].id, "batch-1")
  assert.equal(state.events[0].latestEventId, "mint-2")
  assert.equal(state.events[0].name, "Latest")
  assert.equal(state.events[0].count, 8)
  assert.deepEqual(state.events[0].tokenIdRange, { start: "10", end: "17" })
})

test("a growing batch keeps its paused row position while flattened fields update", () => {
  let state = reduceRealtimeFeed(createRealtimeFeedState(), {
    ...mint("mint-1", { name: "First" }),
    type: "mint_batch",
    batchId: "batch-1",
    eventIds: ["mint-1"],
    count: 1,
  })
  const paused = liveFeedOrderSnapshot(state.events, 1)
  state = reduceRealtimeFeed(state, {
    ...mint("mint-2", { name: "Latest", timestamp: 102 }),
    type: "mint_batch",
    batchId: "batch-1",
    eventIds: ["mint-1", "mint-2"],
    count: 2,
  })

  const visible = visibleLiveFeedEvents(state.events, 1, paused)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].id, "batch-1")
  assert.equal(visible[0].name, "Latest")
  assert.equal(visible[0].count, 2)
})

test("heartbeat keeps only the latest 60 real rate samples and health fields", () => {
  const samples = Array.from({ length: 65 }, (_, index) => index / 10)
  const state = reduceRealtimeFeed(createRealtimeFeedState(), {
    type: "heartbeat",
    mintRate: 6.4,
    rateSamples: samples,
    latencyMs: 87,
    source: "wss-primary",
  })

  assert.equal(state.mintRate, 6.4)
  assert.equal(state.rateSamples.length, 60)
  assert.deepEqual(state.rateSamples, samples.slice(-60))
  assert.equal(state.latencyMs, 87)
  assert.equal(state.source, "wss-primary")
})

test("heartbeat accepts timestamped server samples without inventing points", () => {
  const state = reduceRealtimeFeed(createRealtimeFeedState(), {
    type: "heartbeat",
    mintRate: 0.5,
    mintRateSamples: [{ timestamp: 1, count: 2 }, { timestamp: 2, count: 3 }],
  })
  assert.deepEqual(state.rateSamples, [2, 3])
})

test("heartbeat accepts nested monitor health from older stream producers", () => {
  const state = reduceRealtimeFeed(createRealtimeFeedState(), {
    type: "heartbeat",
    mintRate: 0.5,
    monitorStatus: { source: "HTTP RPC", latencyMs: 55 },
  })

  assert.equal(state.source, "HTTP RPC")
  assert.equal(state.latencyMs, 55)
})

test("collection_patch shares the versioned collection_update merge contract", () => {
  let state = reduceRealtimeFeed(createRealtimeFeedState(), mint("mint-1", {
    currentSupply: "10",
    collection_snapshot: { version: 1, current_supply: "10", image_url: "/old" },
  }))
  state = reduceRealtimeFeed(state, {
    type: "collection_patch",
    chainId: 1,
    address: mint("mint-1").address,
    collection_snapshot: { version: 2, current_supply: "11", image_url: "/new" },
  })

  assert.equal(state.events[0].currentSupply, "11")
  assert.equal(state.events[0].projectImageUrl, "/new")
  assert.equal(state.events[0].collection_snapshot.version, 2)
})

test("discard removes direct events and any aggregate named by batchId or eventIds", () => {
  let state = reduceRealtimeFeed(createRealtimeFeedState(), mint("solo"))
  state = reduceRealtimeFeed(state, {
    ...mint("latest"),
    type: "mint_batch",
    batchId: "batch-1",
    eventIds: ["member-1", "latest"],
    count: 2,
    tokenIdRange: { start: "1", end: "2" },
  })
  state = reduceRealtimeFeed(state, { type: "discard", eventIds: ["solo", "member-1"] })
  assert.deepEqual(state.events, [])

  state = reduceRealtimeFeed(state, {
    ...mint("latest-2"),
    type: "mint_batch",
    batchId: "batch-2",
    eventIds: ["latest-2"],
    count: 1,
  })
  state = reduceRealtimeFeed(state, { type: "discard", batchId: "batch-2", eventIds: [] })
  assert.deepEqual(state.events, [])
})

test("replay_reset clears stale events while overview replacement preserves post-reset events", () => {
  let state = reduceRealtimeFeed(createRealtimeFeedState(), mint("stale", { timestamp: 90 }))
  state = reduceRealtimeFeed(state, { type: "replay_reset" })
  state = reduceRealtimeFeed(state, mint("after-reset", { timestamp: 110 }))
  state = replaceRealtimeOverview(state, [
    mint("snapshot", { timestamp: 100 }),
    mint("after-reset", { timestamp: 105, name: "Older snapshot" }),
  ])

  assert.deepEqual(state.events.map((event) => event.id), ["after-reset", "snapshot"])
  assert.equal(state.events[0].timestamp, 110)
  assert.equal(state.events.some((event) => event.id === "stale"), false)
  assert.equal(state.replayResetVersion, 1)
})

test("the browser stream lifecycle is independent from overview windows and never awaits media", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8")
  const start = source.indexOf("let overviewRequest = 0")
  const end = source.indexOf("}, [tab, chainId])", start)
  const streamEffect = source.slice(start, end)

  assert.ok(start > 0 && end > start)
  assert.match(streamEffect, /new EventSource/)
  assert.doesNotMatch(streamEffect, /setInterval/)
  assert.doesNotMatch(streamEffect, /await preloadLiveMintImages/)
  assert.ok(streamEffect.indexOf("setMintRealtime") < streamEffect.indexOf("void preloadLiveMintImages(value)"))
})

test("the Live Mint UI renders batch metadata and an inline real-sample sparkline", async () => {
  const source = await readFile(new URL("../src/LiveMintView.jsx", import.meta.url), "utf8")
  assert.match(source, /event\.batchId \? <b className="liveBatchCount">×/)
  assert.match(source, /event\.tokenIdRange\?\.start/)
  assert.match(source, /<svg className="liveRateSparkline"/)
  assert.match(source, /samples \|\| \[\].*slice\(-60\)/s)
})
