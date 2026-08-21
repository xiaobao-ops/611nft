import { randomBytes, randomUUID } from "node:crypto"
import { encodeFunctionData, getAddress, parseAbi, parseEther } from "viem"
import { OPENSEA_CHAINS } from "./nft-holdings.js"
import {
  buildListingOrder,
  listingPostBody,
  listingTypedData,
  OPENSEA_CONDUIT_KEY,
  SEAPORT_1_6,
  splitListingPrice,
  ZERO_BYTES32,
} from "./seaport-order.js"

const SEAPORT_ABI = parseAbi(["function getCounter(address offerer) view returns (uint256)"])
const OPENSEA_API = "https://api.opensea.io"

const NFT_ABI = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
])

const ERC721_INTERFACE = "0x80ac58cd"
const ERC1155_INTERFACE = "0xd9b67a26"

const OPENSEA_CONDUIT = "0x1E0049783F008A0085193E00003D00cd54003c71"
// Robinhood Chain runs its own OpenSea conduit. The API rejects any other conduit key
// with "please use OpenSea's conduit key: 0x61159fef…", and ConduitController resolves
// that key to 0x963F…C300, which is deployed. Neither the mainnet conduit (no code here)
// nor conduitKey zero is accepted, so both the key and the approval target differ per chain.
const ROBINHOOD_OPENSEA_CONDUIT_KEY = "0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e"
const ROBINHOOD_OPENSEA_CONDUIT = "0x963F00d3ff000064fFCbA824b800c0000000C300"

const MARKETPLACES = {
  opensea: {
    id: "opensea",
    label: "OpenSea",
    source: "opensea.io",
    orderbook: "opensea",
    orderKind: "seaport-v1.6",
    // Listing goes straight to OpenSea's own API, so this platform needs OPENSEA_API_KEY
    // rather than the (now dead) Reservoir-compatible router.
    backend: "opensea-api",
    chainIds: [1, 10, 137, 4663, 8453, 42161],
    conduitKey: OPENSEA_CONDUIT_KEY,
    conduitKeyByChain: {
      4663: ROBINHOOD_OPENSEA_CONDUIT_KEY,
    },
    operators: {
      ERC721: OPENSEA_CONDUIT,
      ERC1155: OPENSEA_CONDUIT,
    },
    // The address that needs setApprovalForAll is whatever conduit the chain's conduitKey
    // resolves to — on Robinhood that is 0x963F…C300, not the mainnet conduit.
    operatorsByChain: {
      4663: { ERC721: ROBINHOOD_OPENSEA_CONDUIT, ERC1155: ROBINHOOD_OPENSEA_CONDUIT },
    },
  },
  x2y2: {
    id: "x2y2",
    label: "X2Y2",
    source: "x2y2.io",
    orderbook: "x2y2",
    orderKind: "x2y2",
    backend: "router",
    chainIds: [1],
    operators: {
      ERC721: "0xf849de01B080adc3A814Fabe1E2087475cf2E354",
      ERC1155: "0x024ac22ACd51B3D7A5a7f3EA25c4C870a9F51a1C",
    },
  },
  blur: {
    id: "blur",
    label: "Blur",
    source: "blur.io",
    orderbook: "blur",
    orderKind: "blur",
    backend: "router",
    chainIds: [1],
    operators: {
      ERC721: "0x00000000000111AbE46ff893f3B2fdF1F759a8A8",
    },
  },
}

function operatorsFor(item, chainId) {
  return item.operatorsByChain?.[Number(chainId)] || item.operators
}

function conduitKeyFor(item, chainId, env = process.env) {
  const override = String(env[`NFT_${item.id.toUpperCase()}_CONDUIT_KEY_${Number(chainId)}`] || "").trim()
  if (override) return override
  return item.conduitKeyByChain?.[Number(chainId)] || item.conduitKey || ZERO_BYTES32
}

function address(value, label) {
  try {
    return getAddress(String(value || ""))
  } catch {
    throw new Error(`${label}无效`)
  }
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}无效`)
  return parsed
}

function envKey(id, chainId, standard) {
  return `NFT_${id.toUpperCase()}_OPERATOR_${chainId}_${standard}`
}

function marketplace(id, chainId, standard, env = process.env) {
  const value = MARKETPLACES[String(id || "").toLowerCase()]
  if (!value) throw new Error(`不支持的挂单平台：${id}`)
  if (!value.chainIds.includes(Number(chainId))) throw new Error(`${value.label} 暂不支持当前链`)
  const configured = env[envKey(value.id, chainId, standard)] || env[`NFT_${value.id.toUpperCase()}_OPERATOR_${chainId}`]
  const operator = address(configured || operatorsFor(value, chainId)[standard], `${value.label} ${standard} 授权地址`)
  return { ...value, operator, conduitKey: conduitKeyFor(value, chainId, env) }
}

// Each platform has its own backend, so one being unreachable must not take the others
// down with it: OpenSea posts orders to its own API, the rest need a Reservoir-compatible
// router that no longer has a working public deployment.
export function marketplaceBackendStatus(backend, chainId, env = process.env) {
  if (backend === "opensea-api") {
    const key = String(env.OPENSEA_API_KEY || env.NFT_INDEXER_OPENSEA_KEY || "").trim()
    return key
      ? { available: true, reason: "" }
      : { available: false, reason: "OpenSea 挂单需要 API Key：请在 .env 配置 OPENSEA_API_KEY。" }
  }
  return listingRouterStatus(chainId, env)
}

export function nftMarketplaceCatalog(chainId, env = process.env) {
  const id = Number(chainId)
  return Object.values(MARKETPLACES).map((item) => {
    const chainSupported = item.chainIds.includes(id)
    const backend = marketplaceBackendStatus(item.backend, id, env)
    return {
      id: item.id,
      label: item.label,
      supported: chainSupported && backend.available,
      chainSupported,
      backend: item.backend,
      unavailableReason: chainSupported ? backend.reason : `${item.label} 暂不支持当前链`,
      source: item.source,
      operators: Object.fromEntries(Object.entries(operatorsFor(item, id)).map(([standard, fallback]) => [
        standard,
        env[envKey(item.id, id, standard)] || env[`NFT_${item.id.toUpperCase()}_OPERATOR_${id}`] || fallback,
      ])),
    }
  })
}

export async function detectNftStandard(client, contractAddress) {
  const contract = address(contractAddress, "NFT 合约地址")
  const supports = async (interfaceId) => Boolean(await client.readContract({
    address: contract,
    abi: NFT_ABI,
    functionName: "supportsInterface",
    args: [interfaceId],
  }).catch(() => false))
  if (await supports(ERC1155_INTERFACE)) return "ERC1155"
  if (await supports(ERC721_INTERFACE)) return "ERC721"
  throw new Error("合约未识别为 ERC721 或 ERC1155")
}

export async function buildNftApprovalPlan({
  client,
  chainId,
  contractAddress,
  wallets,
  marketplaceId,
  approved = true,
  standard = "",
  env = process.env,
}) {
  if (!Array.isArray(wallets) || !wallets.length) throw new Error("请至少选择一个钱包")
  const contract = address(contractAddress, "NFT 合约地址")
  const tokenStandard = standard || await detectNftStandard(client, contract)
  const market = marketplace(marketplaceId, chainId, tokenStandard, env)
  const targetState = Boolean(approved)
  const rows = await Promise.all(wallets.map(async (wallet) => {
    const owner = address(wallet.address, `钱包 ${wallet.id} 地址`)
    const current = Boolean(await client.readContract({
      address: contract,
      abi: NFT_ABI,
      functionName: "isApprovedForAll",
      args: [owner, market.operator],
    }))
    return { walletId: wallet.id, address: owner, current, target: targetState, changed: current !== targetState }
  }))
  const data = encodeFunctionData({
    abi: NFT_ABI,
    functionName: "setApprovalForAll",
    args: [market.operator, targetState],
  })
  const entries = rows.filter((row) => row.changed).map((row) => ({
    walletId: row.walletId,
    to: contract,
    valueWei: "0",
    data,
    marketplace: market.id,
    operator: market.operator,
    standard: tokenStandard,
    summary: `${row.walletId} ${targetState ? "授权" : "撤销"} ${market.label} 操作 ${tokenStandard}`,
  }))
  return {
    chainId: Number(chainId),
    contractAddress: contract,
    standard: tokenStandard,
    marketplace: { id: market.id, label: market.label, operator: market.operator },
    approved: targetState,
    rows,
    entries,
  }
}

// api.reservoir.tools was shut down (docs.reservoir.tools now redirects to
// docs.relay.link), so there is no working default any more. Requiring an explicit
// endpoint turns a 20s hang plus an opaque TLS error into an immediate, actionable one.
function configuredRouter(chainId, env) {
  return String(env[`NFT_LISTING_ROUTER_URL_${Number(chainId)}`] || env.NFT_LISTING_ROUTER_URL || "").trim()
}

export function listingRouterStatus(chainId, env = process.env) {
  const configured = configuredRouter(chainId, env)
  if (!configured) {
    return {
      available: false,
      reason: "挂单路由未配置：原有的 api.reservoir.tools 已停止服务。请在 .env 配置 NFT_LISTING_ROUTER_URL 指向可用的 Reservoir 兼容路由，或改用 OpenSea 直连挂单。",
    }
  }
  try {
    const parsed = new URL(configured)
    if (parsed.protocol !== "https:") return { available: false, reason: "NFT 挂单路由必须使用 HTTPS" }
    return { available: true, reason: "", origin: parsed.origin }
  } catch {
    return { available: false, reason: `NFT 挂单路由地址无效：${configured}` }
  }
}

function routerUrl(chainId, env) {
  const status = listingRouterStatus(chainId, env)
  if (!status.available) throw new Error(status.reason)
  return status.origin
}

function routerHeaders(env) {
  const headers = { "content-type": "application/json", accept: "application/json" }
  const apiKey = String(env.RESERVOIR_API_KEY || env.NFT_LISTING_ROUTER_API_KEY || "").trim()
  if (apiKey) headers["x-api-key"] = apiKey
  return headers
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    // OpenSea reports validation problems as {"errors": ["..."]}; without this the caller
    // only ever sees "HTTP 400" and has no idea which field the order got wrong.
    const message = body?.errors?.[0] || body?.message || body?.error || `${label} HTTP ${response.status}`
    throw new Error(String(message))
  }
  return body
}

function executionItems(payload) {
  return (payload?.steps || []).flatMap((step) => (step.items || []).map((item) => ({
    ...item,
    stepId: step.id || step.kind || "",
    stepKind: step.kind || "",
  })))
}

function executionSummary(groups) {
  const items = groups.flatMap((group) => executionItems(group.execution))
  const incomplete = items.filter((item) => item.status !== "complete")
  const transactions = incomplete.filter((item) => item.data?.to && item.data?.data)
  const signatures = incomplete.filter((item) => item.data?.sign)
  const posts = incomplete.filter((item) => item.data?.post)
  return {
    transactionCount: transactions.length,
    signatureCount: signatures.length,
    postCount: posts.length,
    requiresApproval: transactions.length > 0,
    ready: transactions.length === 0 && signatures.length > 0,
    requirements: transactions.map((item) => ({
      step: item.stepId,
      to: item.data.to,
      description: item.data?.description || item.stepId || "链上授权",
    })),
  }
}

function listingRows({ rows, prices, amounts, marketplaceId, standard }) {
  return rows.map((row) => {
    if (row.tokenId === null || row.tokenId === undefined) throw new Error("挂单只支持 NFT 持仓")
    const price = String(prices?.[row.id] || "").trim()
    let weiPrice
    try {
      weiPrice = parseEther(price)
    } catch {
      throw new Error(`Token #${row.tokenId} 的挂单价格无效`)
    }
    if (weiPrice <= 0n) throw new Error(`Token #${row.tokenId} 的挂单价格必须大于 0`)
    const available = BigInt(row.count || "0")
    const amount = standard === "ERC1155" ? BigInt(amounts?.[row.id] || "1") : 1n
    if (amount <= 0n || amount > available) throw new Error(`Token #${row.tokenId} 的挂单数量超出真实持仓`)
    return {
      holdingId: row.id,
      walletId: row.walletId,
      owner: address(row.address, `钱包 ${row.walletId} 地址`),
      contractAddress: address(row.contractAddress, "NFT 合约地址"),
      tokenId: BigInt(row.tokenId).toString(),
      standard,
      amount: amount.toString(),
      marketplace: marketplaceId,
      price,
      weiPrice: weiPrice.toString(),
    }
  })
}

function publicPreview(job) {
  return {
    id: job.id,
    status: job.status,
    chainId: job.chainId,
    marketplace: job.marketplace,
    contractAddress: job.contractAddress,
    standard: job.standard,
    durationSeconds: job.durationSeconds,
    rows: job.rows,
    summary: job.summary,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    ...(job.status === "previewed" ? { confirmation: { previewId: job.id, confirmationToken: job.confirmationToken, expiresAt: job.expiresAt } } : {}),
    ...(job.results ? { results: job.results } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function insertSignature(body, signature) {
  let inserted = false
  const visit = (value) => {
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === "signature" && (!child || String(child).startsWith("<"))) {
        value[key] = signature
        inserted = true
      } else visit(child)
    }
  }
  visit(body)
  if (!inserted && body?.order?.data && typeof body.order.data === "object") body.order.data.signature = signature
  else if (!inserted && body?.order && typeof body.order === "object") body.order.signature = signature
  else if (!inserted) body.signature = signature
  return body
}

function typedData(sign) {
  const types = { ...(sign.types || {}) }
  delete types.EIP712Domain
  return {
    domain: sign.domain || {},
    types,
    primaryType: sign.primaryType,
    message: sign.value || sign.message || {},
  }
}

function assertPostEndpoint(value, baseOrigin) {
  const endpoint = new URL(value)
  const base = new URL(baseOrigin)
  const reservoir = endpoint.hostname === "reservoir.tools" || endpoint.hostname.endsWith(".reservoir.tools")
  if (endpoint.protocol !== "https:" || (!reservoir && endpoint.origin !== base.origin)) {
    throw new Error("挂单路由返回了未受信任的提交地址")
  }
  return endpoint.toString()
}

function collectOrderIds(value, output = new Set(), depth = 0) {
  if (!value || depth > 8) return output
  if (Array.isArray(value)) {
    value.forEach((item) => collectOrderIds(item, output, depth + 1))
    return output
  }
  if (typeof value !== "object") return output
  for (const [key, child] of Object.entries(value)) {
    if (["orderid", "order_id", "orderhash", "order_hash"].includes(key.toLowerCase()) && typeof child === "string") output.add(child)
    else collectOrderIds(child, output, depth + 1)
  }
  return output
}

function openseaKey(env) {
  return String(env.OPENSEA_API_KEY || env.NFT_INDEXER_OPENSEA_KEY || "").trim()
}

// Listing state must come from OpenSea, not from whatever the browser happens to still
// hold in memory: a preview object dies on the next query, a page switch or a restart,
// while the order itself lives on until it sells or expires. Reading it back also shows
// listings made anywhere else.
export async function fetchActiveListings({
  chainId,
  contractAddress,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maxPages = 20,
}) {
  const key = openseaKey(env)
  const chain = OPENSEA_CHAINS[Number(chainId)]
  if (!key || !chain) return new Map()
  const contract = String(contractAddress).toLowerCase()
  const headers = { accept: "application/json", "x-api-key": key }
  const call = async (path) => responseJson(
    await fetchImpl(`${OPENSEA_API}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) }),
    "OpenSea 挂单查询失败",
  )

  const info = await call(`/api/v2/chain/${chain}/contract/${contractAddress}`)
  const slug = String(info.collection || "").trim()
  if (!slug) return new Map()

  const listings = new Map()
  let cursor = ""
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: "100" })
    if (cursor) query.set("next", cursor)
    const body = await call(`/api/v2/listings/collection/${encodeURIComponent(slug)}/all?${query}`)
    for (const listing of body.listings || []) {
      const params = listing.protocol_data?.parameters
      const offer = params?.offer?.[0]
      if (!params?.offerer || !offer) continue
      if (String(offer.token || "").toLowerCase() !== contract) continue
      const tokenId = String(offer.identifierOrCriteria)
      const entry = {
        orderHash: listing.order_hash || "",
        offerer: params.offerer,
        tokenId,
        priceWei: String(listing.price?.current?.value || "0"),
        currency: listing.price?.current?.currency || "ETH",
        endTime: Number(params.endTime || 0),
      }
      // Several listings can exist for one token; the one that matters is the cheapest.
      const mapKey = `${String(params.offerer).toLowerCase()}:${tokenId}`
      const existing = listings.get(mapKey)
      if (!existing || BigInt(entry.priceWei) < BigInt(existing.priceWei)) listings.set(mapKey, entry)
    }
    cursor = String(body.next || "")
    if (!cursor) break
  }
  return listings
}

export function attachListingState(holdings, listings) {
  if (!listings?.size) return holdings
  let listed = 0
  const rows = holdings.rows.map((row) => {
    const entry = listings.get(`${String(row.address).toLowerCase()}:${String(row.tokenId)}`)
    if (!entry) return row
    listed += 1
    return { ...row, listing: entry }
  })
  return { ...holdings, rows, listedCount: listed }
}

export function createNftListingService({
  fetchImpl = fetch,
  accountForWallet,
  clientForChain,
  env = process.env,
  clock = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
} = {}) {
  if (typeof accountForWallet !== "function") throw new TypeError("accountForWallet is required")
  const jobs = new Map()
  const slugCache = new Map()

  function openseaHeaders() {
    const key = openseaKey(env)
    if (!key) throw new Error("OpenSea 挂单需要 API Key：请在 .env 配置 OPENSEA_API_KEY。")
    return { "content-type": "application/json", accept: "application/json", "x-api-key": key }
  }

  function openseaChain(chainId) {
    const slug = OPENSEA_CHAINS[Number(chainId)]
    if (!slug) throw new Error(`OpenSea 不支持链 ${chainId}`)
    return slug
  }

  async function openseaJson(path, label, init = {}) {
    const response = await fetchImpl(`${OPENSEA_API}${path}`, {
      headers: openseaHeaders(),
      signal: AbortSignal.timeout(20_000),
      ...init,
    })
    return responseJson(response, label)
  }

  // Fees are per collection and cannot be assumed: surveyed collections range from no
  // creator fee at all to 10%, and about half mark theirs optional. Always read them.
  function collectionOf(chainId, contract) {
    const key = `${chainId}:${contract.toLowerCase()}`
    if (slugCache.has(key)) return slugCache.get(key)
    const pending = (async () => {
      const contractInfo = await openseaJson(`/api/v2/chain/${openseaChain(chainId)}/contract/${contract}`, "OpenSea 合约查询失败")
      const slug = String(contractInfo.collection || "").trim()
      if (!slug) throw new Error("OpenSea 未收录该合约，无法挂单")
      const collection = await openseaJson(`/api/v2/collections/${encodeURIComponent(slug)}`, "OpenSea 合集查询失败")
      return { slug, fees: collection.fees || [] }
    })().catch((error) => {
      slugCache.delete(key)
      throw error
    })
    slugCache.set(key, pending)
    return pending
  }

  async function previewOpenSea({ chain, contract, standard, market, grouped, duration, normalizedRows }) {
    const client = clientForChain?.(chain)
    if (!client) throw new Error("挂单预览需要链上 RPC 客户端")
    const { slug, fees } = await collectionOf(chain, contract)
    const includeOptionalFees = String(env.NFT_LISTING_PAY_OPTIONAL_ROYALTY || "").trim() === "true"
    // Configured per chain rather than inferred: OpenSea rejects any key but the one it
    // runs on that chain, and the approval target is whatever that key resolves to.
    const conduitKey = market.conduitKey
    const startTime = Math.floor(clock() / 1000)
    const endTime = startTime + duration

    // Each wallet needs its own counter and approval read; they are independent.
    const groups = await Promise.all([...grouped].map(async ([walletId, walletRows]) => {
      const offerer = walletRows[0].owner
      const [counter, approved] = await Promise.all([
        client.readContract({ address: SEAPORT_1_6, abi: SEAPORT_ABI, functionName: "getCounter", args: [offerer] }),
        client.readContract({ address: contract, abi: NFT_ABI, functionName: "isApprovedForAll", args: [offerer, market.operator] }),
      ])
      const orders = walletRows.map((row) => {
        const split = splitListingPrice({ weiPrice: row.weiPrice, fees, seller: offerer, includeOptionalFees })
        return {
          holdingId: row.holdingId,
          tokenId: row.tokenId,
          order: buildListingOrder({
            offerer,
            contractAddress: contract,
            tokenId: row.tokenId,
            standard,
            amount: BigInt(row.amount),
            weiPrice: row.weiPrice,
            fees,
            startTime,
            endTime,
            salt: BigInt(`0x${randomBytes(24).toString("hex")}`),
            counter,
            conduitKey,
            includeOptionalFees,
          }),
          proceeds: {
            price: row.weiPrice,
            seller: split.seller.amount.toString(),
            fees: split.fees.map((fee) => ({ recipient: fee.recipient, amount: fee.amount.toString(), basisPoints: Number(fee.basisPoints), required: fee.required })),
            skippedOptionalFees: split.skippedOptionalFees.map((fee) => ({ recipient: fee.recipient, amount: fee.amount.toString(), basisPoints: Number(fee.basisPoints) })),
          },
        }
      })
      return { walletId, offerer, rows: walletRows, orders, approved: Boolean(approved) }
    }))

    const unapproved = groups.filter((group) => !group.approved)
    const signatureCount = groups.reduce((sum, group) => sum + group.orders.length, 0)
    return {
      collectionSlug: slug,
      fees,
      conduitKey,
      groups,
      summary: {
        transactionCount: unapproved.length,
        signatureCount,
        postCount: signatureCount,
        requiresApproval: unapproved.length > 0,
        ready: unapproved.length === 0 && signatureCount > 0,
        requirements: unapproved.map((group) => ({
          step: "nft-approval",
          to: contract,
          description: `钱包 ${group.walletId} 尚未授权 ${market.label} 操作 ${standard}`,
        })),
        // Surfaced so the seller sees the split before signing rather than after.
        proceeds: normalizedRows.length
          ? groups.flatMap((group) => group.orders.map((entry) => ({ holdingId: entry.holdingId, ...entry.proceeds })))
          : [],
      },
    }
  }

  async function submitOpenSea(job) {
    const results = []
    for (const group of job.groups) {
      const account = accountForWallet(group.walletId)
      if (!account) throw new Error(`钱包 ${group.walletId} 的本地签名器不可用`)
      for (const entry of group.orders) {
        const signature = await account.signTypedData(listingTypedData({ chainId: job.chainId, order: entry.order }))
        const payload = await openseaJson(`/api/v2/orders/${openseaChain(job.chainId)}/seaport/listings`, `${job.marketplace.label} 订单提交`, {
          method: "POST",
          body: JSON.stringify(listingPostBody({ order: entry.order, signature })),
        })
        results.push({
          walletId: group.walletId,
          ok: true,
          step: "seaport-listing",
          holdingId: entry.holdingId,
          tokenId: entry.tokenId,
          orderIds: [...collectOrderIds(payload)],
        })
      }
    }
    return results
  }

  function cleanup() {
    for (const [id, job] of jobs) if (job.expiresAtMs < clock() && job.status === "previewed") jobs.delete(id)
  }

  async function preview({ chainId, contractAddress, standard, rows, prices, amounts, marketplaceId, durationSeconds }) {
    cleanup()
    const chain = integer(chainId, "链 ID", { min: 1 })
    const contract = address(contractAddress, "NFT 合约地址")
    const market = marketplace(marketplaceId, chain, standard, env)
    const duration = integer(durationSeconds, "挂单有效期", { min: 60, max: 365 * 24 * 60 * 60 })
    if (!Array.isArray(rows) || !rows.length) throw new Error("请至少选择一个 NFT")
    const normalizedRows = listingRows({ rows: rows.map((row) => ({ ...row, contractAddress: contract })), prices, amounts, marketplaceId: market.id, standard })
    const grouped = new Map()
    for (const row of normalizedRows) {
      if (!accountForWallet(row.walletId)) throw new Error(`钱包 ${row.walletId} 不支持本地 EIP-712 挂单签名`)
      const values = grouped.get(row.walletId) || []
      values.push(row)
      grouped.set(row.walletId, values)
    }

    const openSea = market.backend === "opensea-api"
    const built = openSea
      ? await previewOpenSea({ chain, contract, standard, market, grouped, duration, normalizedRows })
      : await previewRouter({ chain, contract, market, grouped, duration })

    const createdAt = new Date(clock()).toISOString()
    const expiresAtMs = clock() + ttlMs
    const job = {
      id: randomUUID(),
      status: "previewed",
      backend: market.backend,
      chainId: chain,
      marketplace: { id: market.id, label: market.label, source: market.source },
      contractAddress: contract,
      standard,
      durationSeconds: duration,
      rows: normalizedRows,
      groups: built.groups,
      summary: built.summary,
      base: built.base,
      collectionSlug: built.collectionSlug,
      confirmationToken: randomBytes(24).toString("hex"),
      createdAt,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    jobs.set(job.id, job)
    return publicPreview(job)
  }

  async function previewRouter({ chain, contract, market, grouped, duration }) {
    const base = routerUrl(chain, env)
    const expirationTime = String(Math.floor(clock() / 1000) + duration)
    // Each wallet is an independent call to the router; serial made N wallets take N x 20s.
    const groups = await Promise.all([...grouped].map(async ([walletId, walletRows]) => {
      const response = await fetchImpl(`${base}/execute/list/v5`, {
        method: "POST",
        headers: routerHeaders(env),
        body: JSON.stringify({
          maker: walletRows[0].owner,
          source: market.source,
          params: walletRows.map((row) => ({
            token: `${contract}:${row.tokenId}`,
            weiPrice: row.weiPrice,
            quantity: row.amount,
            orderbook: market.orderbook,
            orderKind: market.orderKind,
            expirationTime,
          })),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      return { walletId, rows: walletRows, execution: await responseJson(response, `${market.label} 挂单预览`) }
    }))
    return { base, groups, summary: executionSummary(groups) }
  }

  async function submit({ previewId, confirmationToken }) {
    cleanup()
    const job = jobs.get(String(previewId || ""))
    if (!job) throw new Error("挂单预览不存在或已过期")
    if (job.status !== "previewed") throw new Error("挂单预览已被使用")
    const provided = Buffer.from(String(confirmationToken || ""))
    const expected = Buffer.from(job.confirmationToken)
    if (provided.length !== expected.length || !cryptoTimingSafeEqual(provided, expected)) throw new Error("挂单确认令牌无效")
    if (job.summary.requiresApproval) throw new Error("检测到链上授权步骤，请先完成批量授权后重新生成挂单预览")
    if (!job.summary.ready) throw new Error("挂单路由没有返回可签名订单")
    job.status = "submitting"
    delete job.confirmationToken
    let results = []
    try {
      results = job.backend === "opensea-api" ? await submitOpenSea(job) : await submitRouter(job, results)
      job.status = "submitted"
      job.results = results
      return publicPreview(job)
    } catch (error) {
      job.status = results.length ? "partial" : "failed"
      job.results = results
      job.error = error.message
      throw error
    }
  }

  async function submitRouter(job, results) {
    for (const group of job.groups) {
      const account = accountForWallet(group.walletId)
      if (!account) throw new Error(`钱包 ${group.walletId} 的本地签名器不可用`)
      for (const item of executionItems(group.execution)) {
        if (item.status === "complete" || !item.data?.sign) continue
        const signature = await account.signTypedData(typedData(item.data.sign))
        const post = item.data.post
        if (!post?.endpoint) throw new Error("挂单签名步骤缺少提交地址")
        const body = insertSignature(clone(post.body || {}), signature)
        const response = await fetchImpl(assertPostEndpoint(post.endpoint, job.base), {
          method: String(post.method || "POST").toUpperCase(),
          headers: routerHeaders(env),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        })
        const payload = await responseJson(response, `${job.marketplace.label} 订单提交`)
        results.push({
          walletId: group.walletId,
          ok: true,
          step: item.stepId,
          orderIds: [...collectOrderIds(payload)],
        })
      }
    }
    return results
  }

  function get(id) {
    cleanup()
    const job = jobs.get(String(id || ""))
    return job ? publicPreview(job) : null
  }

  return { get, preview, submit }
}

function cryptoTimingSafeEqual(left, right) {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index]
  return mismatch === 0
}

