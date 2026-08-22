import assert from "node:assert/strict"
import test from "node:test"
import { parseEther } from "viem"
import { createNftListingService } from "../server/nft-management.js"
import { SEAPORT_1_6 } from "../server/seaport-order.js"

// OpenSea's validation error named this key explicitly; ConduitController resolves it to
// a deployed conduit on Robinhood. conduitKey zero is refused.
const ROBINHOOD_CONDUIT_KEY = "0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e"

const CONTRACT = "0x00000000000000000000000000000000000000A1"
const OWNER_A = "0x00000000000000000000000000000000000000B1"
const OWNER_B = "0x00000000000000000000000000000000000000B2"
const OPENSEA_FEE_WALLET = "0x0000a26b00c1f0dF003000390027140000fAa719"
const CREATOR = "0x24148F2d20fb60287b4b1bcd56Ee92b096101d23"
const ENV = { OPENSEA_API_KEY: "os-key" }
const SIGNATURE = `0x${"ab".repeat(65)}`

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// Robinhood uses its own OpenSea conduit; the operator and key come from the marketplace config.
function chainClient({ approved = true, counter = 7n } = {}) {
  return {
    async readContract({ functionName }) {
      if (functionName === "getCounter") return counter
      if (functionName === "isApprovedForAll") return approved
      throw new Error(`unexpected read: ${functionName}`)
    },
  }
}

function openseaFetch({ fees, posted = [], calls = [], postStatus = 200 } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, method: options.method || "GET" })
    if (parsed.pathname.includes("/contract/")) return response({ collection: "rh-collection" })
    if (parsed.pathname.startsWith("/api/v2/collections/")) return response({ fees })
    if (parsed.pathname.includes("/seaport/listings")) {
      posted.push(JSON.parse(options.body))
      if (postStatus !== 200) return response({ errors: ["invalid signature"] }, postStatus)
      return response({ order: { order_hash: `0xhash${posted.length}` } })
    }
    throw new Error(`unexpected call ${parsed.pathname}`)
  }
}

function service(overrides = {}) {
  return createNftListingService({
    accountForWallet: () => ({ signTypedData: async () => SIGNATURE }),
    clientForChain: () => chainClient(),
    clock: () => 1_700_000_000_000,
    env: ENV,
    ...overrides,
  })
}

const ROWS = [
  { id: "a:155", walletId: "a", address: OWNER_A, tokenId: "155", count: "1" },
  { id: "a:156", walletId: "a", address: OWNER_A, tokenId: "156", count: "1" },
]

function previewArgs(extra = {}) {
  return {
    chainId: 4663,
    contractAddress: CONTRACT,
    standard: "ERC721",
    marketplaceId: "opensea",
    durationSeconds: 900,
    rows: ROWS,
    prices: { "a:155": "1", "a:156": "2" },
    amounts: {},
    ...extra,
  }
}

const REQUIRED_FEES = [
  { fee: 1.0, recipient: OPENSEA_FEE_WALLET, required: true },
  { fee: 10.0, recipient: CREATOR, required: true },
]

test("OpenSea preview builds one Seaport order per NFT with the collection's real fees", async () => {
  const calls = []
  const listing = service({ fetchImpl: openseaFetch({ fees: REQUIRED_FEES, calls }) })
  const preview = await listing.preview(previewArgs())

  assert.equal(preview.status, "previewed")
  assert.equal(preview.summary.requiresApproval, false)
  assert.equal(preview.summary.ready, true)
  assert.equal(preview.summary.signatureCount, 2)
  assert.equal(preview.summary.transactionCount, 0)

  // The seller sees the split before signing, not after.
  const first = preview.summary.proceeds.find((row) => row.holdingId === "a:155")
  assert.equal(first.price, parseEther("1").toString())
  assert.equal(first.seller, parseEther("0.89").toString())
  assert.equal(first.fees.length, 2)
  assert.equal(first.fees.find((fee) => fee.recipient === CREATOR).amount, parseEther("0.10").toString())

  // Fees are read per collection, and the slug lookup is cached across the batch.
  assert.equal(calls.filter((call) => call.path.includes("/contract/")).length, 1)
  assert.equal(calls.filter((call) => call.path.startsWith("/api/v2/collections/")).length, 1)
})

test("an optional creator fee stays with the seller unless the operator opts in", async () => {
  const optional = [
    { fee: 1.0, recipient: OPENSEA_FEE_WALLET, required: true },
    { fee: 10.0, recipient: CREATOR, required: false },
  ]
  const lean = await service({ fetchImpl: openseaFetch({ fees: optional }) }).preview(previewArgs())
  const leanRow = lean.summary.proceeds.find((row) => row.holdingId === "a:155")
  assert.equal(leanRow.seller, parseEther("0.99").toString())
  assert.equal(leanRow.fees.length, 1)
  assert.equal(leanRow.skippedOptionalFees[0].amount, parseEther("0.10").toString())

  const generous = await service({
    fetchImpl: openseaFetch({ fees: optional }),
    env: { ...ENV, NFT_LISTING_PAY_OPTIONAL_ROYALTY: "true" },
  }).preview(previewArgs())
  assert.equal(generous.summary.proceeds.find((row) => row.holdingId === "a:155").seller, parseEther("0.89").toString())
})

test("submit signs each order and posts it to the chain's seaport listings endpoint", async () => {
  const posted = []
  const calls = []
  const signed = []
  const listing = service({
    fetchImpl: openseaFetch({ fees: REQUIRED_FEES, posted, calls }),
    accountForWallet: () => ({ signTypedData: async (typed) => { signed.push(typed); return SIGNATURE } }),
  })
  const preview = await listing.preview(previewArgs())
  const result = await listing.submit({
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })

  assert.equal(result.status, "submitted")
  assert.equal(posted.length, 2)
  assert.deepEqual(result.results.map((row) => row.orderIds).flat(), ["0xhash1", "0xhash2"])
  assert.ok(calls.some((call) => call.path === "/api/v2/orders/robinhood/seaport/listings" && call.method === "POST"))

  const body = posted[0]
  assert.equal(body.protocol_address, SEAPORT_1_6)
  assert.equal(body.signature, SIGNATURE)
  assert.equal(body.parameters.conduitKey, ROBINHOOD_CONDUIT_KEY, "OpenSea rejects any key but the chain's own")
  assert.equal(body.parameters.counter, "7", "the offerer's on-chain counter must be used")
  assert.equal(body.parameters.totalOriginalConsiderationItems, 3)
  assert.equal(body.parameters.endTime, String(1_700_000_000 + 900))

  // What was signed is the order minus totalOriginalConsiderationItems, on Seaport 1.6.
  assert.equal(signed[0].domain.verifyingContract, SEAPORT_1_6)
  assert.equal(signed[0].domain.version, "1.6")
  assert.equal(signed[0].domain.chainId, 4663)
  assert.equal("totalOriginalConsiderationItems" in signed[0].message, false)
})

test("an unapproved wallet blocks submission instead of signing a dead order", async () => {
  const listing = service({
    fetchImpl: openseaFetch({ fees: REQUIRED_FEES }),
    clientForChain: () => chainClient({ approved: false }),
  })
  const preview = await listing.preview(previewArgs())
  assert.equal(preview.summary.requiresApproval, true)
  assert.equal(preview.summary.ready, false)
  assert.equal(preview.summary.transactionCount, 1)
  assert.match(preview.summary.requirements[0].description, /尚未授权/)
  await assert.rejects(
    () => listing.submit({ previewId: preview.confirmation.previewId, confirmationToken: preview.confirmation.confirmationToken }),
    /先完成批量授权/,
  )
})

test("each wallet gets its own counter and the wallets are read in parallel", async () => {
  let inFlight = 0
  let peak = 0
  const listing = service({
    fetchImpl: openseaFetch({ fees: REQUIRED_FEES }),
    clientForChain: () => ({
      async readContract({ functionName, args }) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight -= 1
        if (functionName === "getCounter") return args[0].toLowerCase() === OWNER_A.toLowerCase() ? 3n : 9n
        return true
      },
    }),
  })
  const preview = await listing.preview(previewArgs({
    rows: [
      { id: "a:1", walletId: "a", address: OWNER_A, tokenId: "1", count: "1" },
      { id: "b:2", walletId: "b", address: OWNER_B, tokenId: "2", count: "1" },
    ],
    prices: { "a:1": "1", "b:2": "1" },
  }))
  assert.equal(preview.summary.signatureCount, 2)
  assert.ok(peak > 1, `wallet reads must overlap, peak was ${peak}`)
})

test("a rejected order surfaces OpenSea's own message", async () => {
  const listing = service({ fetchImpl: openseaFetch({ fees: REQUIRED_FEES, postStatus: 400 }) })
  const preview = await listing.preview(previewArgs())
  await assert.rejects(
    () => listing.submit({ previewId: preview.confirmation.previewId, confirmationToken: preview.confirmation.confirmationToken }),
    /invalid signature/,
  )
  assert.equal(listing.get(preview.id).status, "failed")
})

test("without an API key the preview says so instead of posting anywhere", async () => {
  const listing = service({ fetchImpl: openseaFetch({ fees: REQUIRED_FEES }), env: {} })
  await assert.rejects(() => listing.preview(previewArgs()), /OPENSEA_API_KEY/)
})

test("a Signed Zone V2 collection is detected from required_zone and honoured", async () => {
  const ZONE = "0x000056f7000000ece9003ca63978907a00ffd100"
  const posted = []
  const listing = service({
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.pathname.includes("/contract/")) return response({ collection: "rh" })
      if (parsed.pathname.startsWith("/api/v2/collections/")) return response({ fees: REQUIRED_FEES, required_zone: ZONE })
      posted.push(JSON.parse(options.body))
      return response({ order: { order_hash: "0xh" } })
    },
  })
  const preview = await listing.preview(previewArgs({ rows: [ROWS[0]], prices: { "a:155": "1" } }))
  await listing.submit({
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })
  assert.equal(posted[0].parameters.zone, ZONE)
  assert.equal(posted[0].parameters.orderType, 2, "FULL_RESTRICTED, or OpenSea refuses it")
})

test("a collection with no required_zone stays a fully open order", async () => {
  const posted = []
  const listing = service({
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.pathname.includes("/contract/")) return response({ collection: "rh" })
      if (parsed.pathname.startsWith("/api/v2/collections/")) return response({ fees: REQUIRED_FEES, required_zone: null })
      posted.push(JSON.parse(options.body))
      return response({ order: { order_hash: "0xh" } })
    },
  })
  const preview = await listing.preview(previewArgs({ rows: [ROWS[0]], prices: { "a:155": "1" } }))
  await listing.submit({
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })
  assert.equal(posted[0].parameters.zone, "0x0000000000000000000000000000000000000000")
  assert.equal(posted[0].parameters.orderType, 0)
})
