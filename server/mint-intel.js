const CACHE_TTL_MS = 5 * 60 * 1000
const STATS_TTL_MS = 30 * 1000
const ABI_TTL_MS = 30 * 60 * 1000
const MARKET_TTL_MS = 30 * 60 * 1000
const MARKET_NEGATIVE_TTL_MS = 2 * 60 * 1000
const DEPLOYER_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_CACHE_ENTRIES = 2000

const OPENSEA_CHAIN_SLUGS = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  4663: "robinhood",
  8453: "base",
  42161: "arbitrum",
}

export const KNOWN_MINT_METHODS = new Map([
  ["0x161ac21f", "mintPublic"],
  ["0x4b61cd6f", "mintSigned"],
  ["0x4300a4e6", "mintAllowList"],
])

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function metadataTags(entity) {
  const tags = entity?.metadata?.tags
  if (!Array.isArray(tags)) return []
  return tags.map((tag) => ({
    name: String(tag?.name || "").trim(),
    type: String(tag?.tagType || "").trim().toLowerCase(),
    slug: String(tag?.slug || "").trim().toLowerCase(),
  })).filter((tag) => tag.name)
}

function platformTags(tags, text = "") {
  const candidates = [...tags.map((tag) => tag.name), text]
  const patterns = [
    ["Manifold", /manifold/i],
    ["Bueno", /bueno/i],
    ["Zora", /\bzora\b/i],
    ["Art Blocks", /art\s?blocks/i],
    ["OpenSea", /opensea/i],
    ["SeaDrop", /sea\s?drop/i],
    ["Thirdweb", /thirdweb/i],
    ["Foundation", /foundation/i],
  ]
  return patterns.filter(([, pattern]) => candidates.some((value) => pattern.test(value))).map(([label]) => label)
}

function fundingTags(tags) {
  const exchange = /coinbase|binance|okx|okex|kucoin|kraken|bybit|gate(?:\.io)?|mexc|crypto\.com/i
  return unique(tags.filter((tag) => tag.type === "cex" || tag.type === "exchange" || exchange.test(tag.name)).map((tag) => tag.name))
}

function statusTags(address, tags) {
  const values = []
  if (address?.is_scam || String(address?.reputation || "").toLowerCase() === "scam") values.push("风险标记")
  if (address?.is_verified) values.push("已验证")
  if (address?.proxy_type) values.push(String(address.proxy_type))
  const statusPattern = /deny|blacklist|blocklist|禁止|scam|phishing|spam|disabled|suspicious/i
  for (const tag of tags) if (statusPattern.test(`${tag.name} ${tag.slug}`)) values.push(tag.name)
  return unique(values)
}

function cached(cache, key, ttl) {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.checkedAt < ttl) return entry.value
  cache.delete(key)
  return undefined
}

function setCached(cache, key, entry, maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
  return entry
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      output[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return output
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return { body: await response.text(), finalUrl: response.url || String(url) }
}

function jsonString(value) {
  if (!value) return ""
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return String(value)
  }
}

function jsonLdBrands(body) {
  const values = []
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const match of body.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1])
      values.push(...(Array.isArray(parsed) ? parsed : [parsed]))
    } catch {
      // Ignore unrelated malformed JSON-LD blocks.
    }
  }
  return values.filter((value) => String(value?.["@type"] || "").toLowerCase() === "brand")
}

export function knownMintMethod(selector) {
  return KNOWN_MINT_METHODS.get(String(selector || "").toLowerCase()) || ""
}

export function createMintIntelService({ fetchImpl = fetch, blockscoutBases = {}, maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES } = {}) {
  const collectionCache = new Map()
  const collectionRequests = new Map()
  const methodCache = new Map()
  const methodRequests = new Map()
  const statsCache = new Map()
  const statsRequests = new Map()
  const abiCache = new Map()
  const abiRequests = new Map()
  const marketCache = new Map()
  const marketRequests = new Map()
  const deployerCache = new Map()
  const deployerRequests = new Map()

  async function collection(chainId, address) {
    const base = blockscoutBases[Number(chainId)]
    if (!base) return null
    const key = `${Number(chainId)}:${String(address).toLowerCase()}`
    const hit = cached(collectionCache, key, CACHE_TTL_MS)
    if (hit !== undefined) return hit
    if (collectionRequests.has(key)) return collectionRequests.get(key)
    const request = (async () => {
      try {
        const addressData = await fetchJson(fetchImpl, `${base}/api/v2/addresses/${address}`)
        let creation = null
        if (addressData.creation_transaction_hash) {
          creation = await fetchJson(fetchImpl, `${base}/api/v2/transactions/${addressData.creation_transaction_hash}`).catch(() => null)
        }
        const contractTags = unique([
          ...metadataTags(addressData).map((tag) => tag.name),
          ...metadataTags(creation?.created_contract).map((tag) => tag.name),
        ])
        const creatorTags = metadataTags(creation?.from)
        const allTags = [...metadataTags(addressData), ...metadataTags(creation?.created_contract)]
        const value = {
          contractCreatedAt: creation?.timestamp || null,
          contractCreatedBlock: creation?.block_number == null ? null : String(creation.block_number),
          creatorAddress: addressData.creator_address_hash || creation?.from?.hash || "",
          fundingTags: fundingTags(creatorTags),
          platformTags: platformTags(allTags, `${addressData.name || ""} ${contractTags.join(" ")}`),
          statusTags: statusTags(addressData, allTags),
        }
        setCached(collectionCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } catch {
        setCached(collectionCache, key, { checkedAt: Date.now(), value: null }, maxCacheEntries)
        return null
      } finally {
        collectionRequests.delete(key)
      }
    })()
    collectionRequests.set(key, request)
    return request
  }

  async function method({ chainId, selector, txHash, target }) {
    const normalized = String(selector || "").toLowerCase()
    const builtIn = knownMintMethod(normalized)
    const base = blockscoutBases[Number(chainId)]
    if (!base || !txHash) return { methodName: builtIn, platformTags: builtIn ? ["SeaDrop"] : [] }
    const key = `${Number(chainId)}:${String(target || "").toLowerCase()}:${normalized}`
    const hit = cached(methodCache, key, CACHE_TTL_MS)
    if (hit !== undefined) return hit
    if (methodRequests.has(key)) return methodRequests.get(key)
    const request = (async () => {
      try {
        const transaction = await fetchJson(fetchImpl, `${base}/api/v2/transactions/${txHash}`)
        const decoded = String(transaction?.decoded_input?.method_call || "").split("(")[0]
        const methodName = String(transaction?.method || decoded || builtIn || "").trim()
        const tags = metadataTags(transaction?.to)
        const value = {
          methodName,
          platformTags: unique([
            ...(builtIn ? ["SeaDrop"] : []),
            ...platformTags(tags, `${transaction?.to?.name || ""} ${methodName}`),
          ]),
        }
        setCached(methodCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } catch {
        const value = { methodName: builtIn, platformTags: builtIn ? ["SeaDrop"] : [] }
        setCached(methodCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } finally {
        methodRequests.delete(key)
      }
    })()
    methodRequests.set(key, request)
    return request
  }

  async function contractAbi(chainId, address) {
    const base = blockscoutBases[Number(chainId)]
    if (!base) return null
    const key = `${Number(chainId)}:${String(address).toLowerCase()}`
    const hit = cached(abiCache, key, ABI_TTL_MS)
    if (hit !== undefined) return hit
    if (abiRequests.has(key)) return abiRequests.get(key)
    const request = (async () => {
      try {
        const payload = await fetchJson(fetchImpl, `${base}/api/v2/smart-contracts/${address}`)
        const value = Array.isArray(payload?.abi) ? payload.abi : null
        setCached(abiCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } catch {
        setCached(abiCache, key, { checkedAt: Date.now(), value: null }, maxCacheEntries)
        return null
      } finally {
        abiRequests.delete(key)
      }
    })()
    abiRequests.set(key, request)
    return request
  }

  async function deployerProfile(chainId, address) {
    const id = Number(chainId)
    const normalizedAddress = String(address || "").toLowerCase()
    const base = blockscoutBases[id]
    if (!base || !/^0x[a-f0-9]{40}$/.test(normalizedAddress)) return null
    const key = `${id}:${normalizedAddress}`
    const hit = cached(deployerCache, key, DEPLOYER_TTL_MS)
    if (hit !== undefined) return hit
    if (deployerRequests.has(key)) return deployerRequests.get(key)
    const request = (async () => {
      try {
        const url = new URL("/api", base)
        Object.entries({
          module: "account",
          action: "txlist",
          address: normalizedAddress,
          startblock: "0",
          endblock: "99999999",
          page: "1",
          offset: "1000",
          sort: "asc",
        }).forEach(([name, value]) => url.searchParams.set(name, value))
        const payload = await fetchJson(fetchImpl, url.toString())
        const transactions = Array.isArray(payload?.result) ? payload.result : []
        const firstTimestamp = transactions.map((item) => Number(item.timeStamp ?? item.timestamp)).find((value) => Number.isFinite(value) && value > 0)
        const contracts = unique(transactions.map((item) => (
          item.contractAddress || item.created_contract?.hash || item.createdContract?.hash || ""
        )).map((value) => String(value).toLowerCase()).filter((value) => /^0x[a-f0-9]{40}$/.test(value))).slice(0, 50)
        const nftMatches = await mapConcurrent(contracts, 4, async (contract) => {
          try {
            const token = await fetchJson(fetchImpl, `${base}/api/v2/tokens/${contract}`)
            return /^ERC-?(?:721|1155)$/i.test(String(token?.type || token?.token_type || ""))
          } catch {
            return false
          }
        })
        const value = {
          chainId: id,
          address: normalizedAddress,
          firstSeenAt: firstTimestamp ? new Date(firstTimestamp * 1000).toISOString() : null,
          deployedContractCount: contracts.length,
          nftProjectCount: nftMatches.filter(Boolean).length,
        }
        setCached(deployerCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } catch {
        setCached(deployerCache, key, { checkedAt: Date.now(), value: null }, maxCacheEntries)
        return null
      } finally {
        deployerRequests.delete(key)
      }
    })()
    deployerRequests.set(key, request)
    return request
  }

  async function marketCollection(chainId, address) {
    const chainSlug = OPENSEA_CHAIN_SLUGS[Number(chainId)]
    const normalizedAddress = String(address || "").toLowerCase()
    if (!chainSlug || !/^0x[a-f0-9]{40}$/.test(normalizedAddress)) return null
    const key = `${Number(chainId)}:${normalizedAddress}`
    const existing = marketCache.get(key)
    if (existing && Date.now() - existing.checkedAt < (existing.value ? MARKET_TTL_MS : MARKET_NEGATIVE_TTL_MS)) return existing.value
    if (marketRequests.has(key)) return marketRequests.get(key)
    const request = (async () => {
      try {
        const assetUrl = `https://opensea.io/assets/${chainSlug}/${normalizedAddress}`
        const { body, finalUrl } = await fetchText(fetchImpl, assetUrl)
        const parsedUrl = new URL(finalUrl)
        const pathMatch = /^\/collection\/([^/]+)/.exec(parsedUrl.pathname)
        const bodyLower = body.toLowerCase()
        const addressMarker = `"address":"${normalizedAddress}"`
        const chainMarker = `"identifier":"${chainSlug}"`
        if (parsedUrl.hostname !== "opensea.io" || !pathMatch || !bodyLower.includes(addressMarker) || !bodyLower.includes(chainMarker)) {
          throw new Error("OpenSea 合集页面与链上合约不匹配")
        }
        const openseaUrl = `https://opensea.io/collection/${pathMatch[1]}`
        const brand = jsonLdBrands(body).find((value) => String(value.url || "").replace(/\/$/, "") === openseaUrl) || jsonLdBrands(body)[0]
        const markerIndex = bodyLower.indexOf(addressMarker)
        const context = markerIndex >= 0 ? body.slice(Math.max(0, markerIndex - 4000), markerIndex + 1200) : ""
        const externalUrl = jsonString(/"externalUrl":"((?:\\.|[^"\\])*)"/.exec(context)?.[1] || "")
        const twitterUsername = jsonString(/"twitterUsername":"((?:\\.|[^"\\])*)"/.exec(context)?.[1] || "")
        const discordUrl = jsonString(/"discordUrl":"((?:\\.|[^"\\])*)"/.exec(context)?.[1] || "")
        const value = {
          verified: true,
          openseaUrl,
          imageUrl: typeof brand?.image === "string" ? brand.image : "",
          name: typeof brand?.name === "string" ? brand.name : "",
          website: externalUrl,
          twitter: twitterUsername ? `https://x.com/${twitterUsername.replace(/^@/, "")}` : "",
          discordUrl,
        }
        setCached(marketCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } catch {
        setCached(marketCache, key, { checkedAt: Date.now(), value: null }, maxCacheEntries)
        return null
      } finally {
        marketRequests.delete(key)
      }
    })()
    marketRequests.set(key, request)
    return request
  }

  async function stats(chainId) {
    const base = blockscoutBases[Number(chainId)]
    if (!base) return null
    const key = String(Number(chainId))
    const hit = cached(statsCache, key, STATS_TTL_MS)
    if (hit !== undefined) return hit
    if (statsRequests.has(key)) return statsRequests.get(key)
    const request = (async () => {
      try {
        const payload = await fetchJson(fetchImpl, `${base}/api/v2/stats`)
        const value = {
          coinPriceUsd: payload.coin_price == null ? null : String(payload.coin_price),
          explorerGasGwei: payload.gas_prices || null,
        }
        setCached(statsCache, key, { checkedAt: Date.now(), value }, maxCacheEntries)
        return value
      } catch {
        setCached(statsCache, key, { checkedAt: Date.now(), value: null }, maxCacheEntries)
        return null
      } finally {
        statsRequests.delete(key)
      }
    })()
    statsRequests.set(key, request)
    return request
  }

  return { collection, contractAbi, deployerProfile, marketCollection, method, stats }
}
