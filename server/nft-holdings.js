// NFT holdings via an indexer. Chain enumeration needs one RPC round trip per token and
// falls apart entirely on contracts without ERC721Enumerable (the Transfer-log fallback
// requires an archive node, which public RPCs refuse). An indexer answers the same
// question in one request per wallet and hands back name and image for free, so the
// per-token tokenURI reads disappear too.
//
// Adapter is picked from whichever key is configured. Neither key present -> caller falls
// back to on-chain enumeration.

const ALCHEMY_NETWORKS = {
  1: "eth-mainnet",
  10: "opt-mainnet",
  56: "bnb-mainnet",
  137: "polygon-mainnet",
  4663: "robinhood-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
}

// Identifiers verified against GET /api/v2/chains rather than guessed — Polygon is
// "polygon", not the legacy "matic". Shared with the listing service, which posts orders
// to the same per-chain paths.
export const OPENSEA_CHAINS = {
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  4663: "robinhood",
  8453: "base",
  42161: "arbitrum",
}

const PAGE_LIMIT = 100
const MAX_PAGES = 50

function text(value) {
  return String(value ?? "").trim()
}

function httpsUrl(value, label) {
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS`)
  return url
}

async function readJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || body?.errors?.[0] || body?.message || `HTTP ${response.status}`
    const error = new Error(`${label}：${String(detail).slice(0, 200)}`)
    error.status = response.status
    throw error
  }
  return body
}

// Alchemy returns ownership and metadata together and filters by contract directly, so a
// wallet's holdings for one collection is a single paged call.
function alchemyAdapter({ apiKey, fetchImpl, timeoutMs }) {
  return {
    id: "alchemy",
    supports: (chainId) => Boolean(ALCHEMY_NETWORKS[Number(chainId)]),
    async holdings({ chainId, contractAddress, wallet }) {
      const network = ALCHEMY_NETWORKS[Number(chainId)]
      if (!network) throw new Error(`Alchemy 不支持链 ${chainId}`)
      const rows = []
      let pageKey = ""
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = httpsUrl(`https://${network}.g.alchemy.com/nft/v3/${encodeURIComponent(apiKey)}/getNFTsForOwner`, "Alchemy 接口")
        url.searchParams.set("owner", wallet.address)
        url.searchParams.append("contractAddresses[]", contractAddress)
        url.searchParams.set("withMetadata", "true")
        url.searchParams.set("pageSize", String(PAGE_LIMIT))
        if (pageKey) url.searchParams.set("pageKey", pageKey)
        const body = await readJson(await fetchImpl(url.toString(), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        }), "Alchemy 持仓查询失败")
        for (const item of body.ownedNfts || []) {
          const tokenId = text(item.tokenId)
          if (!tokenId) continue
          rows.push({
            tokenId: BigInt(tokenId).toString(),
            count: text(item.balance) || "1",
            standard: text(item.tokenType).toUpperCase() === "ERC1155" ? "ERC1155" : "ERC721",
            metadata: {
              imageUrl: text(item.image?.cachedUrl) || text(item.image?.originalUrl) || null,
              imageSource: "alchemy",
              tokenName: text(item.name) || text(item.raw?.metadata?.name),
              tokenUri: text(item.tokenUri) || text(item.raw?.tokenUri),
            },
          })
        }
        pageKey = text(body.pageKey)
        if (!pageKey) break
      }
      return rows
    },
  }
}

// OpenSea filters an account's NFTs by collection slug rather than contract address, so
// the contract has to be resolved to its slug once before the per-wallet calls.
function openseaAdapter({ apiKey, fetchImpl, timeoutMs }) {
  const slugs = new Map()
  // Wallets are queried in parallel, so cache the in-flight promise: caching the resolved
  // value lets every wallet race past an empty map and refetch the same slug.
  function collectionSlug(chainId, contractAddress) {
    const key = `${chainId}:${contractAddress.toLowerCase()}`
    if (slugs.has(key)) return slugs.get(key)
    const pending = (async () => {
      const chain = OPENSEA_CHAINS[Number(chainId)]
      const url = httpsUrl(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contractAddress}`, "OpenSea 接口")
      const body = await readJson(await fetchImpl(url.toString(), {
        headers: { accept: "application/json", "x-api-key": apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      }), "OpenSea 合约查询失败")
      const slug = text(body.collection)
      if (!slug) throw new Error("OpenSea 未返回该合约的 collection")
      return slug
    })().catch((error) => {
      slugs.delete(key)
      throw error
    })
    slugs.set(key, pending)
    return pending
  }
  return {
    id: "opensea",
    supports: (chainId) => Boolean(OPENSEA_CHAINS[Number(chainId)]),
    async holdings({ chainId, contractAddress, wallet }) {
      const chain = OPENSEA_CHAINS[Number(chainId)]
      if (!chain) throw new Error(`OpenSea 不支持链 ${chainId}`)
      const slug = await collectionSlug(chainId, contractAddress)
      const rows = []
      let cursor = ""
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = httpsUrl(`https://api.opensea.io/api/v2/chain/${chain}/account/${wallet.address}/nfts`, "OpenSea 接口")
        url.searchParams.set("collection", slug)
        url.searchParams.set("limit", String(PAGE_LIMIT))
        if (cursor) url.searchParams.set("next", cursor)
        const body = await readJson(await fetchImpl(url.toString(), {
          headers: { accept: "application/json", "x-api-key": apiKey },
          signal: AbortSignal.timeout(timeoutMs),
        }), "OpenSea 持仓查询失败")
        for (const item of body.nfts || []) {
          const tokenId = text(item.identifier)
          if (!tokenId) continue
          if (text(item.contract).toLowerCase() !== contractAddress.toLowerCase()) continue
          rows.push({
            tokenId: BigInt(tokenId).toString(),
            count: "1",
            standard: text(item.token_standard).toUpperCase() === "ERC1155" ? "ERC1155" : "ERC721",
            metadata: {
              imageUrl: text(item.display_image_url) || text(item.image_url) || null,
              imageSource: "opensea",
              tokenName: text(item.name),
              tokenUri: text(item.metadata_url),
            },
          })
        }
        cursor = text(body.next)
        if (!cursor) break
      }
      return rows
    },
  }
}

export function createNftHoldingsIndexer({ env = process.env, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const alchemyKey = text(env.ALCHEMY_API_KEY || env.NFT_INDEXER_ALCHEMY_KEY)
  const openseaKey = text(env.OPENSEA_API_KEY || env.NFT_INDEXER_OPENSEA_KEY)
  const adapters = []
  if (alchemyKey) adapters.push(alchemyAdapter({ apiKey: alchemyKey, fetchImpl, timeoutMs }))
  if (openseaKey) adapters.push(openseaAdapter({ apiKey: openseaKey, fetchImpl, timeoutMs }))

  function adaptersFor(chainId) {
    return adapters.filter((adapter) => adapter.supports(chainId))
  }

  return {
    get configured() {
      return adapters.length > 0
    },
    adapterFor: (chainId) => adaptersFor(chainId)[0] || null,
    adaptersFor,
    // Returns a holdings payload shaped exactly like queryContractHoldings so the route
    // can swap between the two, or null when no adapter covers this chain.
    //
    // Every covering adapter gets a turn: an Alchemy app with only some networks enabled
    // answers 403 for the rest, and that is a reason to try OpenSea, not to give up and
    // fall back to chain enumeration.
    async query({ chainId, contractAddress, wallets }) {
      const candidates = adaptersFor(chainId)
      if (!candidates.length) return null
      const failures = []
      for (const adapter of candidates) {
        try {
          return await collect(adapter, { chainId, contractAddress, wallets })
        } catch (error) {
          failures.push(`${adapter.id}: ${error.message}`)
        }
      }
      throw new Error(failures.join("；"))
    },
  }

  async function collect(adapter, { chainId, contractAddress, wallets }) {
    const perWallet = await Promise.all(wallets.map(async (wallet) => ({
      wallet,
      tokens: await adapter.holdings({ chainId, contractAddress, wallet }),
    })))
    const rows = []
    let standard = ""
    for (const { wallet, tokens } of perWallet) {
      for (const token of tokens) {
        standard ||= token.standard
        rows.push({
          id: `${wallet.id}:${token.tokenId}`,
          standard: token.standard,
          walletId: wallet.id,
          address: wallet.address,
          tokenId: token.tokenId,
          count: token.count,
          formatted: token.count,
          symbol: "NFT",
          metadata: token.metadata,
        })
      }
    }
    rows.sort((a, b) => a.walletId.localeCompare(b.walletId) || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1))
    const total = rows.reduce((sum, row) => sum + BigInt(row.count), 0n)
    return {
      contractAddress,
      walletCount: wallets.length,
      standard: standard || "ERC721",
      symbol: "NFT",
      decimals: 0,
      rows,
      totalCount: total.toString(),
      totalFormatted: total.toString(),
      coverageComplete: true,
      source: adapter.id,
      metadataPending: 0,
    }
  }
}
