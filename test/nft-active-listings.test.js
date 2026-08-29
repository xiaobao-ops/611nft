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

// A wallet's listings were being missed because the collection-wide scan is bounded at
// maxPages x 100 and button-presser holds over 6000 listings: 66 listings sat on pages 12
// through 51, so a 20-page scan surfaced a handful and the rest read as "not listed".
// Naming the tokens replaces the scan with one exact lookup each.
function bestFetch({ byToken, calls = [] }) {
  return async (url) => {
    const path = new URL(url).pathname
    if (path.includes("/contract/")) return response({ collection: "rh" })
    const match = path.match(/\/nfts\/([^/]+)\/best$/)
    if (match) {
      calls.push(match[1])
      const body = byToken[match[1]]
      if (!body) return response({ errors: [`No listings found for NFT ${match[1]} in collection rh`] })
      return response(body)
    }
    throw new Error(`unexpected collection scan: ${path}`)
  }
}

test("naming the tokens looks each one up instead of scanning the collection", async () => {
  const calls = []
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["51199", "51200", "51201"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({
      calls,
      byToken: {
        51199: listing({ offerer: OWNER_A, tokenId: "51199", value: "2000000" }),
        51200: listing({ offerer: OWNER_A, tokenId: "51200", value: "2000000" }),
        51201: listing({ offerer: OWNER_A, tokenId: "51201", value: "2000000" }),
      },
    }),
    now: () => 1_700_000_000_000,
  })
  assert.deepEqual(calls.sort(), ["51199", "51200", "51201"])
  assert.equal(listings.size, 3, "every listed token must be found, whatever page it would sit on")
})

test("a token with no listing is a normal outcome, not a failed query", async () => {
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["1", "2"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({ byToken: { 1: listing({ offerer: OWNER_A, tokenId: "1", value: "5" }) } }),
    now: () => 1_700_000_000_000,
  })
  assert.equal(listings.size, 1)
  assert.ok(listings.has(`${OWNER_A.toLowerCase()}:1`))
})

test("an expired order is not reported as an active listing", async () => {
  // Every one of a wallet's ten tokens came back from /best carrying a 15-minute order that
  // had already lapsed. Showing those as active tells the seller their NFT is for sale.
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["51199"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({
      byToken: { 51199: listing({ offerer: OWNER_A, tokenId: "51199", value: "2000000", endTime: 1_700_000_000 }) },
    }),
    now: () => 1_700_000_001_000,
  })
  assert.equal(listings.size, 0, "a lapsed order must not read as listed")
})

test("an order still inside its window is reported", async () => {
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["51199"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({
      byToken: { 51199: listing({ offerer: OWNER_A, tokenId: "51199", value: "2000000", endTime: 1_700_000_600 }) },
    }),
    now: () => 1_700_000_000_000,
  })
  assert.equal(listings.size, 1)
})

test("another seller's cheaper listing does not count as ours", async () => {
  // /best returns the cheapest listing from anyone. Someone else's order says nothing about
  // whether this wallet has listed, and reporting it would show "已挂单" on an unlisted NFT.
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["51199"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({
      byToken: { 51199: listing({ offerer: OWNER_B, tokenId: "51199", value: "1" }) },
    }),
    now: () => 1_700_000_000_000,
  })
  assert.equal(listings.size, 0)
})

test("with no owners given, any seller's listing is kept", async () => {
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["51199"],
    env: ENV,
    fetchImpl: bestFetch({
      byToken: { 51199: listing({ offerer: OWNER_B, tokenId: "51199", value: "1" }) },
    }),
    now: () => 1_700_000_000_000,
  })
  assert.equal(listings.size, 1)
})

test("a listing of a different contract is ignored", async () => {
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["51199"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({
      byToken: { 51199: listing({ offerer: OWNER_A, tokenId: "51199", value: "5", token: "0x00000000000000000000000000000000000000FF" }) },
    }),
    now: () => 1_700_000_000_000,
  })
  assert.equal(listings.size, 0)
})

test("duplicate token ids are asked for once", async () => {
  const calls = []
  await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    tokenIds: ["7", "7", "7"],
    owners: [OWNER_A],
    env: ENV,
    fetchImpl: bestFetch({ calls, byToken: {} }),
    now: () => 1_700_000_000_000,
  })
  assert.deepEqual(calls, ["7"])
})

test("the collection scan still filters expired orders", async () => {
  // The unnamed-token path is unchanged apart from that filter.
  const listings = await fetchActiveListings({
    chainId: 4663,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{
      listings: [
        listing({ offerer: OWNER_A, tokenId: "1", value: "5", endTime: 1_700_000_600, hash: "0xlive" }),
        listing({ offerer: OWNER_A, tokenId: "2", value: "5", endTime: 1_600_000_000, hash: "0xdead" }),
      ],
    }]),
    now: () => 1_700_000_000_000,
  })
  assert.equal(listings.size, 1)
  assert.equal(listings.get(`${OWNER_A.toLowerCase()}:1`).orderHash, "0xlive")
})
