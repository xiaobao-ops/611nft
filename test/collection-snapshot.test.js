import assert from "node:assert/strict"
import test from "node:test"
import { applyCollectionUpdate, mergeSnapshotIntoEvent } from "../src/collection-snapshot.js"

const address = "0x1111111111111111111111111111111111111111"

function snapshot(version, currentSupply) {
  return {
    version,
    current_supply: currentSupply,
    max_supply: "1000",
    pending_token_count: "6",
    pending_unknown_tx_count: 2,
    pending_transaction_count: 4,
    pending_coverage: "partial",
    image_url: "/api/mint-monitor/media/project",
    image_source: "contract_uri",
    website: "https://project.example",
    twitter: "https://x.com/project",
    opensea_url: "https://opensea.io/collection/project",
    opensea_verified: true,
    funding_tags: ["OKX"],
    platform_tags: ["OpenSea"],
    status_tags: [],
    contract_created_at: "2026-08-16T00:00:00.000Z",
    contract_created_block: "123",
    creator_address: "0x2222222222222222222222222222222222222222",
    deployer_profile: { walletAgeDays: 2, nftProjectCount: 7, risk: { risky: true, reasons: ["young"] } },
  }
}

test("collection updates synchronize every row for the same contract", () => {
  const update = { address, collection_snapshot: snapshot(2, "88") }
  const result = applyCollectionUpdate({
    events: [{ id: "a", address, currentSupply: "70" }, { id: "other", address: "0x2222222222222222222222222222222222222222" }],
    windows: { "1800": [{ address, current_supply: "70" }] },
  }, update)
  assert.equal(result.events[0].currentSupply, "88")
  assert.equal(result.events[0].pendingUnknownTxCount, 2)
  assert.equal(result.events[0].creatorAddress, update.collection_snapshot.creator_address)
  assert.deepEqual(result.events[0].deployerProfile, update.collection_snapshot.deployer_profile)
  assert.equal(result.windows["1800"][0].current_supply, "88")
  assert.equal(result.windows["1800"][0].image_source, "contract_uri")
  assert.equal(result.windows["1800"][0].creator_address, update.collection_snapshot.creator_address)
  assert.deepEqual(result.windows["1800"][0].deployer_profile, update.collection_snapshot.deployer_profile)
  assert.equal(result.events[1].id, "other")
})

test("an older collection snapshot never overwrites a newer event", () => {
  const current = mergeSnapshotIntoEvent({ id: "a", address }, snapshot(3, "99"))
  const stale = mergeSnapshotIntoEvent(current, snapshot(2, "88"))
  assert.equal(stale.currentSupply, "99")
  assert.equal(stale.collection_snapshot.version, 3)

  const conflictingSameVersion = mergeSnapshotIntoEvent(current, snapshot(3, "77"))
  assert.equal(conflictingSameVersion.currentSupply, "99")
})

test("the same snapshot version fills missing collection media without changing confirmed supply", () => {
  const currentSnapshot = { ...snapshot(3, "99"), image_url: null, image_source: null }
  const current = mergeSnapshotIntoEvent({ id: "a", address }, currentSnapshot)
  const enriched = mergeSnapshotIntoEvent(current, snapshot(3, "77"))

  assert.equal(enriched.currentSupply, "99")
  assert.equal(enriched.projectImageUrl, "/api/mint-monitor/media/project")
  assert.equal(enriched.imageSource, "contract_uri")
  assert.equal(enriched.collection_snapshot.version, 3)
})
