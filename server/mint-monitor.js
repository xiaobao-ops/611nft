import { decodeEventLog, decodeFunctionData, formatEther, formatGwei, parseAbiItem, toEventSelector, toHex, zeroAddress } from "viem"
import { createMintIntelService, knownMintMethod } from "./mint-intel.js"
import { aggregatePendingMints, collectPendingTransactions } from "./pending-mints.js"

export const ERC721_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)")
export const ERC1155_TRANSFER_SINGLE = parseAbiItem("event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)")
export const ERC1155_TRANSFER_BATCH = parseAbiItem("event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)")

const ERC165_ABI = [{
  type: "function",
  name: "supportsInterface",
  stateMutability: "view",
  inputs: [{ name: "interfaceId", type: "bytes4" }],
  outputs: [{ name: "supported", type: "bool" }],
}]

const STRING_READ_ABI = (name) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "value", type: "string" }],
}]

const UINT_READ_ABI = (name) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "value", type: "uint256" }],
}]

const SEA_DROP_PUBLIC_MINT_SELECTOR = "0x161ac21f"
const SEA_DROP_SIGNED_MINT_SELECTOR = "0x4b61cd6f"
const SEA_DROP_ALLOW_LIST_MINT_SELECTOR = "0x4300a4e6"
const SEA_DROP_PUBLIC_DROP_ABI = [{
  type: "function",
  name: "getPublicDrop",
  stateMutability: "view",
  inputs: [{ name: "nftContract", type: "address" }],
  outputs: [{
    name: "publicDrop",
    type: "tuple",
    components: [
      { name: "mintPrice", type: "uint80" },
      { name: "startTime", type: "uint48" },
      { name: "endTime", type: "uint48" },
      { name: "maxTotalMintableByWallet", type: "uint16" },
      { name: "feeBps", type: "uint16" },
      { name: "restrictFeeRecipients", type: "bool" },
    ],
  }],
}]
const SEA_DROP_STAGE_COMPONENTS = [
  { name: "mintPrice", type: "uint256" },
  { name: "maxTotalMintableByWallet", type: "uint256" },
  { name: "startTime", type: "uint256" },
  { name: "endTime", type: "uint256" },
  { name: "dropStageIndex", type: "uint256" },
  { name: "maxTokenSupplyForStage", type: "uint256" },
  { name: "feeBps", type: "uint256" },
  { name: "restrictFeeRecipients", type: "bool" },
]
const SEA_DROP_SIGNED_MINT_ABI = [{
  type: "function",
  name: "mintSigned",
  stateMutability: "payable",
  inputs: [
    { name: "nftContract", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "minterIfNotPayer", type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "mintParams", type: "tuple", components: SEA_DROP_STAGE_COMPONENTS },
    { name: "salt", type: "uint256" },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
}]
const SEA_DROP_ALLOW_LIST_MINT_ABI = [{
  type: "function",
  name: "mintAllowList",
  stateMutability: "payable",
  inputs: [
    { name: "nftContract", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "minterIfNotPayer", type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "mintParams", type: "tuple", components: SEA_DROP_STAGE_COMPONENTS },
    { name: "proof", type: "bytes32[]" },
  ],
  outputs: [],
}]
const WALLET_LIMIT_GETTERS = [
  "maxPerWallet",
  "maxMintPerWallet",
  "maxMintsPerWallet",
  "maxMintAmountPerWallet",
  "maxMintPerAddress",
  "maxPerAddress",
  "walletLimit",
]

const DEFAULT_PROVIDER = "https://api.waypoint.tools"
const MAX_EVENTS_PER_CHAIN = 800
const MAX_COLLECTION_EVENTS = 80
const MAX_OVERVIEW_COLLECTION_EVENTS = 5
const DEFAULT_WINDOW_SECONDS = 1800
const ALLOWED_WINDOWS = new Set([60, 180, 300, 600, 1800, 3600, 21600, 43200, 86400])
const RECEIPT_SCAN_CONCURRENCY = 6
const RECEIPT_FETCH_CONCURRENCY = 12
const METADATA_FETCH_CONCURRENCY = 4
const MINT_ENRICH_CONCURRENCY = 8
const COLLECTION_GAS_CONCURRENCY = 8
const COLLECTION_GAS_EVENT_LIMIT = 30
const MAX_RECEIPT_FALLBACK_BLOCKS = 12n
const DEFAULT_MINTER_BACKFILL_PAGE_DELAY_MS = 3000
const DEFAULT_MINTER_BACKFILL_RETRY_MS = 60000
const MINT_EVENTS = [ERC721_TRANSFER, ERC1155_TRANSFER_SINGLE, ERC1155_TRANSFER_BATCH]
const MINT_EVENT_TOPICS = MINT_EVENTS.map(toEventSelector)
const BLOCKSCOUT_BASES = {
  1: "https://eth.blockscout.com",
  8453: "https://base.blockscout.com",
  42161: "https://arbitrum.blockscout.com",
  10: "https://explorer.optimism.io",
  137: "https://polygon.blockscout.com",
  56: "https://bsc.blockscout.com",
  4663: "https://robinhoodchain.blockscout.com",
}

export function createMintMonitorWssBridge({ chainId, monitor, getManager } = {}) {
  const id = Number(chainId)
  return {
    onWssEvent(value) {
      if (value?.type === "logs") {
        const removedLogs = (value.logs || []).filter((log) => log?.removed && log.transactionHash && log.address)
        const eventIds = [...new Set(removedLogs.map((log) => (
          `${log.transactionHash}:${String(log.address).toLowerCase()}`
        )))]
        const rewindBlock = removedLogs.reduce((lowest, log) => {
          if (log.blockNumber === null || log.blockNumber === undefined) return lowest
          const blockNumber = BigInt(log.blockNumber)
          return lowest === null || blockNumber < lowest ? blockNumber : lowest
        }, null)
        if (eventIds.length) monitor.ingestRemoved(id, eventIds, { rewindBlock })
      }
      void monitor.scan(id)
    },
    onMonitorEvent(value) {
      if (value?.type !== "monitor_status" || !("scanDurationMs" in value)) return
      const manager = getManager?.()
      if (manager && manager.status().state !== "active") manager.recordHttpFallback()
    },
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function compactError(error) {
  const value = message(error)
  if (/please specify an address/i.test(value)) return "RPC requires an address for multi-block log queries"
  if (/method not found|does not exist|not available/i.test(value)) return "RPC method is unavailable"
  if (/rate.?limit|too many requests|\b429\b/i.test(value)) return "RPC rate limit reached"
  if (/timeout|timed out|abort/i.test(value)) return "RPC request timed out"
  if (/archive requests?/i.test(value)) return "RPC archive range is unavailable"
  return (value.split("\n").find(Boolean) || "Unknown RPC error").slice(0, 240)
}

function uniqueMessages(values) {
  return [...new Set(values.filter(Boolean).map(String))]
}

async function mapConcurrent(values, concurrency, worker) {
  const output = new Array(values.length)
  let cursor = 0
  async function run() {
    while (cursor < values.length) {
      const index = cursor++
      output[index] = await worker(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run))
  return output
}

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function chainNativeSymbol(chain) {
  return String(chain?.nativeSymbol || chain?.viem?.nativeCurrency?.symbol || "").trim() || "—"
}

function normalizeMintPriceLabel(value, nativeSymbol) {
  if (value === null || value === undefined) return value
  const label = String(value).trim().replace(/\bnative(?:[-\s]+token)?\b/gi, nativeSymbol)
  return /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(label) ? `${label} ${nativeSymbol}` : label
}

function shortPrice(wei, nativeSymbol) {
  if (wei === 0n) return "Free"
  const value = Number(formatEther(wei))
  if (!Number.isFinite(value)) return `${formatEther(wei)} ${nativeSymbol}`
  if (value < 0.000001) return `${value.toExponential(2)} ${nativeSymbol}`
  return `${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} ${nativeSymbol}`
}

function mintPlatform(meta) {
  const value = `${meta?.name || ""} ${meta?.symbol || ""}`.toLowerCase()
  if (value.includes("art blocks") || value.includes("artblocks")) return "artblocks"
  if (value.includes("bueno")) return "bueno"
  if (value.includes("zora")) return "zora"
  if (value.includes("manifold")) return "manifold"
  return ""
}

function compactGwei(value) {
  if (value === null || value === undefined) return null
  const text = formatGwei(BigInt(value))
  return Number(text).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

function calldataShape(input) {
  const data = String(input || "")
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return { selector: "", calldataBytes: null, parameterCount: null }
  const payloadHexLength = data.length - 10
  return {
    selector: data.slice(0, 10).toLowerCase(),
    calldataBytes: (data.length - 2) / 2,
    parameterCount: payloadHexLength % 64 === 0 ? payloadHexLength / 64 : null,
  }
}

function mintCount(log) {
  if (log.eventName === "TransferBatch") {
    return (log.args.values || []).reduce((sum, value) => sum + BigInt(value), 0n)
  }
  if (log.eventName === "TransferSingle") return BigInt(log.args.value || 0)
  return 1n
}

function tokenIds(log) {
  if (log.eventName === "TransferBatch") return (log.args.ids || []).map(String)
  if (log.eventName === "TransferSingle") return [String(log.args.id)]
  return [String(log.args.tokenId)]
}

function recipient(log) {
  return log.args.to
}

function isZeroFrom(log) {
  return String(log.args.from || "").toLowerCase() === zeroAddress
}

async function readOptional(client, request) {
  try {
    return await client.readContract(request)
  } catch {
    return null
  }
}

export async function readCollectionMetadata(client, address, inferredStandard = "ERC721", blockNumber = null) {
  const supplyRequest = { address, abi: UINT_READ_ABI("totalSupply"), functionName: "totalSupply" }
  if (blockNumber !== null && blockNumber !== undefined) supplyRequest.blockNumber = BigInt(blockNumber)
  const [name, symbol, erc721, erc1155, totalSupply] = await Promise.all([
    readOptional(client, { address, abi: STRING_READ_ABI("name"), functionName: "name" }),
    readOptional(client, { address, abi: STRING_READ_ABI("symbol"), functionName: "symbol" }),
    readOptional(client, { address, abi: ERC165_ABI, functionName: "supportsInterface", args: ["0x80ac58cd"] }),
    readOptional(client, { address, abi: ERC165_ABI, functionName: "supportsInterface", args: ["0xd9b67a26"] }),
    readOptional(client, supplyRequest),
  ])

  const supplyCandidates = ["maxSupply", "MAX_SUPPLY", "collectionSize"]
  let maxSupply = null
  for (const functionName of supplyCandidates) {
    const request = { address, abi: UINT_READ_ABI(functionName), functionName }
    if (blockNumber !== null && blockNumber !== undefined) request.blockNumber = BigInt(blockNumber)
    maxSupply = await readOptional(client, request)
    if (maxSupply !== null) break
  }

  return {
    address,
    name: String(name || symbol || `${inferredStandard} ${address.slice(0, 6)}`),
    symbol: String(symbol || ""),
    tokenStandard: erc1155 ? "ERC1155" : erc721 ? "ERC721" : inferredStandard,
    currentSupply: totalSupply === null ? null : totalSupply.toString(),
    supplyBlockNumber: totalSupply !== null && blockNumber !== null && blockNumber !== undefined ? BigInt(blockNumber).toString() : null,
    maxSupply: maxSupply === null ? null : maxSupply.toString(),
    maxPerWallet: null,
    walletLimitReader: null,
  }
}

export function applyConfirmedSupply(collection, totalSupply, blockNumber) {
  if (totalSupply === null || totalSupply === undefined || blockNumber === null || blockNumber === undefined) return false
  const nextBlock = BigInt(blockNumber)
  const currentBlock = collection.supplyBlockNumber === null || collection.supplyBlockNumber === undefined
    ? null
    : BigInt(collection.supplyBlockNumber)
  if (currentBlock !== null && nextBlock < currentBlock) return false

  const nextSupply = BigInt(totalSupply).toString()
  if (currentBlock === nextBlock && collection.currentSupply !== null && collection.currentSupply !== undefined) return false
  collection.currentSupply = nextSupply
  collection.supplyBlockNumber = nextBlock.toString()
  return true
}

function seaDropStageLimit(input, selector) {
  const abi = selector === SEA_DROP_SIGNED_MINT_SELECTOR
    ? SEA_DROP_SIGNED_MINT_ABI
    : selector === SEA_DROP_ALLOW_LIST_MINT_SELECTOR ? SEA_DROP_ALLOW_LIST_MINT_ABI : null
  if (!abi || !input) return null
  try {
    const decoded = decodeFunctionData({ abi, data: input })
    return decoded.args?.[4]?.maxTotalMintableByWallet ?? null
  } catch {
    return null
  }
}

async function readWalletLimit(client, collection) {
  const transaction = collection.lastMintTransaction
  const selector = String(transaction?.input || "").slice(0, 10).toLowerCase()
  if (transaction?.to && selector === SEA_DROP_PUBLIC_MINT_SELECTOR) {
    const publicDrop = await readOptional(client, {
      address: transaction.to,
      abi: SEA_DROP_PUBLIC_DROP_ABI,
      functionName: "getPublicDrop",
      args: [collection.address],
    })
    if (publicDrop !== null) {
      collection.walletLimitReader = { type: "seadrop-public", address: transaction.to }
      const price = publicDropPrice(publicDrop)
      if (price !== null) collection.configuredMintPriceWei = BigInt(price).toString()
      return publicDrop.maxTotalMintableByWallet ?? publicDrop[3] ?? null
    }
  }

  const stageLimit = seaDropStageLimit(transaction?.input, selector)
  if (stageLimit !== null) {
    collection.walletLimitReader = { type: "seadrop-calldata", selector }
    return stageLimit
  }

  const reader = collection.walletLimitReader
  if (reader?.type === "getter") {
    return readOptional(client, {
      address: reader.address,
      abi: UINT_READ_ABI(reader.functionName),
      functionName: reader.functionName,
    })
  }
  if (reader?.type === "seadrop-public") {
    const publicDrop = await readOptional(client, {
      address: reader.address,
      abi: SEA_DROP_PUBLIC_DROP_ABI,
      functionName: "getPublicDrop",
      args: [collection.address],
    })
    if (publicDrop === null) return null
    const price = publicDropPrice(publicDrop)
    if (price !== null) collection.configuredMintPriceWei = BigInt(price).toString()
    return publicDrop.maxTotalMintableByWallet ?? publicDrop[3] ?? null
  }
  if (!collection.walletLimitChecked && transaction?.to?.toLowerCase() === collection.address.toLowerCase()) {
    collection.walletLimitChecked = true
    const values = await Promise.all(WALLET_LIMIT_GETTERS.map((functionName) => (
      readOptional(client, { address: collection.address, abi: UINT_READ_ABI(functionName), functionName })
    )))
    const index = values.findIndex((value) => value !== null)
    if (index >= 0) {
      collection.walletLimitReader = { type: "getter", address: collection.address, functionName: WALLET_LIMIT_GETTERS[index] }
      return values[index]
    }
  }
  return null
}

function publicDropPrice(publicDrop) {
  return publicDrop?.mintPrice ?? publicDrop?.[0] ?? null
}

async function refreshCollectionState(client, collection, blockNumber = null) {
  const supplyRequest = { address: collection.address, abi: UINT_READ_ABI("totalSupply"), functionName: "totalSupply" }
  if (blockNumber !== null && blockNumber !== undefined) supplyRequest.blockNumber = BigInt(blockNumber)
  const [totalSupply, maxPerWallet] = await Promise.all([
    readOptional(client, supplyRequest),
    readWalletLimit(client, collection),
  ])

  applyConfirmedSupply(collection, totalSupply, blockNumber)
  if (maxPerWallet !== null) collection.maxPerWallet = maxPerWallet.toString()
}

function collectionMintPrice(collection, nativeSymbol, events = collection.events) {
  if (collection.configuredMintPriceWei !== null && collection.configuredMintPriceWei !== undefined) {
    const raw = String(collection.configuredMintPriceWei)
    return { label: shortPrice(BigInt(raw), nativeSymbol), raw }
  }
  const pricedEvent = events.find((event) => event.unitPriceWei !== null && event.unitPriceWei !== undefined)
    || collection.events.find((event) => event.unitPriceWei !== null && event.unitPriceWei !== undefined)
  const raw = pricedEvent?.unitPriceWei ?? collection.lastPriceWei ?? null
  return { label: raw === null ? "Unknown" : shortPrice(BigInt(raw), nativeSymbol), raw }
}

function collectionMintable(collection) {
  if (collection.currentSupply === null || collection.maxSupply === null) return true
  return BigInt(collection.currentSupply) < BigInt(collection.maxSupply)
}

function normalizeProviderRows(payload) {
  const windows = payload?.windows || {}
  const output = {}
  for (const [windowKey, rows] of Object.entries(windows)) {
    if (!Array.isArray(rows)) continue
    output[windowKey] = rows
      .filter((row) => /^0x[a-fA-F0-9]{40}$/.test(String(row.address || "")))
      .map((row) => ({
        ...row,
        twitter: row.twitter || row.x || row.x_url || row.twitter_url || null,
        website: row.website || row.website_url || null,
        opensea_url: row.opensea_url || row.openseaUrl || row.opensea || null,
      }))
  }
  return { ...payload, windows: output }
}

export function createMintMonitor({
  getClient,
  getChain,
  mediaResolver = null,
  providerBase = process.env.MINT_MONITOR_API_BASE || DEFAULT_PROVIDER,
  pollIntervalMs = Number(process.env.MINT_MONITOR_POLL_MS || 5000),
  initialBlocks = Number(process.env.MINT_MONITOR_INITIAL_BLOCKS || 120),
  maxBlocksPerScan = Number(process.env.MINT_MONITOR_MAX_BLOCKS_PER_SCAN || 160),
  initialResponseWaitMs = Number(process.env.MINT_MONITOR_INITIAL_RESPONSE_WAIT_MS || 750),
  overviewSupplyWaitMs = Number(process.env.MINT_MONITOR_OVERVIEW_SUPPLY_WAIT_MS || 250),
  providerResponseWaitMs = Number(process.env.MINT_MONITOR_PROVIDER_RESPONSE_WAIT_MS || 300),
  providerHydrationWaitMs = Number(process.env.MINT_MONITOR_PROVIDER_HYDRATION_WAIT_MS || 400),
  collectionGasWaitMs = Number(process.env.MINT_MONITOR_COLLECTION_GAS_WAIT_MS || 1500),
  overviewMediaPrewarmWaitMs = Number(process.env.MINT_MONITOR_MEDIA_PREWARM_WAIT_MS || 400),
  overviewMediaPrewarmConcurrency = Number(process.env.MINT_MONITOR_MEDIA_PREWARM_CONCURRENCY || 24),
  minterStore = null,
  blockscoutBases = BLOCKSCOUT_BASES,
  minterBackfillPageDelayMs = Number(process.env.MINT_MONITOR_MINTER_BACKFILL_PAGE_DELAY_MS || DEFAULT_MINTER_BACKFILL_PAGE_DELAY_MS),
  minterBackfillRetryMs = Number(process.env.MINT_MONITOR_MINTER_BACKFILL_RETRY_MS || DEFAULT_MINTER_BACKFILL_RETRY_MS),
  fetchImpl = fetch,
  autoPoll = true,
  enableIntel = autoPoll,
  intelService = null,
  deployerProfileStore = null,
  deployerYoungWalletDays = Number(process.env.DEPLOYER_YOUNG_WALLET_DAYS || 7),
  deployerProjectRiskCount = Number(process.env.DEPLOYER_PROJECT_RISK_COUNT || 5),
} = {}) {
  const states = new Map()
  const subscribers = new Map()
  let providerCache = null
  let providerCheckedAt = 0
  let providerError = ""
  const providerCollectionCache = new Map()
  const providerCollectionRequests = new Map()
  const collectionMediaQueue = []
  const pendingCollectionMedia = new Set()
  const collectionMediaPromises = new Map()
  let activeMediaJobs = 0
  const minterBackfillQueue = []
  const queuedMinterBackfills = new Set()
  const minterBackfillRetryTimers = new Set()
  let activeMinterBackfill = null
  let minterBackfillTimer = null
  const intel = intelService || createMintIntelService({ fetchImpl, blockscoutBases })

  function minterKey(chainId, address) {
    return `${Number(chainId)}:${String(address).toLowerCase()}`
  }

  function localMinterSnapshot(chainId, collection) {
    const persisted = minterStore?.snapshot(Number(chainId), collection.address)
    return persisted || {
      count: collection.minters.size,
      status: "unavailable",
      error: "Historical minter backfill is not configured",
      pagesScanned: 0,
      updatedAt: null,
    }
  }

  function minterFields(chainId, collection) {
    const snapshot = localMinterSnapshot(chainId, collection)
    return {
      unique_minters: Math.max(collection.minters.size, Number(snapshot.count || 0)),
      unique_minters_status: snapshot.status,
      unique_minters_error: snapshot.error || "",
      unique_minters_pages_scanned: Number(snapshot.pagesScanned || 0),
      unique_minters_updated_at: snapshot.updatedAt || null,
    }
  }

  function scheduleMinterBackfillDrain(delayMs = 0) {
    if (!minterStore || activeMinterBackfill || minterBackfillTimer || !minterBackfillQueue.length) return
    if (delayMs <= 0) {
      minterBackfillTimer = true
      queueMicrotask(() => {
        minterBackfillTimer = null
        void drainMinterBackfillQueue()
      })
      return
    }
    minterBackfillTimer = setTimeout(() => {
      minterBackfillTimer = null
      void drainMinterBackfillQueue()
    }, Math.max(0, delayMs))
    minterBackfillTimer.unref?.()
  }

  function enqueueMinterBackfill(chainId, address, { priority = false } = {}) {
    if (!minterStore || !blockscoutBases[Number(chainId)]) return
    const key = minterKey(chainId, address)
    const progress = minterStore.ensure(Number(chainId), address)
    if (progress?.status === "complete" || activeMinterBackfill?.key === key) return
    if (queuedMinterBackfills.has(key)) {
      if (priority) {
        const index = minterBackfillQueue.findIndex((job) => job.key === key)
        if (index >= 0) {
          minterBackfillQueue[index].priority = true
          if (index > 0) minterBackfillQueue.unshift(...minterBackfillQueue.splice(index, 1))
        }
      }
      return
    }
    queuedMinterBackfills.add(key)
    const job = { key, chainId: Number(chainId), address: String(address).toLowerCase(), priority }
    if (priority) minterBackfillQueue.unshift(job)
    else minterBackfillQueue.push(job)
    scheduleMinterBackfillDrain()
  }

  function blockscoutTransferUrl(chainId, address, nextPageParams) {
    const url = new URL(`/api/v2/tokens/${address}/transfers`, blockscoutBases[Number(chainId)])
    for (const [key, value] of Object.entries(nextPageParams || {})) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  function blockscoutMintRecipients(items) {
    return [...new Set((items || []).filter((item) => (
      String(item?.from?.hash || "").toLowerCase() === zeroAddress
      && /^0x[a-fA-F0-9]{40}$/.test(String(item?.to?.hash || ""))
    )).map((item) => String(item.to.hash).toLowerCase()))]
  }

  async function processMinterBackfillPage(job) {
    try {
      const progress = minterStore.progress(job.chainId, job.address) || minterStore.ensure(job.chainId, job.address)
      if (progress.status === "complete") return { complete: true, retry: false }
      minterStore.markLoading(job.chainId, job.address)
      const response = await fetchImpl(blockscoutTransferUrl(job.chainId, job.address, progress.nextPageParams), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload?.items)) throw new Error("Blockscout returned an invalid transfer page")
      const nextPageParams = payload.next_page_params && typeof payload.next_page_params === "object"
        ? payload.next_page_params
        : null
      const snapshot = minterStore.savePage(job.chainId, job.address, blockscoutMintRecipients(payload.items), nextPageParams)
      publish(job.chainId, {
        type: "minter_backfill_update",
        chainId: job.chainId,
        address: job.address,
        unique_minters: snapshot.count,
        unique_minters_status: snapshot.status,
        unique_minters_error: snapshot.error,
        unique_minters_pages_scanned: snapshot.pagesScanned,
        unique_minters_updated_at: snapshot.updatedAt,
      })
      return { complete: snapshot.status === "complete", retry: false }
    } catch (error) {
      const message = compactError(error)
      let snapshot
      try {
        snapshot = minterStore.markError(job.chainId, job.address, message)
      } catch (persistenceError) {
        let persistedProgress = null
        try {
          persistedProgress = minterStore.progress(job.chainId, job.address)
        } catch {
          // Keep the retry loop alive even while another process owns the database writer lock.
        }
        snapshot = {
          count: 0,
          status: "error",
          error: `${message}; 状态写入失败: ${compactError(persistenceError)}`,
          pagesScanned: Number(persistedProgress?.pagesScanned || 0),
          updatedAt: persistedProgress?.updatedAt || null,
        }
      }
      publish(job.chainId, {
        type: "minter_backfill_update",
        chainId: job.chainId,
        address: job.address,
        unique_minters: snapshot.count,
        unique_minters_status: snapshot.status,
        unique_minters_error: snapshot.error,
        unique_minters_pages_scanned: snapshot.pagesScanned,
        unique_minters_updated_at: snapshot.updatedAt,
      })
      return { complete: false, retry: true }
    }
  }

  async function drainMinterBackfillQueue() {
    if (activeMinterBackfill || !minterBackfillQueue.length) return
    const job = minterBackfillQueue.shift()
    queuedMinterBackfills.delete(job.key)
    activeMinterBackfill = job
    let outcome = { complete: false, retry: false }
    try {
      outcome = await processMinterBackfillPage(job)
    } finally {
      activeMinterBackfill = null
    }
    if (!outcome.complete && !outcome.retry) {
      queuedMinterBackfills.add(job.key)
      if (job.priority) minterBackfillQueue.unshift(job)
      else minterBackfillQueue.push(job)
    }
    if (outcome.retry) {
      const retryTimer = setTimeout(() => {
        minterBackfillRetryTimers.delete(retryTimer)
        let progress = null
        try {
          progress = minterStore.progress(job.chainId, job.address)
        } catch {
          // A transient lock is retried by re-queueing the same bounded page.
        }
        if (progress?.status !== "complete" && !queuedMinterBackfills.has(job.key) && activeMinterBackfill?.key !== job.key) {
          queuedMinterBackfills.add(job.key)
          if (job.priority) minterBackfillQueue.unshift(job)
          else minterBackfillQueue.push(job)
        }
        scheduleMinterBackfillDrain()
      }, Math.max(1000, minterBackfillRetryMs))
      retryTimer.unref?.()
      minterBackfillRetryTimers.add(retryTimer)
    }
    scheduleMinterBackfillDrain(minterBackfillPageDelayMs)
  }

  function stateFor(chainId) {
    const id = Number(chainId)
    if (!states.has(id)) {
      states.set(id, {
        chainId: id,
        lastScannedBlock: null,
        chainHeadBlock: null,
        backlogBlockCount: 0,
        coverageFromBlock: null,
        collections: new Map(),
        events: [],
        metadata: new Map(),
        status: "starting",
        error: "",
        scanStrategy: null,
        scanDiagnostics: [],
        coverageLimited: false,
        updatedAt: "",
        polling: false,
        scanPromise: null,
        scanDurationMs: null,
        scannedBlockCount: 0,
        lastScanEventCount: 0,
        pendingByCollection: new Map(),
        pendingTrackedCollections: new Set(),
        pendingSupported: false,
        pendingCoverage: "unavailable",
        pendingSources: [],
        pendingUpdatedAt: null,
        pendingStats: { transactionCount: 0, decodedTransactionCount: 0, unknownTransactionCount: 0, tokenCount: "0" },
        chainMetrics: null,
        metricsCheckedAt: 0,
        metricsPromise: null,
        supplyRefreshKey: "",
        supplyRefreshPromise: null,
        providerHydrations: new Map(),
        timer: null,
      })
    }
    return states.get(id)
  }

  function publish(chainId, value) {
    for (const listener of subscribers.get(Number(chainId)) || []) listener(value)
  }

  function subscribe(chainId, listener) {
    const id = Number(chainId)
    if (!subscribers.has(id)) subscribers.set(id, new Set())
    subscribers.get(id).add(listener)
    return () => subscribers.get(id)?.delete(listener)
  }

  function ingestRemoved(chainId, eventIds, { rewindBlock = null } = {}) {
    const state = stateFor(chainId)
    const requested = [...new Set((eventIds || []).map(String).filter(Boolean))]
    if (!requested.length) return []
    const targets = new Set(requested)
    const removed = new Set()
    state.events = state.events.filter((event) => {
      if (!targets.has(event.id)) return true
      removed.add(event.id)
      return false
    })
    for (const collection of state.collections.values()) {
      const retained = []
      let changed = false
      for (const event of collection.events || []) {
        if (targets.has(event.id)) {
          removed.add(event.id)
          changed = true
        } else retained.push(event)
      }
      if (!changed) continue
      collection.events = retained
      collection.minters = new Set(retained.map((event) => String(event.recipient || "").toLowerCase()).filter(Boolean))
      collection.lastMintAt = retained[0]?.timestamp || 0
      collection.lastPriceWei = retained.find((event) => event.unitPriceWei !== null && event.unitPriceWei !== undefined)?.unitPriceWei ?? null
    }
    const removedEventIds = requested.filter((eventId) => removed.has(eventId))
    if (rewindBlock !== null && rewindBlock !== undefined && state.lastScannedBlock !== null) {
      const rewindTo = BigInt(rewindBlock) - 1n
      if (rewindTo < state.lastScannedBlock) state.lastScannedBlock = rewindTo
    }
    if (removedEventIds.length) {
      publish(chainId, {
        type: "discard",
        chainId: Number(chainId),
        eventIds: removedEventIds,
        removedCount: removedEventIds.length,
      })
    }
    return removedEventIds
  }

  function pendingFields(state, address) {
    const normalizedAddress = String(address || "").toLowerCase()
    const available = state.pendingCoverage !== "unavailable" && state.pendingTrackedCollections.has(normalizedAddress)
    const value = state.pendingByCollection.get(normalizedAddress)
    return {
      pending_token_count: available ? value?.tokenCount || "0" : null,
      pending_unknown_tx_count: available ? Number(value?.unknownTxCount || 0) : 0,
      pending_transaction_count: available ? Number(value?.transactionCount || 0) : null,
      pending_coverage: state.pendingCoverage,
      pending_sources: state.pendingSources.map((source) => ({ name: source.name, ok: source.ok })),
    }
  }

  function snapshotData(state, collection) {
    const pending = pendingFields(state, collection.address)
    const openseaVerified = Boolean(collection.openseaVerified && collection.openseaUrl)
    const platformTags = uniqueMessages(collection.platformTags || []).filter((tag) => tag.toLowerCase() !== "opensea" || openseaVerified)
    return {
      supply_block_number: collection.supplyBlockNumber || null,
      current_supply: collection.currentSupply ?? null,
      max_supply: collection.maxSupply ?? null,
      ...pending,
      image_url: collection.imageUrl || null,
      image_source: collection.imageSource || null,
      image_updated_at: collection.imageUpdatedAt || null,
      website: collection.website || null,
      twitter: collection.twitter || null,
      discord_url: collection.discordUrl || null,
      opensea_url: openseaVerified ? collection.openseaUrl : null,
      opensea_verified: openseaVerified,
      funding_tags: collection.fundingTags || [],
      platform_tags: platformTags,
      status_tags: collection.statusTags || [],
      contract_created_at: collection.contractCreatedAt || null,
      contract_created_block: collection.contractCreatedBlock || null,
      creator_address: collection.creatorAddress || "",
      deployer_profile: collection.deployerProfile || null,
    }
  }

  function applySnapshotToEvent(event, snapshot) {
    event.collection_snapshot = snapshot
    event.currentSupply = snapshot.current_supply
    event.maxSupply = snapshot.max_supply
    event.pendingCount = snapshot.pending_token_count
    event.pendingUnknownTxCount = snapshot.pending_unknown_tx_count
    event.pendingTransactionCount = snapshot.pending_transaction_count
    event.pendingCoverage = snapshot.pending_coverage
    event.projectImageUrl = snapshot.image_url || ""
    event.imageSource = snapshot.image_source || null
    event.website = snapshot.website || ""
    event.twitter = snapshot.twitter || ""
    event.discord_url = snapshot.discord_url || ""
    event.opensea_url = snapshot.opensea_url || ""
    event.openseaVerified = snapshot.opensea_verified
    event.fundingTags = snapshot.funding_tags
    event.platformTags = snapshot.platform_tags
    event.statusTags = snapshot.status_tags
    event.contractCreatedAt = snapshot.contract_created_at
    event.contractCreatedBlock = snapshot.contract_created_block
    event.creatorAddress = snapshot.creator_address
    event.deployerProfile = snapshot.deployer_profile
  }

  function commitCollectionSnapshot(chainId, state, collection, { broadcast = true } = {}) {
    const data = snapshotData(state, collection)
    const fingerprint = JSON.stringify(data)
    if (collection.snapshotFingerprint === fingerprint && collection.collectionSnapshot) return collection.collectionSnapshot
    collection.snapshotFingerprint = fingerprint
    collection.snapshotVersion = Number(collection.snapshotVersion || 0) + 1
    collection.snapshotUpdatedAt = new Date().toISOString()
    const snapshot = {
      version: collection.snapshotVersion,
      updated_at: collection.snapshotUpdatedAt,
      ...data,
    }
    collection.collectionSnapshot = snapshot
    collection.platformTags = snapshot.platform_tags
    for (const event of collection.events || []) applySnapshotToEvent(event, snapshot)
    if (broadcast) publish(chainId, {
      type: "collection_update",
      chainId: Number(chainId),
      address: collection.address,
      collection_snapshot: snapshot,
    })
    return snapshot
  }

  function publishStatusMetrics(chainId, state) {
    publish(chainId, {
      type: "monitor_status",
      status: state.status,
      chainId: Number(chainId),
      chainMetrics: state.chainMetrics,
      pendingSupported: state.pendingSupported,
      pendingCoverage: state.pendingCoverage,
      pendingSources: state.pendingSources,
      pendingUpdatedAt: state.pendingUpdatedAt,
      pendingStats: state.pendingStats,
      updatedAt: state.updatedAt,
    })
  }

  function refreshChainMetrics(chainId, client, state) {
    if (state.metricsPromise || Date.now() - state.metricsCheckedAt < 10_000) return state.metricsPromise
    state.metricsCheckedAt = Date.now()
    state.metricsPromise = (async () => {
      const [block, fees, gasPrice, explorer] = await Promise.all([
        client.getBlock({ blockTag: "latest" }).catch(() => null),
        typeof client.estimateFeesPerGas === "function" ? client.estimateFeesPerGas().catch(() => null) : null,
        typeof client.getGasPrice === "function" ? client.getGasPrice().catch(() => null) : null,
        enableIntel ? intel.stats(chainId) : null,
      ])
      state.chainMetrics = {
        blockNumber: state.chainHeadBlock?.toString() || null,
        maxFeeGwei: compactGwei(fees?.maxFeePerGas),
        priorityFeeGwei: compactGwei(fees?.maxPriorityFeePerGas),
        baseFeeGwei: compactGwei(block?.baseFeePerGas),
        gasPriceGwei: compactGwei(gasPrice),
        coinPriceUsd: explorer?.coinPriceUsd ?? null,
        explorerGasGwei: explorer?.explorerGasGwei ?? null,
        updatedAt: new Date().toISOString(),
      }
      publishStatusMetrics(chainId, state)
      return state.chainMetrics
    })().finally(() => {
      state.metricsPromise = null
    })
    return state.metricsPromise
  }

  async function refreshPendingCounts(chainId, client, state) {
    if (!state.collections.size) return
    const result = await collectPendingTransactions({
      client,
      fetchImpl,
      blockscoutBase: enableIntel ? blockscoutBases[Number(chainId)] || "" : "",
    })
    const collectionKeys = new Set(state.collections.keys())
    state.pendingTrackedCollections = new Set(collectionKeys)
    const abiTargets = [...new Set(result.transactions.map((transaction) => transaction.to).filter((address) => collectionKeys.has(address)))]
    const abiByAddress = new Map()
    if (enableIntel) {
      await mapConcurrent(abiTargets, 4, async (address) => {
        const abi = await intel.contractAbi(chainId, address)
        if (abi) abiByAddress.set(address, abi)
      })
    }
    state.pendingByCollection = aggregatePendingMints(result.transactions, collectionKeys, abiByAddress)
    state.pendingCoverage = result.coverage
    const previousSources = new Map(state.pendingSources.map((source) => [source.name, source]))
    state.pendingSources = result.sources.map((source) => ({
      ...source,
      lastSuccessAt: source.lastSuccessAt || previousSources.get(source.name)?.lastSuccessAt || null,
    }))
    state.pendingUpdatedAt = result.updatedAt
    state.pendingSupported = result.coverage !== "unavailable"
    let tokenCount = 0n
    let transactionCount = 0
    let unknownTransactionCount = 0
    for (const value of state.pendingByCollection.values()) {
      tokenCount += BigInt(value.tokenCount)
      transactionCount += value.transactionCount
      unknownTransactionCount += value.unknownTxCount
    }
    state.pendingStats = {
      transactionCount,
      decodedTransactionCount: transactionCount - unknownTransactionCount,
      unknownTransactionCount,
      tokenCount: tokenCount.toString(),
    }
    for (const collection of state.collections.values()) commitCollectionSnapshot(chainId, state, collection)
  }

  function enrichMintEvent(chainId, event, meta) {
    if (!enableIntel) return
    void Promise.all([
      intel.collection(chainId, event.address),
      intel.method({ chainId, selector: event.selector, txHash: event.txHash, target: event.mintTarget || event.address }),
      intel.marketCollection(chainId, event.address),
    ]).then(async ([collectionIntel, methodIntel, marketIntel]) => {
      const deployerProfile = collectionIntel?.creatorAddress && deployerProfileStore
        ? await deployerProfileStore.get(chainId, collectionIntel.creatorAddress, {
          youngWalletDays: deployerYoungWalletDays,
          projectCountThreshold: deployerProjectRiskCount,
        })
        : null
      const platformTags = uniqueMessages([
        ...(event.platformTags || []),
        ...(collectionIntel?.platformTags || []).filter((tag) => String(tag).toLowerCase() !== "opensea"),
        ...(methodIntel?.platformTags || []),
        ...(marketIntel?.verified ? ["OpenSea"] : []),
      ])
      const update = {
        methodName: methodIntel?.methodName || event.methodName || event.selector || "",
        contractCreatedAt: collectionIntel?.contractCreatedAt || null,
        contractCreatedBlock: collectionIntel?.contractCreatedBlock || null,
        creatorAddress: collectionIntel?.creatorAddress || "",
        fundingTags: collectionIntel?.fundingTags || [],
        platformTags,
        statusTags: collectionIntel?.statusTags || [],
        website: marketIntel?.website || event.website || "",
        twitter: marketIntel?.twitter || event.twitter || "",
        discordUrl: marketIntel?.discordUrl || event.discord_url || "",
        openseaUrl: marketIntel?.verified ? marketIntel.openseaUrl : "",
        openseaVerified: Boolean(marketIntel?.verified && marketIntel?.openseaUrl),
        deployerProfile,
      }
      Object.assign(event, update)
      const collection = stateFor(chainId).collections.get(event.address.toLowerCase())
      if (collection) {
        Object.assign(collection, update)
        commitCollectionSnapshot(chainId, stateFor(chainId), collection)
      }
      Object.assign(meta, update)
      publish(chainId, { type: "mint_update", id: event.id, chainId: Number(chainId), address: event.address, ...update })
    }).catch(() => {})
  }

  async function settlesWithin(promise, timeoutMs) {
    let timer
    try {
      return await Promise.race([
        Promise.resolve(promise).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function prewarmOverviewMedia(rows) {
    if (typeof mediaResolver?.loadMedia !== "function") return
    const ids = uniqueMessages((rows || []).flatMap((row) => [
      row.image_url,
      row.image_fallback_url,
      row.projectImageUrl,
      row.imageFallbackUrl,
      row.imageUrl,
    ]).map((url) => /^\/api\/mint-monitor\/media\/([a-f0-9]{32})(?:[?#].*)?$/i.exec(String(url || ""))?.[1]?.toLowerCase()).filter(Boolean))
    if (!ids.length) return
    await mapConcurrent(ids, Math.max(1, Math.min(32, Number(overviewMediaPrewarmConcurrency) || 1)), async (id) => {
      try {
        await mediaResolver.loadMedia(id)
      } catch {
        // A failed preferred source remains eligible for the browser's next fallback.
      }
    })
  }

  function drainMediaQueue() {
    while (mediaResolver && activeMediaJobs < 4 && collectionMediaQueue.length) {
      const job = collectionMediaQueue.shift()
      activeMediaJobs += 1
      void (async () => {
        const market = job.collectionKey && enableIntel ? await intel.marketCollection(job.event.chainId, job.event.address) : null
        const resolver = job.collectionKey && typeof mediaResolver.resolveProject === "function"
          ? mediaResolver.resolveProject.bind(mediaResolver)
          : mediaResolver.resolveToken.bind(mediaResolver)
        const tokenMedia = await resolver({ ...job.request, marketImageUrl: market?.imageUrl || "" })
        const state = stateFor(job.event.chainId)
        const collection = state.collections.get(job.event.address.toLowerCase())
        if (job.collectionKey && collection) {
          collection.imageUrl = tokenMedia?.imageUrl || collection.imageUrl || null
          collection.imageSource = tokenMedia?.imageSource || (tokenMedia?.imageUrl ? "token_uri" : collection.imageSource || null)
          collection.imageUpdatedAt = tokenMedia?.imageUrl ? new Date().toISOString() : collection.imageUpdatedAt || null
          collection.website = tokenMedia?.website || market?.website || collection.website || ""
          collection.twitter = tokenMedia?.twitter || market?.twitter || collection.twitter || ""
          collection.discordUrl = tokenMedia?.discordUrl || market?.discordUrl || collection.discordUrl || ""
          collection.openseaUrl = market?.verified ? market.openseaUrl : collection.openseaUrl || ""
          collection.openseaVerified = Boolean(market?.verified && market?.openseaUrl) || Boolean(collection.openseaVerified)
          collection.platformTags = uniqueMessages([
            ...(collection.platformTags || []).filter((tag) => String(tag).toLowerCase() !== "opensea"),
            ...(collection.openseaVerified ? ["OpenSea"] : []),
          ])
          commitCollectionSnapshot(job.event.chainId, state, collection)
          job.event.projectImageUrl = collection.imageUrl || ""
        }
        if (!tokenMedia?.imageUrl) return
        Object.assign(job.event, job.collectionKey ? {
          projectImageUrl: tokenMedia.imageUrl,
          imageUrl: tokenMedia.imageUrl,
          image_url: tokenMedia.imageUrl,
          tokenName: tokenMedia.tokenName || job.event.tokenName || "",
        } : {
          imageUrl: tokenMedia.imageUrl,
          image_url: tokenMedia.imageUrl,
          tokenName: tokenMedia.tokenName || "",
        })
        publish(job.event.chainId, {
          type: "mint_update",
          id: job.event.id,
          chainId: job.event.chainId,
          address: job.event.address,
          txHash: job.event.txHash,
          tokenIds: job.event.tokenIds,
          ...(job.collectionKey
            ? { projectImageUrl: tokenMedia.imageUrl, imageUrl: tokenMedia.imageUrl, image_url: tokenMedia.imageUrl, imageSource: tokenMedia.imageSource || "token_uri" }
            : { imageUrl: tokenMedia.imageUrl, image_url: tokenMedia.imageUrl }),
          tokenName: tokenMedia.tokenName || "",
        })
        return tokenMedia
      })().catch(() => null).then((result) => job.resolve?.(result)).finally(() => {
        if (job.collectionKey) pendingCollectionMedia.delete(job.collectionKey)
        if (job.collectionKey) collectionMediaPromises.delete(job.collectionKey)
        activeMediaJobs -= 1
        drainMediaQueue()
      })
    }
  }

  function enqueueMedia(request, event) {
    if (!mediaResolver) return Promise.resolve(null)
    const collectionKey = `${event.chainId}:${event.address.toLowerCase()}`
    const collection = stateFor(event.chainId).collections.get(event.address.toLowerCase())
    const tokenId = event.tokenIds?.[0] || ""
    const job = { request: { ...request, tokenId }, event }
    if (!collection?.imageUrl && !pendingCollectionMedia.has(collectionKey)) {
      let resolve
      const promise = new Promise((settle) => { resolve = settle })
      pendingCollectionMedia.add(collectionKey)
      collectionMediaPromises.set(collectionKey, promise)
      collectionMediaQueue.push({ ...job, collectionKey, resolve })
    }
    drainMediaQueue()
    const pending = collectionMediaPromises.get(collectionKey)
    if (!pending) {
      if (collection?.collectionSnapshot) applySnapshotToEvent(event, collection.collectionSnapshot)
      return Promise.resolve(collection?.imageUrl || null)
    }
    return pending.then((result) => {
      const latest = stateFor(event.chainId).collections.get(event.address.toLowerCase())
      if (latest?.collectionSnapshot) applySnapshotToEvent(event, latest.collectionSnapshot)
      return result
    })
  }

  async function hydrateProviderCollections(chainId, state, rows) {
    const blockNumber = state.chainHeadBlock
    if (blockNumber === null) return
    const client = getClient(chainId)
    const candidates = [...new Map((rows || [])
      .filter((row) => /^0x[a-fA-F0-9]{40}$/.test(String(row.address || "")))
      .map((row) => [row.address.toLowerCase(), row])).values()]
    await mapConcurrent(candidates, METADATA_FETCH_CONCURRENCY, async (row) => {
      const key = row.address.toLowerCase()
      if (state.collections.has(key)) return
      if (state.providerHydrations.has(key)) return state.providerHydrations.get(key)
      const pending = (async () => {
        const metadata = await readCollectionMetadata(client, row.address, row.token_standard || "ERC721", blockNumber)
        const collection = {
          ...metadata,
          events: [],
          minters: new Set(),
          lastMintAt: row.last_mint_time || 0,
          lastPriceWei: row.mint_price_raw ?? null,
          contractCreatedAt: row.contract_created_at || null,
          contractCreatedBlock: row.contract_created_block || null,
          creatorAddress: row.creator_address || "",
          fundingTags: row.funding_tags || [],
          platformTags: (row.platform_tags || []).filter((tag) => String(tag).toLowerCase() !== "opensea"),
          statusTags: row.status_tags || [],
          website: row.website || "",
          twitter: row.twitter || "",
          discordUrl: row.discord_url || "",
        }
        state.collections.set(key, collection)
        state.metadata.set(key, metadata)
        commitCollectionSnapshot(chainId, state, collection)
        const preview = row.recent_mint_preview?.[0] || {}
        const mediaEvent = {
          id: `provider:${Number(chainId)}:${key}`,
          chainId: Number(chainId),
          address: row.address,
          tokenIds: preview.token_id === null || preview.token_id === undefined ? [] : [String(preview.token_id)],
          tokenStandard: metadata.tokenStandard,
          timestamp: Number(row.last_mint_time || Math.floor(Date.now() / 1000)),
          txHash: preview.tx_hash || "",
          selector: "",
          mintTarget: row.address,
          platformTags: collection.platformTags,
        }
        await enqueueMedia({ client, chainId: Number(chainId), address: row.address, tokenStandard: metadata.tokenStandard }, mediaEvent)
        enrichMintEvent(chainId, mediaEvent, metadata)
      })().finally(() => state.providerHydrations.delete(key))
      state.providerHydrations.set(key, pending)
      await pending
    })
  }

  async function providerOverview() {
    if (!providerBase) return null
    if (providerCache && Date.now() - providerCheckedAt < 15000) return providerCache
    if (providerError && Date.now() - providerCheckedAt < 60000) return null
    providerCheckedAt = Date.now()
    try {
      const response = await fetchImpl(`${providerBase}/api/overview/all`, {
        headers: {
          accept: "application/json",
          origin: "https://waypoint.tools",
          referer: "https://waypoint.tools/mintscan/",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36",
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = normalizeProviderRows(await response.json())
      providerCache = payload
      providerError = ""
      return payload
    } catch (error) {
      providerError = message(error)
      providerCache = null
      return null
    }
  }

  async function enrichCollectionGas(client, collection) {
    const candidates = collection.events
      .slice(0, COLLECTION_GAS_EVENT_LIMIT)
      .filter((event) => !event.gasChecked && !event.gasFeeNative)
    await mapConcurrent(candidates, COLLECTION_GAS_CONCURRENCY, async (event) => {
      const receipt = await client.getTransactionReceipt({ hash: event.txHash }).catch(() => null)
      event.gasChecked = true
      const gasUsed = BigInt(receipt?.gasUsed || 0n)
      const effectiveGasPrice = BigInt(receipt?.effectiveGasPrice || receipt?.gasPrice || 0n)
      if (!gasUsed || !effectiveGasPrice) return
      const gasFeeWei = gasUsed * effectiveGasPrice
      event.gasUsed = gasUsed.toString()
      event.effectiveGasPriceWei = effectiveGasPrice.toString()
      event.gasFeeWei = gasFeeWei.toString()
      event.gasFeeNative = formatEther(gasFeeWei)
    })
  }

  async function providerCollection(address, chainKey) {
    if (!providerBase || providerError) return null
    const key = `${chainKey}:${address.toLowerCase()}`
    const cached = providerCollectionCache.get(key)
    if (cached && Date.now() - cached.checkedAt < 60000) return cached.value
    if (providerCollectionRequests.has(key)) return providerCollectionRequests.get(key)
    const request = (async () => {
      try {
        const response = await fetchImpl(`${providerBase}/api/collection/${address}?chain=${encodeURIComponent(chainKey)}`, {
          headers: { accept: "application/json", origin: "https://waypoint.tools", referer: "https://waypoint.tools/mintscan/" },
          signal: AbortSignal.timeout(15000),
        })
        const value = response.ok ? await response.json() : null
        providerCollectionCache.set(key, { value, checkedAt: Date.now() })
        return value
      } catch {
        providerCollectionCache.set(key, { value: null, checkedAt: Date.now() })
        return null
      } finally {
        providerCollectionRequests.delete(key)
      }
    })()
    providerCollectionRequests.set(key, request)
    return request
  }

  function cachedProviderCollection(address, chainKey) {
    const cached = providerCollectionCache.get(`${chainKey}:${address.toLowerCase()}`)
    return cached && Date.now() - cached.checkedAt < 60000 ? cached.value : null
  }

  async function scanWithLogs(client, fromBlock, toBlock) {
    const results = []
    const errors = []
    for (const event of MINT_EVENTS) {
      try {
        results.push(await client.getLogs({ event, args: { from: zeroAddress }, fromBlock, toBlock }))
      } catch (error) {
        errors.push(`${event.name}: ${message(error)}`)
      }
    }
    if (errors.length) {
      throw new Error(`eth_getLogs failed (${errors.join(" | ")})`)
    }
    return results.flat()
  }

  async function scanWithBlockLogs(client, fromBlock, toBlock) {
    const blocks = []
    for (let block = fromBlock; block <= toBlock; block += 1n) blocks.push(block)
    const batches = await mapConcurrent(blocks, RECEIPT_SCAN_CONCURRENCY, async (blockNumber) => {
      const logs = await client.request({
        method: "eth_getLogs",
        params: [{
          fromBlock: toHex(blockNumber),
          toBlock: toHex(blockNumber),
          topics: [MINT_EVENT_TOPICS],
        }],
      })
      if (!Array.isArray(logs)) throw new Error("RPC returned a non-array log payload")
      return logs.map((log) => decodeMintReceiptLog(log, blockNumber)).filter(Boolean)
    })
    return batches.flat()
  }

  function decodeMintReceiptLog(log, blockNumber, receipt = null) {
    for (const event of MINT_EVENTS) {
      try {
        const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics, strict: true })
        const parsed = {
          ...log,
          address: log.address,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber == null ? blockNumber : BigInt(log.blockNumber),
          eventName: decoded.eventName,
          args: decoded.args,
          receipt,
        }
        return isZeroFrom(parsed) ? parsed : null
      } catch {
        // The receipt can contain arbitrary events; only NFT transfer signatures are relevant.
      }
    }
    return null
  }

  async function receiptsForBlock(client, blockNumber) {
    try {
      const receipts = await client.request({
        method: "eth_getBlockReceipts",
        params: [toHex(blockNumber)],
      })
      if (!Array.isArray(receipts)) throw new Error("RPC returned a non-array block receipt payload")
      return { receipts, strategy: "block_receipts" }
    } catch (blockReceiptError) {
      let block
      try {
        block = await client.request({
          method: "eth_getBlockByNumber",
          params: [toHex(blockNumber), false],
        })
      } catch (error) {
        throw new Error(`eth_getBlockReceipts: ${message(blockReceiptError)}; eth_getBlockByNumber: ${message(error)}`)
      }
      const hashes = block?.transactions || []
      try {
        const receipts = await mapConcurrent(hashes, RECEIPT_FETCH_CONCURRENCY, (hash) => client.request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        }))
        return { receipts, strategy: "transaction_receipts" }
      } catch (error) {
        throw new Error(`eth_getBlockReceipts: ${message(blockReceiptError)}; eth_getTransactionReceipt: ${message(error)}`)
      }
    }
  }

  async function scanWithReceipts(client, fromBlock, toBlock) {
    const blocks = []
    for (let block = fromBlock; block <= toBlock; block += 1n) blocks.push(block)
    const batches = await mapConcurrent(blocks, RECEIPT_SCAN_CONCURRENCY, async (blockNumber) => {
      const result = await receiptsForBlock(client, blockNumber)
      return {
        logs: result.receipts.flatMap((receipt) => (receipt?.logs || [])
          .map((log) => decodeMintReceiptLog(log, blockNumber, receipt))
          .filter(Boolean)),
        strategy: result.strategy,
      }
    })
    const strategies = new Set(batches.map((batch) => batch.strategy))
    return {
      logs: batches.flatMap((batch) => batch.logs),
      strategy: strategies.size === 1 ? [...strategies][0] : "mixed_receipts",
    }
  }

  async function fetchMintLogs(client, fromBlock, toBlock) {
    try {
      return {
        logs: await scanWithLogs(client, fromBlock, toBlock),
        strategy: "eth_getLogs",
        diagnostics: [],
        coverageFromBlock: fromBlock,
        coverageToBlock: toBlock,
      }
    } catch (logError) {
      const fallbackToBlock = toBlock - fromBlock + 1n > MAX_RECEIPT_FALLBACK_BLOCKS
        ? fromBlock + MAX_RECEIPT_FALLBACK_BLOCKS - 1n
        : toBlock
      try {
        return {
          logs: await scanWithBlockLogs(client, fromBlock, fallbackToBlock),
          strategy: "per_block_eth_getLogs",
          diagnostics: [
            `Range log scan unavailable: ${compactError(logError)}`,
            ...(fallbackToBlock < toBlock ? [`Per-block scan continues in contiguous ${MAX_RECEIPT_FALLBACK_BLOCKS}-block batches for RPC safety`] : []),
          ],
          coverageFromBlock: fromBlock,
          coverageToBlock: fallbackToBlock,
        }
      } catch (blockLogError) {
        try {
          const receiptResult = await scanWithReceipts(client, fromBlock, fallbackToBlock)
          return {
            ...receiptResult,
            diagnostics: [
              `Range log scan unavailable: ${compactError(logError)}`,
              `Per-block log scan unavailable: ${compactError(blockLogError)}`,
              ...(fallbackToBlock < toBlock ? [`Receipt scan continues in contiguous ${MAX_RECEIPT_FALLBACK_BLOCKS}-block batches for RPC safety`] : []),
            ],
            coverageFromBlock: fromBlock,
            coverageToBlock: fallbackToBlock,
          }
        } catch (receiptError) {
          throw new Error(`No mint scan strategy succeeded: ${compactError(logError)}; per-block logs: ${compactError(blockLogError)}; receipts: ${compactError(receiptError)}`)
        }
      }
    }
  }

  async function scan(chainId) {
    const state = stateFor(chainId)
    if (state.scanPromise) return state.scanPromise
    state.scanPromise = runCatchUp(chainId, state)
    try {
      return await state.scanPromise
    } finally {
      state.scanPromise = null
    }
  }

  async function runCatchUp(chainId, state) {
    do {
      await runScan(chainId, state)
    } while (state.status !== "degraded" && state.backlogBlockCount > 0)
    return state
  }

  async function runScan(chainId, state) {
    const scanStartedAt = performance.now()
    state.polling = true
    try {
      const chain = getChain(chainId)
      const nativeSymbol = chainNativeSymbol(chain)
      const client = getClient(chainId)
      const latest = await client.getBlockNumber()
      state.chainHeadBlock = latest
      void refreshChainMetrics(chainId, client, state)
      let fromBlock = state.lastScannedBlock === null
        ? latest > BigInt(initialBlocks) ? latest - BigInt(initialBlocks) : 0n
        : state.lastScannedBlock + 1n
      if (fromBlock > latest) {
        await refreshPendingCounts(chainId, client, state)
        state.status = "live"
        state.error = ""
        state.updatedAt = new Date().toISOString()
        state.scanDurationMs = Math.round(performance.now() - scanStartedAt)
        state.scannedBlockCount = 0
        state.lastScanEventCount = 0
        state.backlogBlockCount = 0
        publish(chainId, {
          type: "monitor_status",
          status: "live",
          chainId: Number(chainId),
          scanStrategy: state.scanStrategy,
          coverageFromBlock: state.coverageFromBlock?.toString() || null,
          latestBlock: state.lastScannedBlock?.toString() || null,
          chainHeadBlock: state.chainHeadBlock.toString(),
          backlogBlockCount: 0,
          updatedAt: state.updatedAt,
          scanDurationMs: state.scanDurationMs,
          scannedBlockCount: 0,
          lastScanEventCount: 0,
          chainMetrics: state.chainMetrics,
          pendingSupported: state.pendingSupported,
          pendingCoverage: state.pendingCoverage,
          pendingSources: state.pendingSources,
          pendingUpdatedAt: state.pendingUpdatedAt,
          pendingStats: state.pendingStats,
        })
        return state
      }
      const safeMaxBlocks = BigInt(Math.max(1, Math.floor(maxBlocksPerScan)))
      const requestedToBlock = fromBlock + safeMaxBlocks - 1n < latest ? fromBlock + safeMaxBlocks - 1n : latest
      const scanResult = await fetchMintLogs(client, fromBlock, requestedToBlock)
      const processedToBlock = scanResult.coverageToBlock ?? requestedToBlock
      const logs = scanResult.logs.filter(isZeroFrom)
      if (state.coverageFromBlock === null) state.coverageFromBlock = scanResult.coverageFromBlock ?? fromBlock
      state.scanStrategy = scanResult.strategy
      state.scanDiagnostics = uniqueMessages(scanResult.diagnostics)
      state.coverageLimited ||= (scanResult.coverageFromBlock ?? fromBlock) > fromBlock
      const groups = new Map()
      for (const log of logs) {
        const key = `${log.transactionHash}:${log.address.toLowerCase()}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(log)
      }

      const transactionCache = new Map()
      const blockCache = new Map()
      const touchedCollections = new Map()
      const pendingEvents = []
      const existingEventIds = new Set(state.events.map((event) => event.id))
      const collectionDescriptors = new Map()
      for (const group of groups.values()) {
        const first = group[0]
        const key = first.address.toLowerCase()
        if (!state.metadata.has(key)) {
          collectionDescriptors.set(key, {
            address: first.address,
            standard: first.eventName === "Transfer" ? "ERC721" : "ERC1155",
          })
        }
      }
      await mapConcurrent([...collectionDescriptors.entries()], METADATA_FETCH_CONCURRENCY, async ([key, descriptor]) => {
        state.metadata.set(key, await readCollectionMetadata(client, descriptor.address, descriptor.standard, processedToBlock))
      })

      function cachedRead(cache, key, loader) {
        if (!cache.has(key)) cache.set(key, Promise.resolve().then(loader).catch(() => null))
        return cache.get(key)
      }

      const enrichedGroups = await mapConcurrent([...groups.values()], MINT_ENRICH_CONCURRENCY, async (group) => {
        const first = group[0]
        const address = first.address
        const meta = state.metadata.get(address.toLowerCase())
        const [transaction, block] = await Promise.all([
          cachedRead(transactionCache, first.transactionHash, () => client.getTransaction({ hash: first.transactionHash })),
          cachedRead(blockCache, String(first.blockNumber), () => client.getBlock({ blockNumber: first.blockNumber })),
        ])
        const receipt = first.receipt || null
        const quantity = group.reduce((sum, log) => sum + mintCount(log), 0n)
        const value = transaction?.value === null || transaction?.value === undefined ? null : BigInt(transaction.value)
        const unitPrice = value === null ? null : quantity > 0n ? value / quantity : value
        const ids = group.flatMap(tokenIds)
        const eventRecipient = recipient(first)
        const transactionSender = transaction?.from || ""
        const gasUsed = BigInt(receipt?.gasUsed || 0n)
        const effectiveGasPrice = BigInt(receipt?.effectiveGasPrice || receipt?.gasPrice || transaction?.gasPrice || 0n)
        const gasFeeWei = gasUsed * effectiveGasPrice
        const calldata = calldataShape(transaction?.input)
        const pending = pendingFields(state, address)
        const event = {
          id: `${first.transactionHash}:${address.toLowerCase()}`,
          type: "mint",
          source: "direct_rpc",
          chainId: Number(chainId),
          chainKey: chain.key,
          chainName: chain.name,
          address,
          name: meta.name,
          symbol: meta.symbol,
          tokenStandard: meta.tokenStandard,
          recipient: eventRecipient,
          minter: transactionSender,
          txHash: first.transactionHash,
          mintTarget: transaction?.to || address,
          blockNumber: first.blockNumber.toString(),
          timestamp: Number(block?.timestamp || BigInt(Math.floor(Date.now() / 1000))),
          quantity: quantity.toString(),
          tokenIds: ids.slice(0, 20),
          mintValueWei: value === null ? null : value.toString(),
          unitPriceWei: unitPrice === null ? null : unitPrice.toString(),
          mintPrice: unitPrice === null ? "Unknown" : shortPrice(unitPrice, nativeSymbol),
          gasUsed: gasUsed ? gasUsed.toString() : null,
          gasLimit: transaction?.gas === null || transaction?.gas === undefined ? null : transaction.gas.toString(),
          effectiveGasPriceWei: effectiveGasPrice ? effectiveGasPrice.toString() : null,
          gasFeeWei: gasUsed && effectiveGasPrice ? gasFeeWei.toString() : null,
          gasFeeNative: gasUsed && effectiveGasPrice ? formatEther(gasFeeWei) : null,
          nativeSymbol,
          isFree: value === 0n,
          isAirdrop: value === 0n && transactionSender && transactionSender.toLowerCase() !== eventRecipient.toLowerCase(),
          isMintable: true,
          confirmed: true,
          selector: calldata.selector,
          calldataBytes: calldata.calldataBytes,
          parameterCount: calldata.parameterCount,
          currentSupply: meta.currentSupply,
          maxSupply: meta.maxSupply,
          platform: mintPlatform(meta),
          methodName: knownMintMethod(calldata.selector) || calldata.selector,
          contractCreatedAt: meta.contractCreatedAt || null,
          contractCreatedBlock: meta.contractCreatedBlock || null,
          creatorAddress: meta.creatorAddress || "",
          fundingTags: meta.fundingTags || [],
          platformTags: uniqueMessages([meta.platform, mintPlatform(meta)]),
          statusTags: meta.statusTags || [],
          pendingCount: pending.pending_token_count,
          pendingUnknownTxCount: pending.pending_unknown_tx_count,
          pendingTransactionCount: pending.pending_transaction_count,
          pendingCoverage: pending.pending_coverage,
        }
        return { address, event, meta, quantity, transaction }
      })

      const newEntries = []
      for (const { address, event, meta, transaction } of enrichedGroups) {
        if (existingEventIds.has(event.id)) continue
        existingEventIds.add(event.id)
        const key = address.toLowerCase()
        const collection = state.collections.get(key) || { ...meta, events: [], minters: new Set() }
        collection.lastMintAt = event.timestamp
        if (event.unitPriceWei !== null) collection.lastPriceWei = event.unitPriceWei
        collection.lastMintTransaction = transaction ? { to: transaction.to, input: transaction.input } : null
        collection.isAirdrop = event.isAirdrop
        collection.isMintable = true
        state.collections.set(key, collection)
        touchedCollections.set(key, collection)
        newEntries.push({ address, event, meta, collection })
      }
      for (const { address, event, meta, collection } of newEntries) {
        state.events.unshift(event)
        collection.events.unshift(event)
        collection.events = collection.events.slice(0, MAX_COLLECTION_EVENTS)
        collection.minters.add(event.recipient.toLowerCase())
        minterStore?.recordMinter(Number(chainId), address, event.recipient)
        enqueueMinterBackfill(chainId, address)
        applySnapshotToEvent(event, commitCollectionSnapshot(chainId, state, collection, { broadcast: false }))
        pendingEvents.push(event)
        publish(chainId, event)
        enrichMintEvent(chainId, event, meta)
        void enqueueMedia({
          client,
          chainId: Number(chainId),
          address,
          tokenStandard: meta.tokenStandard,
        }, event).catch(() => null)
      }
      await mapConcurrent([...touchedCollections.values()], 6, (collection) => (
        refreshCollectionState(client, collection, processedToBlock)
      ))
      await refreshPendingCounts(chainId, client, state)
      for (const collection of touchedCollections.values()) commitCollectionSnapshot(chainId, state, collection)
      state.events = state.events.slice(0, MAX_EVENTS_PER_CHAIN)
      state.lastScannedBlock = processedToBlock
      state.backlogBlockCount = Number(latest - processedToBlock)
      state.status = state.backlogBlockCount > 0 ? "catching_up" : "live"
      state.error = ""
      state.updatedAt = new Date().toISOString()
      state.scanDurationMs = Math.round(performance.now() - scanStartedAt)
      state.scannedBlockCount = Number(processedToBlock - fromBlock + 1n)
      state.lastScanEventCount = pendingEvents.length
      publish(chainId, {
        type: "monitor_status",
        status: state.status,
        chainId: Number(chainId),
        scanStrategy: state.scanStrategy,
        coverageFromBlock: state.coverageFromBlock?.toString() || null,
        latestBlock: state.lastScannedBlock.toString(),
        chainHeadBlock: state.chainHeadBlock.toString(),
        backlogBlockCount: state.backlogBlockCount,
        updatedAt: state.updatedAt,
        scanDurationMs: state.scanDurationMs,
        scannedBlockCount: state.scannedBlockCount,
        lastScanEventCount: state.lastScanEventCount,
        chainMetrics: state.chainMetrics,
        pendingSupported: state.pendingSupported,
        pendingCoverage: state.pendingCoverage,
        pendingSources: state.pendingSources,
        pendingUpdatedAt: state.pendingUpdatedAt,
        pendingStats: state.pendingStats,
      })
    } catch (error) {
      state.status = "degraded"
      state.error = message(error)
      state.scanStrategy = null
      state.scanDiagnostics = uniqueMessages([state.error])
      state.updatedAt = new Date().toISOString()
      state.scanDurationMs = Math.round(performance.now() - scanStartedAt)
      publish(chainId, { type: "monitor_status", status: "degraded", chainId: Number(chainId), error: state.error, updatedAt: state.updatedAt, scanDurationMs: state.scanDurationMs })
    } finally {
      state.polling = false
    }
    return state
  }

  function ensure(chainId) {
    const state = stateFor(chainId)
    if (!state.timer && autoPoll) {
      void scan(chainId)
      state.timer = setInterval(() => void scan(chainId), Math.max(2000, pollIntervalMs))
      state.timer.unref?.()
    }
    return state
  }

  async function refreshOverviewSupplies(chainId, state, windowSeconds) {
    if (state.chainHeadBlock === null) return
    const seconds = ALLOWED_WINDOWS.has(Number(windowSeconds)) ? Number(windowSeconds) : DEFAULT_WINDOW_SECONDS
    const cutoff = Math.floor(Date.now() / 1000) - seconds
    const targets = [...state.collections.values()]
      .filter((collection) => collection.events.some((event) => event.timestamp >= cutoff))
      .sort((a, b) => Number(b.lastMintAt || 0) - Number(a.lastMintAt || 0))
      .slice(0, 120)
    if (!targets.length) return
    const blockNumber = BigInt(state.chainHeadBlock)
    const refreshKey = `${blockNumber}:${targets.map((collection) => collection.address.toLowerCase()).join(",")}`
    if (state.supplyRefreshKey === refreshKey) return
    if (state.supplyRefreshPromise) return state.supplyRefreshPromise
    state.supplyRefreshPromise = (async () => {
      const client = getClient(chainId)
      let supplies = null
      if (typeof client.multicall === "function") {
        try {
          const results = await client.multicall({
            allowFailure: true,
            blockNumber,
            contracts: targets.map((collection) => ({
              address: collection.address,
              abi: UINT_READ_ABI("totalSupply"),
              functionName: "totalSupply",
            })),
          })
          supplies = results.map((result) => result?.status === "success" ? result.result : null)
        } catch {
          supplies = null
        }
      }
      if (!supplies) {
        supplies = await mapConcurrent(targets, 8, (collection) => readOptional(client, {
          address: collection.address,
          abi: UINT_READ_ABI("totalSupply"),
          functionName: "totalSupply",
          blockNumber,
        }))
      }
      targets.forEach((collection, index) => {
        if (supplies[index] === null) return
        if (applyConfirmedSupply(collection, supplies[index], blockNumber)) {
          commitCollectionSnapshot(chainId, state, collection)
        }
      })
      state.supplyRefreshKey = refreshKey
    })().finally(() => {
      state.supplyRefreshPromise = null
    })
    return state.supplyRefreshPromise
  }

  function directOverview(chainId, windowSeconds = DEFAULT_WINDOW_SECONDS) {
    const state = stateFor(chainId)
    const chain = getChain(chainId)
    const nativeSymbol = chainNativeSymbol(chain)
    const seconds = ALLOWED_WINDOWS.has(Number(windowSeconds)) ? Number(windowSeconds) : DEFAULT_WINDOW_SECONDS
    const cutoff = Math.floor(Date.now() / 1000) - seconds
    for (const event of state.events) {
      const collection = state.collections.get(String(event.address || "").toLowerCase())
      if (collection) applySnapshotToEvent(event, commitCollectionSnapshot(chainId, state, collection, { broadcast: false }))
    }
    const rows = [...state.collections.values()].map((collection) => {
      const snapshot = commitCollectionSnapshot(chainId, state, collection, { broadcast: false })
      const recent = collection.events.filter((event) => event.timestamp >= cutoff)
      const recentMints = recent.reduce((sum, event) => sum + toNumber(event.quantity), 0)
      const price = collectionMintPrice(collection, nativeSymbol, recent)
      return {
        address: collection.address,
        name: collection.name,
        symbol: collection.symbol,
        token_standard: collection.tokenStandard,
        current_supply: snapshot.current_supply,
        max_supply: snapshot.max_supply,
        max_per_wallet: collection.maxPerWallet ?? null,
        recent_mints: recentMints,
        ...minterFields(chainId, collection),
        mint_price: price.label,
        mint_price_raw: price.raw,
        is_airdrop: recent.some((event) => event.isAirdrop),
        is_mintable: collectionMintable(collection),
        last_mint_time: collection.lastMintAt,
        chain: chain.key,
        chainId: Number(chainId),
        native_symbol: nativeSymbol,
        source: "direct_rpc",
        image_url: snapshot.image_url,
        image_source: snapshot.image_source,
        contract_created_at: collection.contractCreatedAt || null,
        contract_created_block: collection.contractCreatedBlock || null,
        creator_address: collection.creatorAddress || "",
        deployer_profile: snapshot.deployer_profile,
        pending_count: snapshot.pending_token_count,
        pending_unknown_tx_count: snapshot.pending_unknown_tx_count,
        pending_transaction_count: snapshot.pending_transaction_count,
        pending_coverage: snapshot.pending_coverage,
        website: snapshot.website,
        twitter: snapshot.twitter,
        discord_url: snapshot.discord_url,
        opensea_url: snapshot.opensea_url,
        opensea_verified: snapshot.opensea_verified,
        funding_tags: snapshot.funding_tags,
        platform_tags: snapshot.platform_tags,
        status_tags: snapshot.status_tags,
        collection_snapshot: snapshot,
        recent_mint_preview: recent.slice(0, MAX_OVERVIEW_COLLECTION_EVENTS).map(recentMintPayload),
      }
    }).filter((row) => row.recent_mints > 0).sort((a, b) => b.recent_mints - a.recent_mints)

    return {
      source: "direct_rpc",
      mode: state.status,
      error: state.error,
      providerError,
      updatedAt: state.updatedAt,
      scanStrategy: state.scanStrategy,
      scanDiagnostics: state.scanDiagnostics,
      coverageLimited: state.coverageLimited,
      coverageFromBlock: state.coverageFromBlock?.toString() || null,
      latestBlock: state.lastScannedBlock?.toString() || null,
      chainHeadBlock: state.chainHeadBlock?.toString() || null,
      backlogBlockCount: state.backlogBlockCount,
      scanDurationMs: state.scanDurationMs,
      scannedBlockCount: state.scannedBlockCount,
      lastScanEventCount: state.lastScanEventCount,
      chainMetrics: state.chainMetrics,
      pendingSupported: state.pendingSupported,
      pendingCoverage: state.pendingCoverage,
      pendingSources: state.pendingSources,
      pendingUpdatedAt: state.pendingUpdatedAt,
      pendingStats: state.pendingStats,
      nativeSymbol,
      windows: { [String(seconds)]: rows },
      events: state.events.filter((event) => event.timestamp >= cutoff).slice(0, 100),
    }
  }

  async function overview(chainId, windowSeconds) {
    const state = ensure(chainId)
    const scanRequest = scan(chainId)
    if (state.lastScannedBlock === null) await settlesWithin(scanRequest, initialResponseWaitMs)
    const supplyRefresh = refreshOverviewSupplies(chainId, state, windowSeconds)
    if (!(await settlesWithin(supplyRefresh, overviewSupplyWaitMs))) void supplyRefresh.catch(() => {})

    const providerRequest = providerOverview()
    await settlesWithin(providerRequest, providerResponseWaitMs)
    const provider = providerCache
    const chain = getChain(chainId)
    const nativeSymbol = chainNativeSymbol(chain)
    if (provider) {
      const seconds = ALLOWED_WINDOWS.has(Number(windowSeconds)) ? Number(windowSeconds) : DEFAULT_WINDOW_SECONDS
      const directRows = directOverview(chainId, seconds).windows[String(seconds)] || []
      const providerRows = (provider.windows?.[String(seconds)] || []).filter((row) => (
        !row.chain || row.chain === chain.key || (chain.key === "robinhood" && row.chain === "hood")
      ))
      const hydration = hydrateProviderCollections(chainId, state, providerRows)
      if (!(await settlesWithin(hydration, providerHydrationWaitMs))) void hydration.catch(() => {})
      void hydration.then(() => refreshPendingCounts(chainId, getClient(chainId), state)).catch(() => {})
      const providerBackedRows = providerRows.map((row) => {
        const local = state.collections.get(String(row.address).toLowerCase())
        const snapshot = local ? commitCollectionSnapshot(chainId, state, local, { broadcast: false }) : null
        const minters = local || { address: row.address, minters: new Set() }
        const localPrice = local ? collectionMintPrice(local, nativeSymbol) : null
        const providerImage = mediaResolver ? mediaResolver.registerMedia?.(row.image_url, "0") : row.image_url || null
        const collectionSnapshot = snapshot || {
          version: 0,
          updated_at: row.updated_at || provider.updatedAt || null,
          supply_block_number: null,
          current_supply: row.current_supply ?? null,
          max_supply: row.max_supply ?? null,
          pending_token_count: null,
          pending_unknown_tx_count: 0,
          pending_transaction_count: null,
          pending_coverage: "unavailable",
          pending_sources: [],
          image_url: providerImage,
          image_source: providerImage ? "provider" : null,
          image_updated_at: null,
          website: row.website || null,
          twitter: row.twitter || null,
          discord_url: row.discord_url || null,
          opensea_url: null,
          opensea_verified: false,
          funding_tags: row.funding_tags || [],
          platform_tags: (row.platform_tags || []).filter((tag) => String(tag).toLowerCase() !== "opensea"),
          status_tags: row.status_tags || [],
        }
        enqueueMinterBackfill(chainId, row.address)
        return {
          ...row,
          current_supply: collectionSnapshot.current_supply,
          max_supply: collectionSnapshot.max_supply,
          max_per_wallet: local?.maxPerWallet ?? row.max_per_wallet ?? null,
          mint_price: localPrice?.label ?? normalizeMintPriceLabel(row.mint_price, nativeSymbol),
          mint_price_raw: localPrice?.raw ?? row.mint_price_raw ?? null,
          native_symbol: nativeSymbol,
          is_mintable: local ? collectionMintable(local) : row.is_mintable,
          ...minterFields(chainId, minters),
          image_url: collectionSnapshot.image_url,
          image_source: collectionSnapshot.image_source,
          image_fallback_url: providerImage && providerImage !== collectionSnapshot.image_url ? providerImage : null,
          pending_count: collectionSnapshot.pending_token_count,
          pending_unknown_tx_count: collectionSnapshot.pending_unknown_tx_count,
          pending_transaction_count: collectionSnapshot.pending_transaction_count,
          pending_coverage: collectionSnapshot.pending_coverage,
          contract_created_at: local?.contractCreatedAt ?? row.contract_created_at ?? null,
          contract_created_block: local?.contractCreatedBlock ?? row.contract_created_block ?? null,
          creator_address: local?.creatorAddress ?? row.creator_address ?? "",
          website: collectionSnapshot.website,
          twitter: collectionSnapshot.twitter,
          discord_url: collectionSnapshot.discord_url,
          opensea_url: collectionSnapshot.opensea_url,
          opensea_verified: collectionSnapshot.opensea_verified,
          funding_tags: collectionSnapshot.funding_tags,
          platform_tags: collectionSnapshot.platform_tags,
          status_tags: collectionSnapshot.status_tags,
          collection_snapshot: collectionSnapshot,
          recent_mint_preview: local?.events.length
            ? local.events.slice(0, MAX_OVERVIEW_COLLECTION_EVENTS).map(recentMintPayload)
            : Array.isArray(row.recent_mint_preview)
              ? row.recent_mint_preview.map((event) => ({
                ...event,
                mint_price: normalizeMintPriceLabel(event.mint_price, nativeSymbol),
                native_symbol: nativeSymbol,
              }))
              : [],
        }
      })
      const providerAddresses = new Set(providerBackedRows.map((row) => String(row.address || "").toLowerCase()))
      const rows = [
        ...providerBackedRows,
        ...directRows.filter((row) => !providerAddresses.has(String(row.address || "").toLowerCase())),
      ]
      const events = stateFor(chainId).events.slice(0, 100)
      const mediaPrewarm = prewarmOverviewMedia([...rows, ...events])
      if (!(await settlesWithin(mediaPrewarm, overviewMediaPrewarmWaitMs))) void mediaPrewarm.catch(() => {})
      return {
        ...provider,
        source: "provider",
        mode: state.status,
        error: state.error,
        providerError: "",
        updatedAt: state.updatedAt,
        scanStrategy: state.scanStrategy,
        scanDiagnostics: state.scanDiagnostics,
        coverageLimited: state.coverageLimited,
        coverageFromBlock: state.coverageFromBlock?.toString() || null,
        latestBlock: state.lastScannedBlock?.toString() || null,
        chainHeadBlock: state.chainHeadBlock?.toString() || null,
        backlogBlockCount: state.backlogBlockCount,
        scanDurationMs: state.scanDurationMs,
        scannedBlockCount: state.scannedBlockCount,
        lastScanEventCount: state.lastScanEventCount,
        chainMetrics: state.chainMetrics,
        pendingSupported: state.pendingSupported,
        pendingCoverage: state.pendingCoverage,
        pendingSources: state.pendingSources,
        pendingUpdatedAt: state.pendingUpdatedAt,
        pendingStats: state.pendingStats,
        nativeSymbol,
        windows: { [String(seconds)]: rows },
        events,
      }
    }
    const direct = directOverview(chainId, windowSeconds)
    const rows = direct.windows?.[String(ALLOWED_WINDOWS.has(Number(windowSeconds)) ? Number(windowSeconds) : DEFAULT_WINDOW_SECONDS)] || []
    const mediaPrewarm = prewarmOverviewMedia([...rows, ...(direct.events || [])])
    if (!(await settlesWithin(mediaPrewarm, overviewMediaPrewarmWaitMs))) void mediaPrewarm.catch(() => {})
    return direct
  }

  function recentMintPayload(event) {
    return {
      timestamp: event.timestamp,
      block_number: event.blockNumber || null,
      to_address: event.recipient,
      token_id: event.tokenIds[0] || null,
      quantity: event.quantity,
      tx_hash: event.txHash,
      mint_price: event.mintPrice,
      mint_value_raw: event.mintValueWei,
      unit_price_raw: event.unitPriceWei,
      gas_used: event.gasUsed,
      gas_fee_wei: event.gasFeeWei,
      gas_fee_native: event.gasFeeNative,
      native_symbol: event.nativeSymbol,
      image_url: event.imageUrl || null,
      token_name: event.tokenName || null,
    }
  }

  function directCollection(chainId, address, provider = null) {
    const state = stateFor(chainId)
    const nativeSymbol = chainNativeSymbol(getChain(chainId))
    const entry = state.collections.get(address.toLowerCase())
    if (!entry) return null
    const snapshot = commitCollectionSnapshot(chainId, state, entry, { broadcast: false })
    const price = collectionMintPrice(entry, nativeSymbol)
    const providerRecentMints = Array.isArray(provider?.recent_mints)
      ? provider.recent_mints.map((event) => ({
        ...event,
        mint_price: normalizeMintPriceLabel(event.mint_price, nativeSymbol),
        native_symbol: nativeSymbol,
      }))
      : []
    return {
      source: "direct_rpc",
      address: entry.address,
      name: entry.name,
      symbol: entry.symbol,
      token_standard: entry.tokenStandard,
      current_supply: snapshot.current_supply,
      max_supply: snapshot.max_supply,
      ...minterFields(chainId, entry),
      mint_price: price.label,
      mint_price_raw: price.raw,
      native_symbol: nativeSymbol,
      max_per_wallet: provider?.max_per_wallet ?? entry.maxPerWallet ?? null,
      floor_price_eth: provider?.floor_price_eth ?? null,
      website: snapshot.website || provider?.website || null,
      twitter: snapshot.twitter || provider?.twitter || null,
      discord_url: snapshot.discord_url || provider?.discord_url || null,
      opensea_url: snapshot.opensea_url,
      opensea_verified: snapshot.opensea_verified,
      last_mint_time: entry.lastMintAt,
      is_airdrop: entry.events.some((event) => event.isAirdrop),
      is_mintable: collectionMintable(entry),
      contract_created_at: entry.contractCreatedAt || null,
      contract_created_block: entry.contractCreatedBlock || null,
      creator_address: entry.creatorAddress || "",
      deployer_profile: snapshot.deployer_profile,
      pending_count: snapshot.pending_token_count,
      pending_unknown_tx_count: snapshot.pending_unknown_tx_count,
      pending_transaction_count: snapshot.pending_transaction_count,
      pending_coverage: snapshot.pending_coverage,
      funding_tags: snapshot.funding_tags,
      platform_tags: snapshot.platform_tags,
      status_tags: snapshot.status_tags,
      image_url: snapshot.image_url,
      image_source: snapshot.image_source,
      image_fallback_url: null,
      collection_snapshot: snapshot,
      recent_mints: entry.events.length > 0
        ? entry.events.map(recentMintPayload)
        : providerRecentMints,
    }
  }

  async function collection(chainId, address) {
    const state = ensure(chainId)
    const chain = getChain(chainId)
    const nativeSymbol = chainNativeSymbol(chain)
    const chainKey = chain.key === "robinhood" ? "hood" : chain.key
    enqueueMinterBackfill(chainId, address, { priority: true })

    // Collection rows are produced from this same state. Return that snapshot before
    // polling the next block or waiting for optional third-party enrichment.
    let direct = directCollection(chainId, address, cachedProviderCollection(address, chainKey))
    if (direct) {
      const entry = state.collections.get(address.toLowerCase())
      await settlesWithin(enrichCollectionGas(getClient(chainId), entry), collectionGasWaitMs)
      const providerRequest = providerCollection(address, chainKey)
      if (entry.events.length === 0 && !cachedProviderCollection(address, chainKey)) {
        await settlesWithin(providerRequest, providerResponseWaitMs)
      } else {
        void providerRequest
      }
      return directCollection(chainId, address, cachedProviderCollection(address, chainKey))
    }

    // Direct API visits can briefly join the initial scan, but must never inherit
    // an unbounded RPC scan latency. The scan continues in the background.
    if (state.lastScannedBlock === null) {
      const scanRequest = state.scanPromise || scan(chainId)
      // With no provider fallback configured there is no optional enrichment to
      // wait for; return the local snapshot while the direct scan progresses.
      if (providerBase) await settlesWithin(scanRequest, initialResponseWaitMs)
      else void scanRequest.catch(() => {})
    }
    direct = directCollection(chainId, address, cachedProviderCollection(address, chainKey))
    if (direct) {
      await settlesWithin(enrichCollectionGas(getClient(chainId), state.collections.get(address.toLowerCase())), collectionGasWaitMs)
      void providerCollection(address, chainKey)
      return directCollection(chainId, address, cachedProviderCollection(address, chainKey))
    }

    // Provider detail is optional enrichment. Give a fast provider a small response
    // window, then let it finish in the background for a later request.
    const providerRequest = providerCollection(address, chainKey)
    await settlesWithin(providerRequest, providerResponseWaitMs)
    const provider = cachedProviderCollection(address, chainKey)
    if (!provider) return null
    const providerImage = mediaResolver ? mediaResolver.registerMedia?.(provider.image_url, "0") : provider.image_url || null
    const providerSnapshot = {
      version: 0,
      updated_at: provider.updated_at || null,
      supply_block_number: null,
      current_supply: provider.current_supply ?? null,
      max_supply: provider.max_supply ?? null,
      pending_token_count: null,
      pending_unknown_tx_count: 0,
      pending_transaction_count: null,
      pending_coverage: "unavailable",
      pending_sources: [],
      image_url: providerImage,
      image_source: providerImage ? "provider" : null,
      image_updated_at: null,
      website: provider.website || null,
      twitter: provider.twitter || null,
      discord_url: provider.discord_url || null,
      opensea_url: null,
      opensea_verified: false,
      funding_tags: provider.funding_tags || [],
      platform_tags: (provider.platform_tags || []).filter((tag) => String(tag).toLowerCase() !== "opensea"),
      status_tags: provider.status_tags || [],
    }
    return {
      ...provider,
      source: "provider",
      mint_price: normalizeMintPriceLabel(provider.mint_price, nativeSymbol),
      native_symbol: nativeSymbol,
      recent_mints: Array.isArray(provider.recent_mints)
        ? provider.recent_mints.map((event) => ({
          ...event,
          mint_price: normalizeMintPriceLabel(event.mint_price, nativeSymbol),
          native_symbol: nativeSymbol,
        }))
        : provider.recent_mints,
      ...minterFields(chainId, { address, minters: new Set() }),
      opensea_url: null,
      opensea_verified: false,
      image_url: providerImage,
      image_source: providerSnapshot.image_source,
      collection_snapshot: providerSnapshot,
    }
  }

  function status(chainId) {
    ensure(chainId)
    const state = stateFor(chainId)
    return {
      mode: state.status,
      error: state.error,
      source: providerCache ? "provider" : "direct_rpc",
      providerError,
      updatedAt: state.updatedAt,
      scanStrategy: state.scanStrategy,
      scanDiagnostics: state.scanDiagnostics,
      coverageLimited: state.coverageLimited,
      coverageFromBlock: state.coverageFromBlock?.toString() || null,
      latestBlock: state.lastScannedBlock?.toString() || null,
      chainHeadBlock: state.chainHeadBlock?.toString() || null,
      backlogBlockCount: state.backlogBlockCount,
      scanDurationMs: state.scanDurationMs,
      scannedBlockCount: state.scannedBlockCount,
      lastScanEventCount: state.lastScanEventCount,
      collectionCount: state.collections.size,
      eventCount: state.events.length,
      chainMetrics: state.chainMetrics,
      pendingSupported: state.pendingSupported,
      pendingCoverage: state.pendingCoverage,
      pendingSources: state.pendingSources,
      pendingUpdatedAt: state.pendingUpdatedAt,
      pendingStats: state.pendingStats,
    }
  }

  function stop() {
    for (const state of states.values()) if (state.timer) clearInterval(state.timer)
    if (minterBackfillTimer) clearTimeout(minterBackfillTimer)
    for (const timer of minterBackfillRetryTimers) clearTimeout(timer)
    minterBackfillRetryTimers.clear()
  }

  return { collection, directOverview, ensure, ingestRemoved, overview, scan, status, stop, subscribe }
}
