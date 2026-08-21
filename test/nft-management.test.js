import assert from "node:assert/strict"
import test from "node:test"
import {
  buildNftApprovalPlan,
  createNftListingService,
  nftMarketplaceCatalog,
} from "../server/nft-management.js"

const CONTRACT = "0x00000000000000000000000000000000000000A1"
const OWNER_A = "0x00000000000000000000000000000000000000B1"
const OWNER_B = "0x00000000000000000000000000000000000000B2"
// OpenSea posts to its own API and needs a key; x2y2/blur need a Reservoir-compatible
// router, which no longer has a working public deployment.
const ROUTER_ENV = { NFT_LISTING_ROUTER_URL: "https://api.reservoir.tools" }
const FULL_ENV = { ...ROUTER_ENV, OPENSEA_API_KEY: "os-key" }

test("NFT approval reads isApprovedForAll and only plans changed wallets", async () => {
  const client = {
    async readContract(request) {
      if (request.functionName === "supportsInterface") return request.args[0] === "0x80ac58cd"
      if (request.functionName === "isApprovedForAll") return request.args[0].toLowerCase() === OWNER_A.toLowerCase()
      throw new Error("unexpected read")
    },
  }
  const plan = await buildNftApprovalPlan({
    client,
    chainId: 1,
    contractAddress: CONTRACT,
    wallets: [{ id: "a", address: OWNER_A }, { id: "b", address: OWNER_B }],
    marketplaceId: "opensea",
    approved: true,
  })
  assert.equal(plan.standard, "ERC721")
  assert.equal(plan.rows.length, 2)
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].walletId, "b")
  assert.match(plan.entries[0].data, /^0x[0-9a-f]+$/i)
  assert.equal(plan.marketplace.operator, "0x1E0049783F008A0085193E00003D00cd54003c71")
})

test("marketplace catalog reports actual chain support", () => {
  const ethereum = nftMarketplaceCatalog(1, FULL_ENV)
  assert.equal(ethereum.find((item) => item.id === "opensea").supported, true)
  assert.equal(ethereum.find((item) => item.id === "blur").supported, true)
  const base = nftMarketplaceCatalog(8453, FULL_ENV)
  assert.equal(base.find((item) => item.id === "opensea").supported, true)
  assert.equal(base.find((item) => item.id === "blur").supported, false)
})

test("each platform's availability follows its own backend, not a shared one", () => {
  // Only an OpenSea key: OpenSea works, the router-backed platforms explain what is missing.
  const openseaOnly = nftMarketplaceCatalog(1, { OPENSEA_API_KEY: "k" })
  assert.equal(openseaOnly.find((item) => item.id === "opensea").supported, true)
  const blur = openseaOnly.find((item) => item.id === "blur")
  assert.equal(blur.supported, false)
  assert.match(blur.unavailableReason, /reservoir\.tools 已停止服务/)

  // Only a router: the reverse.
  const routerOnly = nftMarketplaceCatalog(1, ROUTER_ENV)
  assert.equal(routerOnly.find((item) => item.id === "blur").supported, true)
  const opensea = routerOnly.find((item) => item.id === "opensea")
  assert.equal(opensea.supported, false)
  assert.match(opensea.unavailableReason, /OPENSEA_API_KEY/)
})

test("Robinhood Chain lists on OpenSea through that chain's own conduit", () => {
  // OpenSea rejected conduitKey zero with "please use OpenSea's conduit key: 0x61159fef…",
  // and ConduitController resolves that key to 0x963F…C300 (deployed, 3190 bytes). The
  // mainnet conduit has no code on this chain, so both values differ per chain.
  const catalog = nftMarketplaceCatalog(4663, { OPENSEA_API_KEY: "k" })
  const opensea = catalog.find((item) => item.id === "opensea")
  assert.equal(opensea.chainSupported, true, "Robinhood must be a supported OpenSea chain")
  assert.equal(opensea.supported, true)
  assert.equal(opensea.operators.ERC721, "0x963F00d3ff000064fFCbA824b800c0000000C300")
  assert.equal(opensea.operators.ERC1155, "0x963F00d3ff000064fFCbA824b800c0000000C300")
  // Other chains keep the mainnet conduit.
  const ethereum = nftMarketplaceCatalog(1, { OPENSEA_API_KEY: "k" })
  assert.equal(ethereum.find((item) => item.id === "opensea").operators.ERC721, "0x1E0049783F008A0085193E00003D00cd54003c71")
  // Robinhood has no router-backed marketplace.
  assert.equal(catalog.find((item) => item.id === "blur").chainSupported, false)
})

test("with nothing configured every platform is unavailable and says why", () => {
  const catalog = nftMarketplaceCatalog(1, {})
  assert.ok(catalog.every((item) => item.supported === false), "a dead backend must not look listable")
  const opensea = catalog.find((item) => item.id === "opensea")
  assert.equal(opensea.chainSupported, true, "chain support is still reported separately")
  assert.match(opensea.unavailableReason, /OPENSEA_API_KEY/)
  assert.match(catalog.find((item) => item.id === "x2y2").unavailableReason, /NFT_LISTING_ROUTER_URL/)
})

test("NFT listing preview uses real router steps and submit signs typed data", async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    if (url.endsWith("/execute/list/v5")) {
      return response({
        steps: [{
          id: "order-signature",
          kind: "signature",
          items: [{
            status: "incomplete",
            data: {
              sign: {
                signatureKind: "eip712",
                domain: { name: "Seaport", version: "1.6", chainId: 1, verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395" },
                types: { OrderComponents: [{ name: "offerer", type: "address" }] },
                primaryType: "OrderComponents",
                value: { offerer: OWNER_A },
              },
              post: {
                endpoint: "https://api.reservoir.tools/order/v3",
                method: "POST",
                body: { order: { data: { signature: "" } } },
              },
            },
          }],
        }],
      })
    }
    return response({ orderId: "order-1" })
  }
  const signed = []
  const service = createNftListingService({
    fetchImpl,
    accountForWallet: () => ({ signTypedData: async (typed) => { signed.push(typed); return `0x${"12".repeat(65)}` } }),
    clock: () => 1_700_000_000_000,
    env: ROUTER_ENV,
  })
  const preview = await service.preview({
    chainId: 1,
    contractAddress: CONTRACT,
    standard: "ERC721",
    marketplaceId: "x2y2",
    durationSeconds: 900,
    rows: [{ id: "a:7", walletId: "a", address: OWNER_A, tokenId: "7", count: "1" }],
    prices: { "a:7": "0.25" },
    amounts: {},
  })
  assert.equal(preview.summary.ready, true)
  assert.equal(preview.summary.requiresApproval, false)
  assert.equal(requests[0].body.params[0].weiPrice, "250000000000000000")
  assert.equal(requests[0].body.params[0].token.toLowerCase(), `${CONTRACT}:7`.toLowerCase())
  const submitted = await service.submit({
    previewId: preview.confirmation.previewId,
    confirmationToken: preview.confirmation.confirmationToken,
  })
  assert.equal(submitted.status, "submitted")
  assert.equal(signed.length, 1)
  assert.equal(requests[1].body.order.data.signature, `0x${"12".repeat(65)}`)
  assert.deepEqual(submitted.results[0].orderIds, ["order-1"])
})

test("NFT listing requires approval when router returns a transaction step", async () => {
  const service = createNftListingService({
    fetchImpl: async () => response({ steps: [{ id: "nft-approval", kind: "transaction", items: [{ status: "incomplete", data: { to: CONTRACT, data: "0x1234" } }] }] }),
    accountForWallet: () => ({ signTypedData: async () => "0x" }),
    env: ROUTER_ENV,
  })
  const preview = await service.preview({
    chainId: 1,
    contractAddress: CONTRACT,
    standard: "ERC721",
    marketplaceId: "x2y2",
    durationSeconds: 900,
    rows: [{ id: "a:7", walletId: "a", address: OWNER_A, tokenId: "7", count: "1" }],
    prices: { "a:7": "0.1" },
  })
  assert.equal(preview.summary.requiresApproval, true)
  await assert.rejects(() => service.submit({ previewId: preview.id, confirmationToken: preview.confirmation.confirmationToken }), /先完成批量授权/)
})

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

