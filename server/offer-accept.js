import { encodeFunctionData, getAddress, parseAbi, toFunctionSelector } from "viem"
import { OPENSEA_CHAINS } from "./nft-holdings.js"
import { nftMarketplaceCatalog } from "./nft-management.js"
import { SeaportFulfillmentAbi } from "./seaport-abi.js"

const OPENSEA_API = "https://api.opensea.io"
const NFT_ABI = parseAbi(["function isApprovedForAll(address owner, address operator) view returns (bool)"])

function apiKey(env) {
  return String(env.OPENSEA_API_KEY || env.NFT_INDEXER_OPENSEA_KEY || "").trim()
}

function jsonValue(value) {
  if (Array.isArray(value)) return value.map(jsonValue)
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]))
}

function functionAbi(name) {
  const item = SeaportFulfillmentAbi.find((entry) => entry.type === "function" && entry.name === name)
  if (!item) throw new Error(`Seaport ABI 缺少 ${name}`)
  return item
}

const FUNCTION_ABIS = {
  fulfillAdvancedOrder: functionAbi("fulfillAdvancedOrder"),
  matchAdvancedOrders: functionAbi("matchAdvancedOrders"),
}

function selectorFor(name) {
  return toFunctionSelector(FUNCTION_ABIS[name])
}

function functionName(value) {
  const name = String(value || "").split("(", 1)[0].trim()
  if (!FUNCTION_ABIS[name]) throw new Error(`OpenSea 返回了不支持的成交函数：${name || "未知"}`)
  return name
}

// OpenSea's API has already resolved zones, signatures, criteria proofs and conduit
// keys. Re-encode only the ABI envelope and append its attribution suffix verbatim.
export function encodeFulfillment(transaction) {
  const name = functionName(transaction?.function)
  const returnedSelector = toFunctionSelector(String(transaction.function))
  if (returnedSelector !== selectorFor(name)) {
    throw new Error(`OpenSea 成交函数选择器不匹配：${returnedSelector} != ${selectorFor(name)}`)
  }
  const input = jsonValue(transaction.input_data || transaction.inputData)
  const args = name === "fulfillAdvancedOrder"
    ? [input.advancedOrder, input.criteriaResolvers || [], input.fulfillerConduitKey || `0x${"00".repeat(32)}`, input.recipient]
    : [input.orders || [], input.criteriaResolvers || [], input.fulfillments || [], input.recipient]
  const encoded = encodeFunctionData({ abi: [FUNCTION_ABIS[name]], functionName: name, args })
  const suffix = String(transaction.calldata_suffix || transaction.calldataSuffix || "")
  if (suffix && !/^0x[0-9a-f]*$/i.test(suffix)) throw new Error("OpenSea calldata suffix 无效")
  return {
    to: getAddress(String(transaction.to || "")),
    valueWei: BigInt(String(transaction.value ?? transaction.value_hex ?? "0")).toString(),
    data: `${encoded}${suffix ? suffix.slice(2) : ""}`,
    functionName: name,
  }
}

export function createOfferAcceptService({
  fetchImpl = fetch,
  clientForChain,
  env = process.env,
  clock = () => Date.now(),
} = {}) {
  async function openSeaJson(path, init = {}) {
    const key = apiKey(env)
    if (!key) throw new Error("接 offer 需要 OpenSea API Key：请在 .env 配置 OPENSEA_API_KEY。")
    const response = await fetchImpl(`${OPENSEA_API}${path}`, {
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
      signal: AbortSignal.timeout(20_000),
      ...init,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(body?.errors?.[0] || body?.message || `OpenSea 接 offer 请求失败 HTTP ${response.status}`))
    return body
  }

  async function fulfillment({ chainId, row, offer, walletAddress }) {
    const chain = OPENSEA_CHAINS[Number(chainId)]
    if (!chain) throw new Error(`OpenSea 不支持链 ${chainId}`)
    const body = {
      offer: { hash: offer.orderHash, chain: offer.chain || chain, protocol_address: offer.protocolAddress },
      fulfiller: { address: walletAddress },
      consideration: { asset_contract_address: row.contractAddress, token_id: String(row.tokenId) },
      units_to_fill: String(offer.unitsToFill || "1"),
      include_optional_creator_fees: false,
    }
    const response = await openSeaJson("/api/v2/offers/fulfillment_data", { method: "POST", body: JSON.stringify(body) })
    const transaction = response.fulfillment_data?.transaction || response.fulfillmentData?.transaction
    if (!transaction) throw new Error("OpenSea 未返回接 offer 交易数据")
    return { transaction, encoded: encodeFulfillment(transaction) }
  }

  async function preview({ chainId, contractAddress, standard, rows, marketplaceId = "opensea" }) {
    if (!Array.isArray(rows) || !rows.length) throw new Error("请至少选择一个有报价的 NFT")
    if (!OPENSEA_CHAINS[Number(chainId)]) throw new Error(`OpenSea 不支持链 ${chainId}`)
    const contract = getAddress(String(contractAddress || ""))
    const catalog = nftMarketplaceCatalog(chainId, env)
    const market = catalog.find((item) => item.id === marketplaceId)
    const operator = market?.operators?.[standard]
    if (!operator) throw new Error("当前链没有可用的 OpenSea NFT 授权地址")
    const groups = new Map()
    for (const row of rows) {
      const offer = row.bestOffer || row.offers?.[0]
      if (!offer) throw new Error(`Token #${row.tokenId} 没有可接受的报价`)
      const wallet = String(row.address || "")
      const group = groups.get(wallet.toLowerCase()) || { walletAddress: wallet, rows: [] }
      group.rows.push({ row, offer })
      groups.set(wallet.toLowerCase(), group)
    }
    const client = clientForChain?.(chainId)
    if (!client) throw new Error("接 offer 预览需要链上 RPC 客户端")
    const groupedResults = await Promise.all([...groups.values()].map(async (group) => {
      const approved = await client.readContract({ address: contract, abi: NFT_ABI, functionName: "isApprovedForAll", args: [getAddress(group.walletAddress), getAddress(operator)] })
      const entries = []
      const proceeds = []
      for (const { row, offer } of group.rows) {
        const result = await fulfillment({ chainId, row: { ...row, contractAddress: contract }, offer, walletAddress: group.walletAddress })
        entries.push({ walletId: row.walletId, tokenId: String(row.tokenId), quantity: String(offer.quantity || "1"), to: result.encoded.to, valueWei: result.encoded.valueWei, data: result.encoded.data, summary: `${row.walletId} 接受 ${offer.priceCurrency || "ETH"} ${offer.unitPriceValue || offer.priceValue || "0"} 的 ${offerType(offer)}报价` })
        proceeds.push({ holdingId: row.id, tokenId: String(row.tokenId), priceValue: offer.priceValue, unitPriceValue: offer.unitPriceValue, quantity: offer.quantity, currency: offer.priceCurrency, decimals: offer.priceDecimals, sellerProceedsValue: offer.sellerProceedsValue || offer.priceValue })
      }
      return { entries, proceeds, approval: approved ? null : { walletId: group.rows[0].row.walletId, address: group.walletAddress, operator, changed: true } }
    }))
    const entries = groupedResults.flatMap((result) => result.entries)
    const proceeds = groupedResults.flatMap((result) => result.proceeds)
    const approvals = groupedResults.map((result) => result.approval).filter(Boolean)
    return {
      chainId: Number(chainId), contractAddress: contract, standard, marketplace: { id: marketplaceId, operator }, entries, proceeds,
      requiresApproval: approvals.length > 0, approvals, generatedAt: clock(),
      summary: { transactionCount: entries.length, proceeds, requiresApproval: approvals.length > 0, ready: entries.length > 0 && approvals.length === 0 },
    }
  }

  return { preview }
}

function offerType(offer) {
  return offer?.scope === "traits" ? "特征" : offer?.scope === "collection" ? "合集" : "具体"
}
