import assert from "node:assert/strict"
import test from "node:test"
import {
  collectionDetailFromMintEvent,
  optimisticCollectionDetail,
  syncCollectionDetailFromOverview,
} from "../src/collection-detail.js"

const address = "0x1111111111111111111111111111111111111111"

test("overview recent Mint preview becomes an immediately renderable detail list", () => {
  const preview = [{ tx_hash: "0xabc", token_id: "7" }]
  const detail = optimisticCollectionDetail(null, {
    address,
    recent_mints: 611,
    recent_mint_preview: preview,
  })
  assert.equal(detail.recent_mints, preview)
  assert.equal(Array.isArray(detail.recent_mints), true)
})

test("overview Mint count never overwrites an already loaded detail list", () => {
  const loaded = [{ tx_hash: "0xfull", token_id: "42" }]
  const detail = optimisticCollectionDetail({ address, recent_mints: loaded }, {
    address: address.toUpperCase(),
    recent_mints: 999,
    recent_mint_preview: [{ tx_hash: "0xpreview" }],
  })
  assert.equal(detail.recent_mints, loaded)
})

test("switching collections uses the new collection preview", () => {
  const preview = [{ tx_hash: "0xnew" }]
  const detail = optimisticCollectionDetail({ address, recent_mints: [{ tx_hash: "0xold" }] }, {
    address: "0x2222222222222222222222222222222222222222",
    recent_mints: 3,
    recent_mint_preview: preview,
  })
  assert.equal(detail.recent_mints, preview)
})

test("a live Mint is added immediately to the selected collection detail", () => {
  const current = { address, current_supply: "10", recent_mints: [{ tx_hash: "0xold", token_id: "6" }] }
  const detail = collectionDetailFromMintEvent(current, {
    address: address.toUpperCase(),
    txHash: "0xnew",
    timestamp: 611,
    recipient: "0x2222222222222222222222222222222222222222",
    tokenIds: ["7"],
    quantity: "1",
    mintPrice: "0.01 ETH",
  })

  assert.equal(detail.recent_mints[0].tx_hash, "0xnew")
  assert.equal(detail.recent_mints[0].token_id, "7")
  assert.equal(detail.current_supply, "10", "non-authoritative events must not increment supply")
})

test("the latest overview synchronizes authoritative selected collection stats", () => {
  const loaded = [{ tx_hash: "0xfull", token_id: "42" }]
  const detail = syncCollectionDetailFromOverview(
    { address, current_supply: "10", max_supply: "100", recent_mints: loaded },
    [{ address: address.toUpperCase(), current_supply: "11", max_supply: "100", recent_mints: 3 }],
  )

  assert.equal(detail.current_supply, "11")
  assert.equal(detail.max_supply, "100")
  assert.equal(detail.recent_mints, loaded)
})
