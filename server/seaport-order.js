// Seaport 1.6 listing orders, built locally.
//
// Reservoir used to hand back ready-to-sign steps; with it gone the order has to be
// assembled here and posted straight to OpenSea. Everything in this module is pure so the
// arithmetic that decides where a seller's money goes is unit-testable without a network.

export const SEAPORT_1_6 = "0x0000000000000068F116a894984e2DB1123eB395"
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`
// First 20 bytes are OpenSea's conduit deployer; the conduit must exist on the chain.
export const OPENSEA_CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000"

const ITEM_TYPE = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3 }
// The "restricted" order types hand fulfilment authority to the zone, which is what
// OpenSea's Signed Zone V2 collections require; the "partial" ones let a buyer take less
// than the whole quantity, which only means anything for ERC1155.
export const ORDER_TYPE = { FULL_OPEN: 0, PARTIAL_OPEN: 1, FULL_RESTRICTED: 2, PARTIAL_RESTRICTED: 3 }
const BPS = 10_000n

// A zone only has authority over a restricted order, so the two are chosen together.
// Naming a zone on a FULL_OPEN order leaves it inert and OpenSea rejects the listing:
// "invalid order type when using a contract that requires Signed Zone V2".
export function orderTypeFor({ zone, standard, amount = 1n }) {
  const restricted = Boolean(zone) && zone !== ZERO_ADDRESS
  const partial = standard === "ERC1155" && BigInt(amount) > 1n
  if (restricted) return partial ? ORDER_TYPE.PARTIAL_RESTRICTED : ORDER_TYPE.FULL_RESTRICTED
  return partial ? ORDER_TYPE.PARTIAL_OPEN : ORDER_TYPE.FULL_OPEN
}

export const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
}

// OpenSea reports fees as percentages ("1.0" meaning 1%), but money has to be split in
// integer wei. Percent -> basis points keeps two decimal places of a percent exactly.
export function feeBasisPoints(percent) {
  const parsed = Number(percent)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`挂单费率无效：${percent}`)
  const bps = Math.round(parsed * 100)
  if (bps > Number(BPS)) throw new Error(`挂单费率超过 100%：${percent}`)
  return BigInt(bps)
}

// The consideration must add up to exactly the asking price, so the seller's own line
// absorbs every rounding remainder rather than each fee rounding independently.
//
// OpenSea's own ~1% always comes back required and cannot be dropped. The creator fee is
// whatever the collection set — surveyed across Robinhood collections it ranges from none
// at all to 10%, and about half are optional. Optional ones are skipped by default so the
// seller keeps that money; pass includeOptionalFees to pay them anyway.
export function splitListingPrice({ weiPrice, fees = [], seller, includeOptionalFees = false }) {
  const price = BigInt(weiPrice)
  if (price <= 0n) throw new Error("挂单价格必须大于 0")
  const entries = []
  const skipped = []
  let distributed = 0n
  for (const fee of fees) {
    const optional = fee.required === false
    const bps = feeBasisPoints(fee.fee)
    if (bps === 0n) continue
    if (optional && !includeOptionalFees) {
      skipped.push({ recipient: fee.recipient, amount: price * bps / BPS, basisPoints: bps })
      continue
    }
    const amount = price * bps / BPS
    if (amount <= 0n) continue
    distributed += amount
    entries.push({ recipient: fee.recipient, amount, basisPoints: bps, required: !optional })
  }
  const sellerAmount = price - distributed
  if (sellerAmount <= 0n) throw new Error("挂单价格扣除平台与版税费用后不足以支付卖家，请提高价格")
  return {
    total: price,
    seller: { recipient: seller, amount: sellerAmount },
    fees: entries,
    skippedOptionalFees: skipped,
  }
}

function considerationItem({ amount, recipient }) {
  return {
    itemType: ITEM_TYPE.NATIVE,
    token: ZERO_ADDRESS,
    identifierOrCriteria: "0",
    startAmount: amount.toString(),
    endAmount: amount.toString(),
    recipient,
  }
}

export function buildListingOrder({
  offerer,
  contractAddress,
  tokenId,
  standard = "ERC721",
  amount = 1n,
  weiPrice,
  fees = [],
  startTime,
  endTime,
  salt,
  counter,
  conduitKey = ZERO_BYTES32,
  zone = ZERO_ADDRESS,
  includeOptionalFees = false,
}) {
  if (!["ERC721", "ERC1155"].includes(standard)) throw new Error(`挂单不支持的标准：${standard}`)
  const quantity = BigInt(amount)
  if (quantity <= 0n) throw new Error("挂单数量必须大于 0")
  if (standard === "ERC721" && quantity !== 1n) throw new Error("ERC721 每次只能挂 1 个")
  const start = BigInt(startTime)
  const end = BigInt(endTime)
  if (end <= start) throw new Error("挂单结束时间必须晚于开始时间")

  const split = splitListingPrice({ weiPrice, fees, seller: offerer, includeOptionalFees })
  const consideration = [
    considerationItem(split.seller),
    ...split.fees.map((fee) => considerationItem(fee)),
  ]

  // The returned object is posted verbatim as `parameters` and (minus
  // totalOriginalConsiderationItems) hashed as the signed struct, so nothing that is not
  // a Seaport field may appear here. Callers wanting the fee breakdown call
  // splitListingPrice directly.
  return {
    offerer,
    zone,
    offer: [{
      itemType: standard === "ERC1155" ? ITEM_TYPE.ERC1155 : ITEM_TYPE.ERC721,
      token: contractAddress,
      identifierOrCriteria: BigInt(tokenId).toString(),
      startAmount: quantity.toString(),
      endAmount: quantity.toString(),
    }],
    consideration,
    orderType: orderTypeFor({ zone, standard, amount: quantity }),
    startTime: start.toString(),
    endTime: end.toString(),
    zoneHash: ZERO_BYTES32,
    salt: BigInt(salt).toString(),
    conduitKey,
    counter: BigInt(counter).toString(),
    totalOriginalConsiderationItems: consideration.length,
  }
}

// viem's signTypedData wants real numbers/bigints where the ABI says uint; the JSON body
// OpenSea wants keeps them as strings. Build the signing view from the posting view so the
// two can never drift apart.
export function listingTypedData({ chainId, seaportAddress = SEAPORT_1_6, order }) {
  const { totalOriginalConsiderationItems, ...components } = order
  return {
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId: Number(chainId),
      verifyingContract: seaportAddress,
    },
    types: SEAPORT_TYPES,
    primaryType: "OrderComponents",
    message: {
      ...components,
      offer: components.offer.map((item) => ({
        itemType: item.itemType,
        token: item.token,
        identifierOrCriteria: BigInt(item.identifierOrCriteria),
        startAmount: BigInt(item.startAmount),
        endAmount: BigInt(item.endAmount),
      })),
      consideration: components.consideration.map((item) => ({
        itemType: item.itemType,
        token: item.token,
        identifierOrCriteria: BigInt(item.identifierOrCriteria),
        startAmount: BigInt(item.startAmount),
        endAmount: BigInt(item.endAmount),
        recipient: item.recipient,
      })),
      startTime: BigInt(components.startTime),
      endTime: BigInt(components.endTime),
      salt: BigInt(components.salt),
      counter: BigInt(components.counter),
    },
  }
}

export function listingPostBody({ order, signature, protocolAddress = SEAPORT_1_6 }) {
  return {
    parameters: order,
    signature,
    protocol_address: protocolAddress,
  }
}
