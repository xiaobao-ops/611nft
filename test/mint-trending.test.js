import assert from "node:assert/strict"
import test from "node:test"
import { createMintTrending } from "../server/mint-trending.js"

const alpha = "0x1111111111111111111111111111111111111111"
const beta = "0x2222222222222222222222222222222222222222"

function mint(id, address, timestamp, quantity, minter, extra = {}) {
  return {
    type: "mint",
    id,
    chainId: 1,
    address,
    timestamp,
    quantity: String(quantity),
    minter,
    txHash: `0x${id.padStart(64, "0")}`,
    name: address === alpha ? "Alpha" : "Beta",
    ...extra,
  }
}

test("trending separates minted quantity, transaction count and window minters", () => {
  let now = 1_000_000
  const trending = createMintTrending({ now: () => now * 1000 })
  trending.ingest(mint("1", alpha, now - 20, 4, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
  trending.ingest(mint("2", alpha, now - 10, 2, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
  trending.ingest(mint("3", alpha, now - 5, 1, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))

  const row = trending.snapshot({ chainId: 1, window: 60 }).collections[0]
  assert.equal(row.mintCount, 7)
  assert.equal(row.txCount, 3)
  assert.equal(row.uniqueMinters, 2)
  assert.equal(row.rank, 1)
})

test("trending expires events at the exact window boundary", () => {
  let now = 2_000_000
  const trending = createMintTrending({ now: () => now * 1000 })
  trending.ingest(mint("1", alpha, now - 61, 50, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
  trending.ingest(mint("2", beta, now - 60, 1, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
  assert.deepEqual(trending.snapshot({ chainId: 1, window: 60 }).collections.map((row) => row.address), [beta])
  now += 1
  assert.equal(trending.snapshot({ chainId: 1, window: 60 }).collections.length, 0)
})

test("trending uses stable ranking for ties and isolates chains", () => {
  const trending = createMintTrending({ now: () => 3_000_000 * 1000 })
  trending.ingest(mint("1", beta, 2_999_990, 2, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
  trending.ingest(mint("2", alpha, 2_999_990, 2, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
  trending.ingest({ ...mint("3", alpha, 2_999_995, 100, "0xcccccccccccccccccccccccccccccccccccccccc"), chainId: 2 })
  assert.deepEqual(trending.snapshot({ chainId: 1, window: 60 }).collections.map((row) => row.address), [alpha, beta])
  assert.equal(trending.snapshot({ chainId: 2, window: 60 }).collections[0].mintCount, 100)
})

test("trending deduplicates events and discard recomputes every window", () => {
  const trending = createMintTrending({ now: () => 4_000_000 * 1000 })
  const event = mint("1", alpha, 3_999_990, 8, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  assert.equal(trending.ingest(event), true)
  assert.equal(trending.ingest(event), false)
  assert.equal(trending.snapshot({ chainId: 1, window: 60 }).collections[0].mintCount, 8)
  assert.equal(trending.discard(1, [event.id]), 1)
  assert.equal(trending.snapshot({ chainId: 1, window: 60 }).collections.length, 0)
})

test("trending keeps a 24 hour aggregate beyond the visible feed cap", () => {
  const now = 5_000_000
  const trending = createMintTrending({ now: () => now * 1000, maxEvents: 2_000 })
  for (let index = 0; index < 1_200; index += 1) {
    trending.ingest(mint(String(index + 1), alpha, now - index, 1, `0x${String(index % 50).padStart(40, "0")}`))
  }
  const row = trending.snapshot({ chainId: 1, window: 86400 }).collections[0]
  assert.equal(row.mintCount, 1_200)
  assert.equal(row.txCount, 1_200)
  assert.equal(row.uniqueMinters, 50)
})

test("trending rejects unsupported windows and clamps limits", () => {
  const trending = createMintTrending()
  assert.throws(() => trending.snapshot({ chainId: 1, window: 42 }), /窗口/)
  assert.throws(() => trending.snapshot({ chainId: 1, window: 60, limit: 0 }), /数量/)
})
