import assert from "node:assert/strict"
import test from "node:test"
import { liveFeedOrderSnapshot, liveFeedSnapshot, visibleLiveFeedEvents } from "../src/live-feed.js"

const existing = [
  { id: "mint-2", chainId: 1 },
  { id: "mint-1", chainId: 1 },
]

test("a paused Live Activity snapshot freezes order while row fields keep updating", () => {
  const snapshot = liveFeedOrderSnapshot(existing, 1)
  const updated = [{ id: "mint-3", chainId: 1 }, { ...existing[0], currentSupply: "88" }, existing[1]]

  const visible = visibleLiveFeedEvents(updated, 1, snapshot)
  assert.deepEqual(visible.map((event) => event.id), ["mint-2", "mint-1"])
  assert.equal(visible[0].currentSupply, "88")
})

test("Live Activity resumes at the newest event when the snapshot is released", () => {
  const updated = [{ id: "mint-3", chainId: 1 }, ...existing]

  assert.deepEqual(visibleLiveFeedEvents(updated, 1, null).map((event) => event.id), ["mint-3", "mint-2", "mint-1"])
})

test("Live Activity only snapshots events from the selected chain", () => {
  const mixed = [{ id: "other-chain", chainId: 10 }, ...existing]

  assert.deepEqual(liveFeedSnapshot(mixed, 1).map((event) => event.id), ["mint-2", "mint-1"])
})
