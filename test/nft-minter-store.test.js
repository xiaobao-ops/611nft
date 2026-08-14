import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { createNftMinterStore } from "../server/nft-minter-store.js"

const contract = "0x1111111111111111111111111111111111111111"
const alice = "0x2222222222222222222222222222222222222222"
const bob = "0x3333333333333333333333333333333333333333"

test("minter store merges live minters with paginated backfill and persists its cursor", () => {
  const db = new DatabaseSync(":memory:")
  const store = createNftMinterStore(db)

  store.recordMinter(4663, contract, alice)
  store.savePage(4663, contract, [alice, bob], { block_number: 123, index: 9 })
  assert.deepEqual(store.progress(4663, contract).nextPageParams, { block_number: 123, index: 9 })
  assert.deepEqual(store.snapshot(4663, contract), {
    count: 2,
    status: "loading",
    error: "",
    pagesScanned: 1,
    updatedAt: store.snapshot(4663, contract).updatedAt,
  })

  const restartedStore = createNftMinterStore(db)
  assert.deepEqual(restartedStore.progress(4663, contract).nextPageParams, { block_number: 123, index: 9 })
  restartedStore.savePage(4663, contract, [bob], null)
  assert.equal(restartedStore.snapshot(4663, contract).count, 2)
  assert.equal(restartedStore.snapshot(4663, contract).status, "complete")
  db.close()
})
