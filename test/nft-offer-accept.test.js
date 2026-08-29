import assert from "node:assert/strict"
import test from "node:test"
import { encodeFulfillment, createOfferAcceptService } from "../server/offer-accept.js"
import { SeaportFulfillmentAbi } from "../server/seaport-abi.js"

const CONTRACT = "0x00000000000000000000000000000000000000A1"
const OWNER = "0x00000000000000000000000000000000000000B1"
const SEAPORT = "0x00000000000000000000000000000000000000B0"

const typeOf = (item) => item.type === "tuple[]"
  ? `(${item.components.map(typeOf).join(",")})[]`
  : item.type === "tuple"
    ? `(${item.components.map(typeOf).join(",")})`
    : item.type
const signature = (name) => {
  const item = SeaportFulfillmentAbi.find((entry) => entry.type === "function" && entry.name === name)
  return `${name}(${item.inputs.map(typeOf).join(",")})`
}
const zeroValue = (item) => {
  if (item.type === "tuple[]") return []
  if (item.type === "tuple") return Object.fromEntries(item.components.map((child) => [child.name, zeroValue(child)]))
  if (item.type.endsWith("[]")) return []
  if (item.type === "address") return OWNER
  if (item.type === "bytes32") return `0x${"00".repeat(32)}`
  if (item.type === "bytes") return "0x"
  if (item.type.startsWith("uint")) return "0"
  return false
}

function advancedInput() {
  const item = SeaportFulfillmentAbi.find((entry) => entry.type === "function" && entry.name === "fulfillAdvancedOrder")
  return Object.fromEntries(item.inputs.map((input) => [input.name, zeroValue(input)]))
}

function matchInput() {
  const item = SeaportFulfillmentAbi.find((entry) => entry.type === "function" && entry.name === "matchAdvancedOrders")
  return Object.fromEntries(item.inputs.map((input) => [input.name, zeroValue(input)]))
}

test("encodeFulfillment reproduces Seaport selector and keeps calldata suffix", () => {
  const encoded = encodeFulfillment({
    function: signature("fulfillAdvancedOrder"),
    to: SEAPORT,
    value: "12",
    calldata_suffix: "0xcdb44011",
    input_data: advancedInput(),
  })
  assert.match(encoded.data, /^0xe7acab24/)
  assert.match(encoded.data, /cdb44011$/)
  assert.equal(encoded.valueWei, "12")
})

test("encodeFulfillment rejects a mismatched function selector", () => {
  assert.throws(() => encodeFulfillment({
    function: "fulfillAdvancedOrder(uint256)",
    to: SEAPORT,
    value: "0",
    input_data: advancedInput(),
  }), /ABI|不匹配|编码|invalid/i)
})

test("encodeFulfillment supports criteria matchAdvancedOrders", () => {
  const encoded = encodeFulfillment({
    function: signature("matchAdvancedOrders"),
    to: SEAPORT,
    value: "0",
    input_data: matchInput(),
  })
  assert.match(encoded.data, /^0xf2d12b12/)
})

test("offer preview requests OpenSea fulfillment data and reports approval", async () => {
  const calls = []
  const service = createOfferAcceptService({
    env: { OPENSEA_API_KEY: "key" },
    clientForChain: () => ({ readContract: async () => false }),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ fulfillment_data: { transaction: { function: signature("fulfillAdvancedOrder"), to: SEAPORT, value: "0", input_data: advancedInput(), calldata_suffix: "0x" } } }) }
    },
  })
  const plan = await service.preview({
    chainId: 1,
    contractAddress: CONTRACT,
    standard: "ERC721",
    rows: [{ id: "w:7", walletId: "w", address: OWNER, contractAddress: CONTRACT, tokenId: "7", bestOffer: { orderHash: "0xoffer", protocolAddress: SEAPORT, chain: "ethereum", priceValue: "100", unitPriceValue: "100", quantity: "1", priceCurrency: "WETH" } }],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.opensea.io/api/v2/offers/fulfillment_data")
  assert.equal(calls[0].body.offer.hash, "0xoffer")
  assert.equal(calls[0].body.consideration.token_id, "7")
  assert.equal(plan.requiresApproval, true)
  assert.equal(plan.entries[0].to, SEAPORT)
})
