import assert from "node:assert/strict"
import test from "node:test"
import { liveFeedSnapshot, visibleLiveFeedEvents } from "../src/live-feed.js"

const existing = [
  { id: "mint-2", chainId: 1 },
  { id: "mint-1", chainId: 1 },
]

test("a paused Live Activity snapshot stays stable while newer events arrive", () => {
  const snapshot = liveFeedSnapshot(existing, 1)
  const updated = [{ id: "mint-3", chainId: 1 }, ...existing]

  assert.deepEqual(visibleLiveFeedEvents(updated, 1, snapshot).map((event) => event.id), ["mint-2", "mint-1"])
})

test("Live Activity resumes at the newest event when the snapshot is released", () => {
  const updated = [{ id: "mint-3", chainId: 1 }, ...existing]

  assert.deepEqual(visibleLiveFeedEvents(updated, 1, null).map((event) => event.id), ["mint-3", "mint-2", "mint-1"])
})

test("Live Activity only snapshots events from the selected chain", () => {
  const mixed = [{ id: "other-chain", chainId: 10 }, ...existing]

  assert.deepEqual(liveFeedSnapshot(mixed, 1).map((event) => event.id), ["mint-2", "mint-1"])
})
