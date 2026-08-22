import assert from "node:assert/strict"
import test from "node:test"
import { parseEther } from "viem"
import {
  buildListingOrder,
  feeBasisPoints,
  listingPostBody,
  listingTypedData,
  OPENSEA_CONDUIT_KEY,
  ORDER_TYPE,
  orderTypeFor,
  SEAPORT_1_6,
  splitListingPrice,
  ZERO_ADDRESS,
  ZERO_BYTES32,
} from "../server/seaport-order.js"

const SELLER = "0x00000000000000000000000000000000000000B1"
const CONTRACT = "0x00000000000000000000000000000000000000A1"
const OPENSEA_FEE_WALLET = "0x0000a26b00c1f0dF003000390027140000fAa719"
// Surveyed across Robinhood collections: OpenSea's own 1% is always required, while the
// creator fee is whatever that collection set — observed 0%, 1%, 5%, 7% and 10%, and
// roughly half of them optional. This fixture is one collection's choice, not a standard.
const FEES = [
  { fee: 1.0, recipient: OPENSEA_FEE_WALLET, required: true },
  { fee: 10.0, recipient: "0x24148F2d20fb60287b4b1bcd56Ee92b096101d23", required: true },
]

function order(overrides = {}) {
  return buildListingOrder({
    offerer: SELLER,
    contractAddress: CONTRACT,
    tokenId: "155",
    standard: "ERC721",
    weiPrice: parseEther("1"),
    fees: FEES,
    startTime: 1_700_000_000,
    endTime: 1_700_000_900,
    salt: 42n,
    counter: 0n,
    ...overrides,
  })
}

test("percent fees convert to basis points without floating point drift", () => {
  assert.equal(feeBasisPoints(1.0), 100n)
  assert.equal(feeBasisPoints(10.0), 1000n)
  assert.equal(feeBasisPoints(2.5), 250n)
  assert.equal(feeBasisPoints(0.5), 50n)
  assert.equal(feeBasisPoints(0), 0n)
  assert.throws(() => feeBasisPoints(-1), /费率无效/)
  assert.throws(() => feeBasisPoints(101), /超过 100%/)
})

test("the split always adds back up to the asking price, to the wei", () => {
  // A price that does not divide evenly by the fee basis points is the case that would
  // silently lose or invent wei if each line rounded on its own.
  const awkward = 1_000_000_000_000_000_001n
  const split = splitListingPrice({ weiPrice: awkward, fees: FEES, seller: SELLER })
  const total = split.seller.amount + split.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  assert.equal(total, awkward, "consideration must sum to exactly the price")
  assert.equal(split.fees.length, 2)
  assert.equal(split.fees[0].amount, awkward * 100n / 10_000n)
  assert.equal(split.fees[1].amount, awkward * 1000n / 10_000n)
})

test("optional creator fees are skipped by default and can be paid on request", () => {
  // Observed shape: OpenSea's 1% required, the collection's 5% optional.
  const fees = [
    { fee: 1.0, recipient: OPENSEA_FEE_WALLET, required: true },
    { fee: 5.0, recipient: FEES[1].recipient, required: false },
  ]
  const lean = splitListingPrice({ weiPrice: parseEther("1"), seller: SELLER, fees })
  assert.equal(lean.fees.length, 1, "only the required fee is charged")
  assert.equal(lean.seller.amount, parseEther("0.99"), "the seller keeps the optional royalty")
  assert.equal(lean.skippedOptionalFees.length, 1)
  assert.equal(lean.skippedOptionalFees[0].amount, parseEther("0.05"), "what was skipped is reported, not hidden")

  const generous = splitListingPrice({ weiPrice: parseEther("1"), seller: SELLER, fees, includeOptionalFees: true })
  assert.equal(generous.fees.length, 2)
  assert.equal(generous.seller.amount, parseEther("0.94"))
  assert.equal(generous.skippedOptionalFees.length, 0)
})

test("a required creator fee cannot be opted out of", () => {
  // Half the surveyed collections mark their royalty required; dropping it produces an
  // order OpenSea rejects, so it must stay in the consideration either way.
  const fees = [
    { fee: 1.0, recipient: OPENSEA_FEE_WALLET, required: true },
    { fee: 10.0, recipient: FEES[1].recipient, required: true },
  ]
  const split = splitListingPrice({ weiPrice: parseEther("1"), seller: SELLER, fees })
  assert.equal(split.fees.length, 2)
  assert.equal(split.skippedOptionalFees.length, 0)
  assert.equal(split.seller.amount, parseEther("0.89"))
  assert.ok(split.fees.every((fee) => fee.required === true))
})

test("a collection with no creator fee leaves the seller everything but OpenSea's cut", () => {
  const split = splitListingPrice({
    weiPrice: parseEther("1"),
    seller: SELLER,
    fees: [{ fee: 1.0, recipient: OPENSEA_FEE_WALLET, required: true }],
  })
  assert.equal(split.fees.length, 1)
  assert.equal(split.seller.amount, parseEther("0.99"))
})

test("a price swallowed entirely by fees is refused rather than signed", () => {
  assert.throws(
    () => splitListingPrice({ weiPrice: 100n, seller: SELLER, fees: [{ fee: 100, recipient: FEES[0].recipient, required: true }] }),
    /不足以支付卖家/,
  )
  assert.throws(() => splitListingPrice({ weiPrice: 0n, seller: SELLER, fees: [] }), /必须大于 0/)
})

test("a listing order carries the seller first and every required fee after", () => {
  const built = order()
  assert.equal(built.offerer, SELLER)
  assert.equal(built.orderType, 0, "FULL_OPEN, matching the zero zone")
  assert.equal(built.zone, ZERO_ADDRESS)
  assert.equal(built.zoneHash, ZERO_BYTES32)
  assert.equal(built.totalOriginalConsiderationItems, 3)

  assert.deepEqual(built.offer, [{
    itemType: 2,
    token: CONTRACT,
    identifierOrCriteria: "155",
    startAmount: "1",
    endAmount: "1",
  }])

  assert.equal(built.consideration[0].recipient, SELLER)
  assert.equal(built.consideration[0].startAmount, parseEther("0.89").toString())
  assert.equal(built.consideration[1].startAmount, parseEther("0.01").toString())
  assert.equal(built.consideration[2].startAmount, parseEther("0.10").toString())
  // Native ETH consideration: item type 0, zero token, zero identifier.
  assert.ok(built.consideration.every((item) => item.itemType === 0 && item.token === ZERO_ADDRESS && item.identifierOrCriteria === "0"))
  assert.ok(built.consideration.every((item) => item.startAmount === item.endAmount), "a fixed-price listing never decays")
})

test("ERC1155 carries its quantity, ERC721 refuses one", () => {
  const multi = order({ standard: "ERC1155", amount: 5n })
  assert.equal(multi.offer[0].itemType, 3)
  assert.equal(multi.offer[0].startAmount, "5")
  assert.throws(() => order({ standard: "ERC721", amount: 2n }), /只能挂 1 个/)
  assert.throws(() => order({ standard: "ERC404" }), /不支持的标准/)
  assert.throws(() => order({ amount: 0n }), /数量必须大于 0/)
})

test("an end time that is not after the start is refused", () => {
  assert.throws(() => order({ startTime: 1_700_000_900, endTime: 1_700_000_000 }), /结束时间必须晚于/)
  assert.throws(() => order({ startTime: 1_700_000_000, endTime: 1_700_000_000 }), /结束时间必须晚于/)
})

test("conduitKey defaults to zero and is otherwise passed through verbatim", () => {
  // The real per-chain key is chosen by the caller (nft-management resolves it from the
  // marketplace config); this module must not invent one.
  assert.equal(order().conduitKey, ZERO_BYTES32)
  assert.equal(order({ conduitKey: OPENSEA_CONDUIT_KEY }).conduitKey, OPENSEA_CONDUIT_KEY)
})

test("typed data matches the posted order and uses the Seaport 1.6 domain", () => {
  const built = order()
  const typed = listingTypedData({ chainId: 4663, order: built })

  assert.deepEqual(typed.domain, {
    name: "Seaport",
    version: "1.6",
    chainId: 4663,
    verifyingContract: SEAPORT_1_6,
  })
  assert.equal(typed.primaryType, "OrderComponents")
  // totalOriginalConsiderationItems is part of the posted body but NOT of the signed
  // struct; including it would produce a signature OpenSea rejects.
  assert.equal("totalOriginalConsiderationItems" in typed.message, false)
  assert.equal(typed.types.OrderComponents.length, 11)

  // The signed numbers must be the same values the body posts, just as bigints.
  assert.equal(typed.message.consideration.length, built.consideration.length)
  built.consideration.forEach((item, index) => {
    assert.equal(typed.message.consideration[index].startAmount, BigInt(item.startAmount))
    assert.equal(typed.message.consideration[index].recipient, item.recipient)
  })
  assert.equal(typed.message.offer[0].identifierOrCriteria, 155n)
  assert.equal(typed.message.counter, 0n)
  assert.equal(typed.message.salt, 42n)
})

test("the post body is what the OpenSea listings endpoint expects", () => {
  const built = order()
  const body = listingPostBody({ order: built, signature: `0x${"ab".repeat(65)}` })
  assert.deepEqual(Object.keys(body).sort(), ["parameters", "protocol_address", "signature"])
  assert.equal(body.protocol_address, SEAPORT_1_6)
  assert.equal(body.parameters.totalOriginalConsiderationItems, 3)
  assert.equal(body.signature, `0x${"ab".repeat(65)}`)
})

test("a Signed Zone V2 collection gets a restricted order type and the zone it named", () => {
  // OpenSea refused a FULL_OPEN order: "invalid order type when using a contract that
  // requires Signed Zone V2 ... use the required zone 0x000056f7…". The collection API
  // reports that address as required_zone, so the two travel together.
  const ZONE = "0x000056f7000000ece9003ca63978907a00ffd100"
  const restricted = order({ zone: ZONE })
  assert.equal(restricted.zone, ZONE)
  assert.equal(restricted.orderType, ORDER_TYPE.FULL_RESTRICTED)
  // zoneHash stays zero: the zone's signature arrives as extraData at fulfilment and is
  // not part of what the seller signs.
  assert.equal(restricted.zoneHash, ZERO_BYTES32)

  const open = order()
  assert.equal(open.zone, ZERO_ADDRESS)
  assert.equal(open.orderType, ORDER_TYPE.FULL_OPEN)
})

test("order type pairs zone authority with partial fillability", () => {
  const ZONE = "0x000056f7000000ece9003ca63978907a00ffd100"
  assert.equal(orderTypeFor({ zone: ZERO_ADDRESS, standard: "ERC721", amount: 1n }), ORDER_TYPE.FULL_OPEN)
  assert.equal(orderTypeFor({ zone: ZONE, standard: "ERC721", amount: 1n }), ORDER_TYPE.FULL_RESTRICTED)
  // Only ERC1155 with more than one unit is meaningfully partially fillable.
  assert.equal(orderTypeFor({ zone: ZERO_ADDRESS, standard: "ERC1155", amount: 5n }), ORDER_TYPE.PARTIAL_OPEN)
  assert.equal(orderTypeFor({ zone: ZONE, standard: "ERC1155", amount: 5n }), ORDER_TYPE.PARTIAL_RESTRICTED)
  assert.equal(orderTypeFor({ zone: ZONE, standard: "ERC1155", amount: 1n }), ORDER_TYPE.FULL_RESTRICTED)
  assert.equal(orderTypeFor({ zone: "", standard: "ERC721", amount: 1n }), ORDER_TYPE.FULL_OPEN)
})

test("the zone is part of the signed struct, so it cannot be swapped after signing", () => {
  const ZONE = "0x000056f7000000ece9003ca63978907a00ffd100"
  const typed = listingTypedData({ chainId: 4663, order: order({ zone: ZONE }) })
  assert.equal(typed.message.zone, ZONE)
  assert.equal(typed.message.orderType, ORDER_TYPE.FULL_RESTRICTED)
  assert.ok(typed.types.OrderComponents.some((field) => field.name === "zone"))
  assert.ok(typed.types.OrderComponents.some((field) => field.name === "orderType"))
})
