import assert from "node:assert/strict"
import test from "node:test"
import { attachOfferState, fetchCollectionOffers } from "../server/nft-management.js"

const CONTRACT = "0x00000000000000000000000000000000000000A1"
const OWNER_A = "0x00000000000000000000000000000000000000B1"
const ENV = { OPENSEA_API_KEY: "os-key" }

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function offer({ hash, tokenId = "155", amount = "1", value = "12160000000000000000", criteria, itemType = 2 }) {
  return {
    order_hash: hash,
    chain: "ethereum",
    protocol_address: "0x00000000000000000000000000000000000000B0",
    price: { currency: "WETH", decimals: 18, value },
    ...(criteria ? { criteria } : {}),
    protocol_data: {
      parameters: {
        offerer: OWNER_A,
        endTime: "1800000000",
        offer: [{ itemType: 1, token: "0x00000000000000000000000000000000000000C0", startAmount: value }],
        consideration: [{ itemType, token: CONTRACT, identifierOrCriteria: tokenId, startAmount: amount }],
      },
    },
  }
}

function openseaFetch(pages) {
  let page = 0
  return async (url) => {
    const path = new URL(url).pathname
    if (path.includes("/contract/")) return response({ collection: "offers-collection" })
    const body = pages[page]
    page += 1
    return response(body)
  }
}

test("offers normalize total value, NFT quantity, and unit value", async () => {
  const found = await fetchCollectionOffers({
    chainId: 1,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{ offers: [offer({ hash: "0xoffer", amount: "4" })] }]),
  })
  const entry = found.get("155")?.[0]
  assert.equal(entry.priceValue, "12160000000000000000")
  assert.equal(entry.quantity, "4")
  assert.equal(entry.unitPriceValue, "3040000000000000000")
  assert.equal(entry.priceDecimals, 18)
  assert.equal(entry.priceCurrency, "WETH")
})

test("offer price keeps non-18-decimal currencies in base units", async () => {
  const usdOffer = offer({ hash: "0xusdg", value: "110000", amount: "1" })
  usdOffer.price = { currency: "USDG", decimals: 6, value: "110000" }
  const found = await fetchCollectionOffers({
    chainId: 4663,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{ offers: [usdOffer] }]),
  })
  const entry = found.get("155")?.[0]
  assert.equal(entry.priceCurrency, "USDG")
  assert.equal(entry.priceDecimals, 6)
  assert.equal(entry.unitPriceValue, "110000")
})

test("criteria offers attach through wildcard and explicit token ids", async () => {
  const found = await fetchCollectionOffers({
    chainId: 1,
    contractAddress: CONTRACT,
    env: ENV,
    fetchImpl: openseaFetch([{
      offers: [
        offer({ hash: "0xall", itemType: 4, criteria: { encoded_token_ids: "*" }, value: "100" }),
        offer({ hash: "0xids", itemType: 4, criteria: { encoded_token_ids: "7, 9" }, value: "200" }),
      ],
    }]),
  })
  assert.equal(found.get("*")?.[0].scope, "collection")
  assert.equal(found.get("7")?.[0].orderHash, "0xids")
  const enriched = attachOfferState({
    contractAddress: CONTRACT,
    rows: [{ tokenId: "7" }, { tokenId: "8" }],
  }, found)
  assert.equal(enriched.offeredCount, 2)
  assert.deepEqual(enriched.rows[0].offers.map((item) => item.orderHash), ["0xids", "0xall"])
  assert.deepEqual(enriched.rows[1].offers.map((item) => item.orderHash), ["0xall"])
  assert.equal(enriched.rows[0].bestOffer.orderHash, "0xids")
})

test("missing key or unsupported chain avoids the network", async () => {
  const fail = async () => { throw new Error("network should not be called") }
  assert.equal((await fetchCollectionOffers({ chainId: 1, contractAddress: CONTRACT, env: {}, fetchImpl: fail })).size, 0)
  assert.equal((await fetchCollectionOffers({ chainId: 999, contractAddress: CONTRACT, env: ENV, fetchImpl: fail })).size, 0)
})
