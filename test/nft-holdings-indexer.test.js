import assert from "node:assert/strict"
import test from "node:test"
import { createNftHoldingsIndexer } from "../server/nft-holdings.js"

const CONTRACT = "0x00000000000000000000000000000000000000A1"
const WALLETS = [
  { id: "a", address: "0x00000000000000000000000000000000000000B1" },
  { id: "b", address: "0x00000000000000000000000000000000000000B2" },
]

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function alchemyNft(tokenId, extra = {}) {
  return {
    tokenId: String(tokenId),
    balance: "1",
    tokenType: "ERC721",
    name: `Token ${tokenId}`,
    image: { cachedUrl: `https://cdn.example/${tokenId}.png` },
    tokenUri: `https://meta.example/${tokenId}`,
    ...extra,
  }
}

test("no configured key means no adapter, so the caller falls back to the chain", async () => {
  const indexer = createNftHoldingsIndexer({ env: {}, fetchImpl: async () => { throw new Error("must not call out") } })
  assert.equal(indexer.configured, false)
  assert.equal(indexer.adapterFor(1), null)
  assert.equal(await indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: WALLETS }), null)
})

test("Alchemy holdings arrive with metadata attached and wallets queried in parallel", async () => {
  const calls = []
  let inFlight = 0
  let peak = 0
  const indexer = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "test-key" },
    fetchImpl: async (url) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      calls.push(new URL(url))
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight -= 1
      const owner = new URL(url).searchParams.get("owner")
      return response({ ownedNfts: owner === WALLETS[0].address ? [alchemyNft(7), alchemyNft(9)] : [alchemyNft(4)] })
    },
  })

  const holdings = await indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: WALLETS })
  assert.equal(holdings.source, "alchemy")
  assert.equal(peak, 2, "both wallets must be queried at once")
  assert.equal(holdings.rows.length, 3)
  assert.equal(holdings.totalCount, "3")
  assert.equal(holdings.coverageComplete, true)
  // Metadata rides along, so the per-token tokenURI reads are skipped entirely.
  assert.equal(holdings.metadataPending, 0)
  assert.deepEqual(holdings.rows.map((row) => row.id), ["a:7", "a:9", "b:4"])
  assert.equal(holdings.rows[0].metadata.imageUrl, "https://cdn.example/7.png")
  assert.equal(holdings.rows[0].metadata.tokenName, "Token 7")
  assert.equal(calls[0].searchParams.get("contractAddresses[]"), CONTRACT)
  assert.equal(calls[0].searchParams.get("withMetadata"), "true")
})

test("Alchemy paging follows pageKey until it runs out", async () => {
  let page = 0
  const indexer = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "k" },
    fetchImpl: async () => {
      page += 1
      return response(page < 3
        ? { ownedNfts: [alchemyNft(page)], pageKey: `p${page}` }
        : { ownedNfts: [alchemyNft(page)] })
    },
  })
  const holdings = await indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: [WALLETS[0]] })
  assert.equal(holdings.rows.length, 3)
  assert.equal(page, 3)
})

test("ERC1155 balances survive as counts rather than collapsing to one", async () => {
  const indexer = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "k" },
    fetchImpl: async () => response({ ownedNfts: [alchemyNft(1, { tokenType: "ERC1155", balance: "5" })] }),
  })
  const holdings = await indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: [WALLETS[0]] })
  assert.equal(holdings.standard, "ERC1155")
  assert.equal(holdings.rows[0].count, "5")
  assert.equal(holdings.totalCount, "5")
})

test("OpenSea resolves the contract to a slug once and reuses it per wallet", async () => {
  const paths = []
  const indexer = createNftHoldingsIndexer({
    env: { OPENSEA_API_KEY: "os-key" },
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      paths.push(parsed.pathname)
      if (parsed.pathname.includes("/contract/")) return response({ collection: "my-collection" })
      return response({
        nfts: [{ identifier: "12", contract: CONTRACT, token_standard: "erc721", name: "OS 12", display_image_url: "https://i.example/12.png" }],
      })
    },
  })
  const holdings = await indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: WALLETS })
  assert.equal(holdings.source, "opensea")
  assert.equal(holdings.rows.length, 2)
  assert.equal(holdings.rows[0].metadata.imageUrl, "https://i.example/12.png")
  assert.equal(paths.filter((path) => path.includes("/contract/")).length, 1, "slug is resolved once, not per wallet")
})

test("an unsupported chain returns null instead of guessing", async () => {
  const indexer = createNftHoldingsIndexer({ env: { ALCHEMY_API_KEY: "k" }, fetchImpl: async () => response({}) })
  assert.equal(await indexer.query({ chainId: 999_999, contractAddress: CONTRACT, wallets: WALLETS }), null)
})

test("Robinhood Chain resolves on both providers", async () => {
  // Verified against the live APIs: Alchemy exposes robinhood-mainnet and OpenSea's
  // chain identifier is "robinhood". This is the project's primary chain.
  const seen = []
  const alchemy = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "k" },
    fetchImpl: async (url) => { seen.push(new URL(url).hostname); return response({ ownedNfts: [alchemyNft(1)] }) },
  })
  await alchemy.query({ chainId: 4663, contractAddress: CONTRACT, wallets: [WALLETS[0]] })
  assert.equal(seen[0], "robinhood-mainnet.g.alchemy.com")

  const paths = []
  const opensea = createNftHoldingsIndexer({
    env: { OPENSEA_API_KEY: "k" },
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      paths.push(parsed.pathname)
      if (parsed.pathname.includes("/contract/")) return response({ collection: "c" })
      return response({ nfts: [] })
    },
  })
  await opensea.query({ chainId: 4663, contractAddress: CONTRACT, wallets: [WALLETS[0]] })
  assert.ok(paths.every((path) => path.includes("/chain/robinhood/")), paths.join(" "))
})

test("a provider that rejects one chain hands over to the next instead of giving up", async () => {
  // An Alchemy app only has the networks its owner enabled; the rest answer 403. That is
  // a reason to try OpenSea, not to fall all the way back to chain enumeration.
  const indexer = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "k", OPENSEA_API_KEY: "k" },
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      if (parsed.hostname.endsWith("g.alchemy.com")) return response({ error: "ETH_MAINNET is not enabled for this app" }, 403)
      if (parsed.pathname.includes("/contract/")) return response({ collection: "c" })
      return response({ nfts: [{ identifier: "5", contract: CONTRACT, token_standard: "erc721", name: "OS 5" }] })
    },
  })
  const holdings = await indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: [WALLETS[0]] })
  assert.equal(holdings.source, "opensea", "must fall through to the second provider")
  assert.equal(holdings.rows.length, 1)
})

test("when every provider fails the reasons are combined so the log names both", async () => {
  const indexer = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "k", OPENSEA_API_KEY: "k" },
    fetchImpl: async () => response({ error: { message: "nope" } }, 401),
  })
  await assert.rejects(
    () => indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: [WALLETS[0]] }),
    (error) => /Alchemy/.test(error.message) && /OpenSea/.test(error.message),
  )
})

test("an indexer error surfaces with its provider message so the route can fall back", async () => {
  const indexer = createNftHoldingsIndexer({
    env: { ALCHEMY_API_KEY: "k" },
    fetchImpl: async () => response({ error: { message: "invalid api key" } }, 401),
  })
  await assert.rejects(
    () => indexer.query({ chainId: 1, contractAddress: CONTRACT, wallets: [WALLETS[0]] }),
    /Alchemy 持仓查询失败：invalid api key/,
  )
})
