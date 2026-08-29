import assert from "node:assert/strict"
import test from "node:test"
import { createMintIntelService, knownMintMethod } from "../server/mint-intel.js"

const BASE = "https://explorer.test"
const contract = "0x1111111111111111111111111111111111111111"
const targetA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const targetB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function response(payload) {
  return { ok: true, async json() { return payload } }
}

test("collection intel keeps only explorer-backed creation and dynamic tags", async () => {
  const requests = []
  const service = createMintIntelService({
    blockscoutBases: { 1: BASE },
    fetchImpl: async (url) => {
      requests.push(url)
      if (url.endsWith(`/addresses/${contract}`)) return response({
        creation_transaction_hash: "0xcreate",
        creator_address_hash: targetA,
        is_verified: true,
        metadata: { tags: [{ name: "Manifold", tagType: "protocol", slug: "manifold" }] },
      })
      if (url.endsWith("/transactions/0xcreate")) return response({
        timestamp: "2026-08-15T00:00:00Z",
        block_number: 611,
        from: { hash: targetA, metadata: { tags: [{ name: "OKX", tagType: "cex", slug: "okx" }] } },
        created_contract: { metadata: { tags: [{ name: "Bueno", tagType: "protocol", slug: "bueno" }] } },
      })
      throw new Error(`unexpected URL ${url}`)
    },
  })

  const value = await service.collection(1, contract)
  assert.equal(value.contractCreatedAt, "2026-08-15T00:00:00Z")
  assert.equal(value.contractCreatedBlock, "611")
  assert.equal(value.creatorAddress, targetA)
  assert.deepEqual(value.fundingTags, ["OKX"])
  assert.deepEqual(value.platformTags, ["Manifold", "Bueno"])
  assert.deepEqual(value.statusTags, ["已验证"])
  assert.equal(requests.length, 2)
})

test("method cache is isolated by mint target when selectors collide", async () => {
  const requests = []
  const service = createMintIntelService({
    blockscoutBases: { 1: BASE },
    fetchImpl: async (url) => {
      requests.push(url)
      if (url.endsWith("/transactions/0xaaa")) return response({ method: "mintAlpha", to: { metadata: { tags: [] } } })
      if (url.endsWith("/transactions/0xbbb")) return response({ method: "mintBeta", to: { metadata: { tags: [] } } })
      throw new Error(`unexpected URL ${url}`)
    },
  })

  const first = await service.method({ chainId: 1, selector: "0xabcdef12", txHash: "0xaaa", target: targetA })
  const second = await service.method({ chainId: 1, selector: "0xabcdef12", txHash: "0xbbb", target: targetB })
  const cached = await service.method({ chainId: 1, selector: "0xabcdef12", txHash: "0xccc", target: targetA })
  assert.equal(first.methodName, "mintAlpha")
  assert.equal(second.methodName, "mintBeta")
  assert.equal(cached.methodName, "mintAlpha")
  assert.equal(requests.length, 2)
})

test("stats and known SeaDrop methods use real returned values", async () => {
  const service = createMintIntelService({
    blockscoutBases: { 1: BASE },
    fetchImpl: async () => response({ coin_price: "1705.27", gas_prices: { fast: 30.7 } }),
  })
  assert.equal(knownMintMethod("0x161AC21F"), "mintPublic")
  assert.equal(knownMintMethod("0xdeadbeef"), "")
  assert.deepEqual((await createMintIntelService().method({ chainId: 1, selector: "0x161ac21f" })).platformTags, ["SeaDrop"])
  assert.deepEqual(await service.stats(1), { coinPriceUsd: "1705.27", explorerGasGwei: { fast: 30.7 } })
})

test("verified contract ABI is cached for pending calldata decoding", async () => {
  const abi = [{ type: "function", name: "mint", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] }]
  let calls = 0
  const service = createMintIntelService({
    blockscoutBases: { 1: BASE },
    fetchImpl: async () => {
      calls += 1
      return response({ abi })
    },
  })
  assert.deepEqual(await service.contractAbi(1, contract), abi)
  assert.deepEqual(await service.contractAbi(1, contract), abi)
  assert.equal(calls, 1)
})

test("deployer profile derives wallet age and NFT project count from explorer data", async () => {
  const deployedNft = "0xcccccccccccccccccccccccccccccccccccccccc"
  const deployedToken = "0xdddddddddddddddddddddddddddddddddddddddd"
  const requests = []
  const service = createMintIntelService({
    blockscoutBases: { 1: BASE },
    fetchImpl: async (url) => {
      requests.push(url)
      if (url.includes("action=txlist")) return response({
        status: "1",
        result: [
          { timeStamp: "1786492800", contractAddress: deployedNft },
          { timeStamp: "1786579200", contractAddress: deployedToken },
        ],
      })
      if (url.endsWith(`/tokens/${deployedNft}`)) return response({ type: "ERC-721" })
      if (url.endsWith(`/tokens/${deployedToken}`)) return response({ type: "ERC-20" })
      throw new Error(`unexpected URL ${url}`)
    },
  })

  const [first, second] = await Promise.all([
    service.deployerProfile(1, targetA),
    service.deployerProfile(1, targetA),
  ])
  assert.deepEqual(first, {
    chainId: 1,
    address: targetA,
    firstSeenAt: "2026-08-12T00:00:00.000Z",
    deployedContractCount: 2,
    nftProjectCount: 1,
  })
  assert.deepEqual(second, first)
  assert.equal(requests.length, 3)
})

test("OpenSea metadata is exposed only after canonical chain and contract verification", async () => {
  const collectionUrl = "https://opensea.io/collection/live-cats"
  const imageUrl = "https://i2c.seadn.io/collection/live-cats/image_type_logo/logo.png"
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Brand", name: "Live Cats", image: imageUrl, url: collectionUrl })}</script><script>{"externalUrl":"https://livecats.example","twitterUsername":"livecats","discordUrl":"https://discord.gg/livecats","chain":{"identifier":"robinhood"},"address":"${contract}"}</script>`
  const service = createMintIntelService({
    fetchImpl: async () => ({ ok: true, url: collectionUrl, async text() { return html } }),
  })
  assert.deepEqual(await service.marketCollection(4663, contract), {
    verified: true,
    openseaUrl: collectionUrl,
    imageUrl,
    name: "Live Cats",
    website: "https://livecats.example",
    twitter: "https://x.com/livecats",
    discordUrl: "https://discord.gg/livecats",
  })
})

test("OpenSea metadata is discarded when the canonical page points to another chain", async () => {
  const collectionUrl = "https://opensea.io/collection/wrong-chain"
  const html = `<script>{"chain":{"identifier":"ethereum"},"address":"${contract}"}</script>`
  const service = createMintIntelService({
    fetchImpl: async () => ({ ok: true, url: collectionUrl, async text() { return html } }),
  })
  assert.equal(await service.marketCollection(4663, contract), null)
})
