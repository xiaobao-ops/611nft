import { decodeFunctionData, toFunctionSelector } from "viem"

const SEA_DROP_SELECTORS = new Set(["0x161ac21f", "0x4b61cd6f", "0x4300a4e6"])
const QUANTITY_NAMES = new Set([
  "amount",
  "count",
  "mintamount",
  "mintcount",
  "mintquantity",
  "numberoftokens",
  "numtokens",
  "quantity",
])
const COLLECTION_NAMES = new Set(["collection", "collectionaddress", "nft", "nftcontract", "tokencontract"])
const DIRECT_MINT_ABI = [
  "mint",
  "publicMint",
  "publicSaleMint",
  "mintPublic",
  "allowlistMint",
  "whitelistMint",
  "presaleMint",
  "mintNFT",
  "mintTokens",
  "safeMint",
].map((name) => ({
  type: "function",
  name,
  stateMutability: "payable",
  inputs: [{ name: "quantity", type: "uint256" }],
  outputs: [],
}))

function compactError(error) {
  const value = error instanceof Error ? error.message : String(error)
  return (value.split("\n").find(Boolean) || "待确认来源请求失败").slice(0, 240)
}

function normalizeName(value) {
  return String(value || "").replace(/^_+/, "").replace(/[^a-z0-9]/gi, "").toLowerCase()
}

function normalizeAddress(value) {
  const address = typeof value === "object" ? value?.hash || value?.address : value
  const normalized = String(address || "").toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : ""
}

function parsePositiveInteger(value) {
  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
}

function inputWord(input, index) {
  const start = 10 + index * 64
  const word = String(input || "").slice(start, start + 64)
  return /^[a-fA-F0-9]{64}$/.test(word) ? word : ""
}

function seaDropMint(input) {
  const data = String(input || "")
  if (!SEA_DROP_SELECTORS.has(data.slice(0, 10).toLowerCase())) return null
  const collectionWord = inputWord(data, 0)
  const quantityWord = inputWord(data, 3)
  if (!collectionWord || !quantityWord) return null
  return {
    collection: normalizeAddress(`0x${collectionWord.slice(24)}`),
    quantity: parsePositiveInteger(`0x${quantityWord}`),
    method: "SeaDrop",
  }
}

function functionForInput(abi, input) {
  const selector = String(input || "").slice(0, 10).toLowerCase()
  return (Array.isArray(abi) ? abi : []).find((item) => {
    if (item?.type !== "function" || !item.name || !Array.isArray(item.inputs)) return false
    try {
      return toFunctionSelector(item).toLowerCase() === selector
    } catch {
      return false
    }
  }) || null
}

function decodedMintFromAbi(input, abi, collectionKeys, directCollection = "") {
  const fn = functionForInput(abi, input)
  if (!fn || !/(?:mint|claim)/i.test(fn.name)) return null
  try {
    const decoded = decodeFunctionData({ abi, data: input })
    const args = Array.from(decoded.args || [])
    let collection = directCollection
    if (!collection) {
      const index = fn.inputs.findIndex((item) => item.type === "address" && COLLECTION_NAMES.has(normalizeName(item.name)))
      collection = index >= 0 ? normalizeAddress(args[index]) : ""
    }
    if (!collectionKeys.has(collection)) return null
    const candidates = fn.inputs.map((item, index) => ({ item, value: args[index] })).filter(({ item }) => (
      /^uint(?:\d+)?$/.test(item.type) && QUANTITY_NAMES.has(normalizeName(item.name))
    ))
    if (candidates.length !== 1) return { collection, quantity: null, method: fn.name }
    return { collection, quantity: parsePositiveInteger(candidates[0].value), method: fn.name }
  } catch {
    return null
  }
}

function decodedMintFromExplorer(transaction, collectionKeys, directCollection = "") {
  const decoded = transaction?.decodedInput || transaction?.decoded_input
  const method = String(decoded?.method_call || transaction?.method || "").split("(")[0]
  if (!/(?:mint|claim)/i.test(method)) return null
  const parameters = Array.isArray(decoded?.parameters) ? decoded.parameters : []
  let collection = directCollection
  if (!collection) {
    const target = parameters.find((item) => item?.type === "address" && COLLECTION_NAMES.has(normalizeName(item.name)))
    collection = normalizeAddress(target?.value)
  }
  if (!collectionKeys.has(collection)) return null
  const quantities = parameters.filter((item) => (
    /^uint(?:\d+)?$/.test(String(item?.type || "")) && QUANTITY_NAMES.has(normalizeName(item?.name))
  ))
  return {
    collection,
    quantity: quantities.length === 1 ? parsePositiveInteger(quantities[0].value) : null,
    method,
  }
}

export function normalizePendingTransaction(transaction, source = "rpc", index = 0) {
  if (!transaction || typeof transaction === "string") return null
  const input = String(transaction.input || transaction.data || transaction.raw_input || transaction.rawInput || "0x")
  const hash = String(transaction.hash || transaction.transaction_hash || "").toLowerCase()
  const to = normalizeAddress(transaction.to)
  const from = normalizeAddress(transaction.from)
  const nonce = transaction.nonce == null ? "" : String(transaction.nonce)
  const key = /^0x[a-f0-9]{64}$/.test(hash) ? hash : `${to}:${from}:${nonce}:${input}`
  return {
    ...transaction,
    hash: /^0x[a-f0-9]{64}$/.test(hash) ? hash : "",
    key,
    to,
    from,
    input,
    source,
  }
}

export function decodePendingMintTransaction(transaction, collectionAddresses, abi = null) {
  const collections = collectionAddresses instanceof Set
    ? collectionAddresses
    : new Set((collectionAddresses || []).map(normalizeAddress).filter(Boolean))
  const directCollection = collections.has(transaction?.to) ? transaction.to : ""
  const seaDrop = seaDropMint(transaction?.input)
  if (seaDrop && collections.has(seaDrop.collection)) return seaDrop

  const explorer = decodedMintFromExplorer(transaction, collections, directCollection)
  if (explorer) return explorer

  if (abi) {
    const verified = decodedMintFromAbi(transaction?.input, abi, collections, directCollection)
    if (verified) return verified
  }

  if (directCollection) {
    const known = decodedMintFromAbi(transaction?.input, DIRECT_MINT_ABI, collections, directCollection)
    if (known) return known
    return { collection: directCollection, quantity: null, method: "未知铸造方法" }
  }
  return null
}

export function aggregatePendingMints(transactions, collectionAddresses, abiByAddress = new Map()) {
  const collections = collectionAddresses instanceof Set
    ? collectionAddresses
    : new Set((collectionAddresses || []).map(normalizeAddress).filter(Boolean))
  const output = new Map()
  for (const transaction of transactions || []) {
    const abi = abiByAddress.get(transaction.to) || null
    const decoded = decodePendingMintTransaction(transaction, collections, abi)
    if (!decoded) continue
    const current = output.get(decoded.collection) || { tokenCount: 0n, unknownTxCount: 0, transactionCount: 0 }
    current.transactionCount += 1
    if (decoded.quantity === null) current.unknownTxCount += 1
    else current.tokenCount += decoded.quantity
    output.set(decoded.collection, current)
  }
  return new Map([...output].map(([address, value]) => [address, {
    tokenCount: value.tokenCount.toString(),
    unknownTxCount: value.unknownTxCount,
    transactionCount: value.transactionCount,
  }]))
}

async function pendingBlockTransactions(client) {
  const block = await client.getBlock({ blockTag: "pending", includeTransactions: true })
  return Array.isArray(block?.transactions) ? block.transactions : []
}

async function rpcPendingTransactions(client) {
  if (typeof client.request !== "function") throw new Error("RPC 未提供 request 方法")
  const transactions = await client.request({ method: "eth_pendingTransactions", params: [] })
  if (!Array.isArray(transactions)) throw new Error("RPC 返回的待确认交易格式错误")
  return transactions
}

async function blockscoutPendingTransactions(fetchImpl, base) {
  const transactions = []
  let next = { filter: "pending" }
  for (let page = 0; page < 5 && next; page += 1) {
    const url = new URL("/api/v2/transactions", base)
    for (const [key, value] of Object.entries(next)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`)
    const payload = await response.json()
    transactions.push(...(Array.isArray(payload?.items) ? payload.items : []))
    next = payload?.next_page_params || null
  }
  return transactions
}

export async function collectPendingTransactions({ client, fetchImpl = fetch, blockscoutBase = "" } = {}) {
  const configured = [
    { name: "pending_block", load: () => pendingBlockTransactions(client) },
    ...(typeof client?.request === "function" ? [{ name: "rpc_pending", load: () => rpcPendingTransactions(client) }] : []),
    ...(blockscoutBase ? [{ name: "blockscout", load: () => blockscoutPendingTransactions(fetchImpl, blockscoutBase) }] : []),
  ]
  const settled = await Promise.all(configured.map(async (source) => {
    try {
      const values = await source.load()
      return { name: source.name, ok: true, values, error: "", lastSuccessAt: new Date().toISOString() }
    } catch (error) {
      return { name: source.name, ok: false, values: [], error: compactError(error), lastSuccessAt: null }
    }
  }))
  const unique = new Map()
  for (const source of settled) {
    source.values.forEach((transaction, index) => {
      const normalized = normalizePendingTransaction(transaction, source.name, index)
      if (normalized && !unique.has(normalized.key)) unique.set(normalized.key, normalized)
    })
  }
  const successCount = settled.filter((source) => source.ok).length
  return {
    transactions: [...unique.values()],
    coverage: successCount === 0 ? "unavailable" : successCount === settled.length ? "observed" : "partial",
    sources: settled.map((source) => ({
      name: source.name,
      ok: source.ok,
      count: source.values.length,
      error: source.error,
      lastSuccessAt: source.lastSuccessAt,
    })),
    updatedAt: new Date().toISOString(),
  }
}
