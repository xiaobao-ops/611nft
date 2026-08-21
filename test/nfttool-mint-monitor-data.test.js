import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_FILTERS,
  buildAlertPayload,
  collectionsWithFlags,
  createRealtimeState,
  enrichRealtimeEvents,
  eventMatches,
  filterRadarDrops,
  imageSources,
  mergeCollectionDetailIntoEvent,
  mergeSnapshotIntoEvent,
  normalizeVisibleCount,
  radarTiming,
  reduceRealtimeState,
  stableRealtimeOrder,
} from "../apps/nfttool/runtime/mint-monitor-data.js"

const ADDRESS = "0x1111111111111111111111111111111111111111"
const OTHER = "0x2222222222222222222222222222222222222222"

test("versioned collection snapshots keep newer values and merge same-version enrichment", () => {
  const base = mergeSnapshotIntoEvent({ address: ADDRESS, currentSupply: "2" }, { version: 3, current_supply: "3", image_url: "/a.png" })
  const stale = mergeSnapshotIntoEvent(base, { version: 2, current_supply: "1", image_url: "/old.png" })
  assert.equal(stale.currentSupply, "3")
  assert.equal(stale.projectImageUrl, "/a.png")
  const same = mergeSnapshotIntoEvent(base, { version: 3, website: "https://example.test" })
  assert.equal(same.website, "https://example.test")
})

test("realtime reducer replaces mint batches, handles discard and replay reset", () => {
  let state = createRealtimeState()
  state = reduceRealtimeState(state, { type: "mint", id: "a", address: ADDRESS, timestamp: 10 })
  state = reduceRealtimeState(state, { type: "mint", id: "b", address: OTHER, timestamp: 11 })
  state = reduceRealtimeState(state, { type: "mint_batch", id: "batch", eventIds: ["a", "b"], count: 2, timestamp: 12 })
  assert.equal(state.events.length, 1)
  assert.deepEqual(state.events[0].eventIds, ["a", "b"])
  state = reduceRealtimeState(state, { type: "discard", eventIds: ["a", "b"] })
  assert.equal(state.events.length, 0)
  state = reduceRealtimeState(state, { type: "mint", id: "c", address: ADDRESS })
  state = reduceRealtimeState(state, { type: "replay_reset" })
  assert.equal(state.events.length, 0)
  assert.equal(state.replayResetVersion, 1)
})

test("stable realtime order freezes existing rows while appending new rows", () => {
  const rows = [{ id: "new" }, { id: "old" }, { id: "other" }]
  assert.deepEqual(stableRealtimeOrder(rows, ["old", "other"]).map((row) => row.id), ["old", "other", "new"])
})

test("filters preserve unknown supply semantics and personal flag visibility", () => {
  const event = { address: ADDRESS, name: "Alpha", maxSupply: null, isFree: false, mintValueWei: "1", pendingCount: 0 }
  assert.equal(eventMatches(event, { ...DEFAULT_FILTERS, hideUnknownSupply: true }), false)
  const flagged = collectionsWithFlags([event], [{ address: ADDRESS, flag: "scam" }])
  assert.equal(flagged.length, 0)
  assert.equal(collectionsWithFlags([event], [{ address: ADDRESS, flag: "scam" }], { showFlagged: true })[0].personalFlag.flag, "scam")
})

test("radar filters distinguish free, paid, public and live stages", () => {
  const now = Date.parse("2026-08-18T00:00:00Z")
  const drops = [
    { contract: ADDRESS, name: "Free", priceWei: "0", stageType: "public", startTime: "2026-08-17T00:00:00Z", endTime: "2026-08-19T00:00:00Z" },
    { contract: OTHER, name: "Paid", priceWei: "100", stageType: "signed", startTime: "2026-08-20T00:00:00Z" },
  ]
  assert.equal(filterRadarDrops(drops, { price: "free", publicOnly: true, liveOnly: true }, now).length, 1)
  assert.equal(radarTiming(drops[1], now).state, "upcoming")
})

test("collection detail fills canonical event fields without overwriting the address", () => {
  const event = mergeCollectionDetailIntoEvent({ address: ADDRESS, name: "Old", currentSupply: "1" }, {
    address: ADDRESS,
    name: "New",
    current_supply: "9",
    pending_count: "2",
    unique_minters: 4,
    collection_snapshot: { version: 2, current_supply: "9" },
  })
  assert.equal(event.name, "New")
  assert.equal(event.currentSupply, "9")
  assert.equal(event.pendingCount, "2")
  assert.equal(event.uniqueMinters, 4)
})

test("realtime events inherit overview metadata by contract and transaction", () => {
  const events = enrichRealtimeEvents([{ id: "e1", address: ADDRESS, txHash: "0xtx", name: "ERC721" }], {
    windows: { "60": [{ address: ADDRESS, name: "Collection", image_url: "/image", recent_mint_preview: [{ tx_hash: "0xtx", block_number: "9" }], collection_snapshot: { version: 1, current_supply: "10" } }] },
  })
  assert.equal(events[0].name, "Collection")
  assert.equal(events[0].currentSupply, "10")
  assert.equal(events[0].blockNumber, "9")
})

test("image source traversal includes nested windows and radar drops", () => {
  const sources = imageSources({ projectImageUrl: "/top", windows: { "60": [{ image_url: "/row" }] }, drops: [{ image: "/drop" }] })
  assert.deepEqual(sources, ["/top", "/row", "/drop"])
})

test("alert payload preserves chain and type-specific parameters", () => {
  assert.deepEqual(buildAlertPayload({ type: "trending", window: "300", threshold: "7", cooldownSeconds: "30", enabled: true }, 1), {
    type: "trending", chainId: 1, name: "", enabled: true, cooldownSeconds: 30, params: { window: 300, threshold: 7 },
  })
  assert.deepEqual(buildAlertPayload({ type: "seadrop_start", leadMinutes: "5", address: "", cooldownSeconds: "0" }, 4663).params, { leadMinutes: 5 })
})

test("visible count accepts row arrays and numeric render counts", () => {
  assert.equal(normalizeVisibleCount([{}]), 1)
  assert.equal(normalizeVisibleCount(12), 12)
  assert.equal(normalizeVisibleCount("7.9"), 7)
  assert.equal(normalizeVisibleCount(undefined), 0)
})
