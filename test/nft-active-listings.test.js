import assert from "node:assert/strict"
import test from "node:test"
import { attachListingState, fetchActiveListings } from "../server/nft-management.js"

const CONTRACT = "0x00000000000000000000000000000000000000A1"
const OWNER_A = "0x00000000000000000000000000000000000000B1"
const OWNER_B = "0x00000000000000000000000000000000000000B2"
const ENV = { OPENSEA_API_KEY: "os-key" }

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function listing({ offerer, tokenId, value, endTime = 1_800_000_000, hash = "0xhash", token = CONTRACT }) {
  return {
    order_hash: hash,
    price: { current: { currency: "ETH", decimals: 18, value } },
    protocol_data: {
      parameters: {
        offerer,
        endTime: String(endTime),
        offer: [{ token, identifierOrCriteria: tokenId }],
      },
    },
  }
}

function openseaFetch(pages) {
  let page = 0
  return async (url) => {
    if (new URL(url).pathname.includes("/contract/")) return response({ collection: "rh" })
    const body = pages[page]
    page += 1
    return response(body)
  }
}

function holdings(rows) {
  return { contractAddress: CONTRACT, standard: "ERC721", rows }
}

test("active listings come back keyed by owner and token", async () => {
  const found = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{ listings: [listing({ offerer: OWNER_A, tokenId: "155", value: "100000000000000" })] }]),
  })
  assert.equal(found.size, 1)
  const entry = found.get(`${OWNER_A.toLowerCase()}:155`)
  assert.equal(entry.priceWei, "100000000000000")
  assert.equal(entry.currency, "ETH")
  assert.equal(entry.endTime, 1_800_000_000)
})

test("paging follows next until it runs out", async () => {
  const found = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([
      { listings: [listing({ offerer: OWNER_A, tokenId: "1", value: "5" })], next: "p1" },
      { listings: [listing({ offerer: OWNER_B, tokenId: "2", value: "6" })] },
    ]),
  })
  assert.equal(found.size, 2)
})

test("another collection's listings in the same feed are ignored", async () => {
  const found = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{
      listings: [
        listing({ offerer: OWNER_A, tokenId: "155", value: "10", token: "0x00000000000000000000000000000000000000FF" }),
        listing({ offerer: OWNER_A, tokenId: "156", value: "20" }),
      ],
    }]),
  })
  assert.equal(found.size, 1)
  assert.ok(found.has(`${OWNER_A.toLowerCase()}:156`))
})

test("when a token has several listings the cheapest one wins", async () => {
  const found = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{
      listings: [
        listing({ offerer: OWNER_A, tokenId: "7", value: "900", hash: "0xexpensive" }),
        listing({ offerer: OWNER_A, tokenId: "7", value: "100", hash: "0xcheap" }),
      ],
    }]),
  })
  assert.equal(found.get(`${OWNER_A.toLowerCase()}:7`).orderHash, "0xcheap")
})

test("no key or an unsupported chain means no lookup at all", async () => {
  const reject = async () => { throw new Error("must not call out") }
  assert.equal((await fetchActiveListings({ chainId: 4663, contractAddress: CONTRACT, env: {}, fetchImpl: reject })).size, 0)
  assert.equal((await fetchActiveListings({ chainId: 999, contractAddress: CONTRACT, env: ENV, fetchImpl: reject })).size, 0)
})

test("listing state attaches to the matching rows and counts them", () => {
  const listings = new Map([
    [`${OWNER_A.toLowerCase()}:155`, { orderHash: "0xa", priceWei: "1000", currency: "ETH", endTime: 1 }],
  ])
  const enriched = attachListingState(holdings([
    { id: "a:155", walletId: "a", address: OWNER_A, tokenId: "155" },
    { id: "a:156", walletId: "a", address: OWNER_A, tokenId: "156" },
  ]), listings)

  assert.equal(enriched.listedCount, 1)
  assert.equal(enriched.rows[0].listing.orderHash, "0xa")
  assert.equal(enriched.rows[1].listing, undefined)
})

test("an empty or failed lookup leaves holdings untouched", () => {
  const rows = [{ id: "a:1", walletId: "a", address: OWNER_A, tokenId: "1" }]
  assert.equal(attachListingState(holdings(rows), new Map()).rows[0].listing, undefined)
  assert.equal(attachListingState(holdings(rows), null).listedCount, undefined)
})
