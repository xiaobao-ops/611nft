import { decodeEventLog, decodeFunctionData, formatEther, parseAbiItem, toEventSelector, toHex, zeroAddress } from "viem"

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

function shortPrice(wei) {
  if (wei === 0n) return "Free"
  const value = Number(formatEther(wei))
  if (!Number.isFinite(value)) return `${formatEther(wei)} native`
  if (value < 0.000001) return `${value.toExponential(2)} native`
  return `${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} native`
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

export async function readCollectionMetadata(client, address, inferredStandard = "ERC721") {
  const [name, symbol, erc721, erc1155, totalSupply] = await Promise.all([
    readOptional(client, { address, abi: STRING_READ_ABI("name"), functionName: "name" }),
    readOptional(client, { address, abi: STRING_READ_ABI("symbol"), functionName: "symbol" }),
    readOptional(client, { address, abi: ERC165_ABI, functionName: "supportsInterface", args: ["0x80ac58cd"] }),
    readOptional(client, { address, abi: ERC165_ABI, functionName: "supportsInterface", args: ["0xd9b67a26"] }),
    readOptional(client, { address, abi: UINT_READ_ABI("totalSupply"), functionName: "totalSupply" }),
  ])

  const supplyCandidates = ["maxSupply", "MAX_SUPPLY", "collectionSize"]
  let maxSupply = null
  for (const functionName of supplyCandidates) {
    maxSupply = await readOptional(client, { address, abi: UINT_READ_ABI(functionName), functionName })
    if (maxSupply !== null) break
  }

  return {
    address,
    name: String(name || symbol || `${inferredStandard} ${address.slice(0, 6)}`),
    symbol: String(symbol || ""),
    tokenStandard: erc1155 ? "ERC1155" : erc721 ? "ERC721" : inferredStandard,
    currentSupply: totalSupply === null ? null : totalSupply.toString(),
    maxSupply: maxSupply === null ? null : maxSupply.toString(),
    maxPerWallet: null,
    walletLimitReader: null,
  }
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

async function refreshCollectionState(client, collection, mintedQuantity = 0n, allowSupplyFallback = false) {
  const [totalSupply, maxPerWallet] = await Promise.all([
    readOptional(client, { address: collection.address, abi: UINT_READ_ABI("totalSupply"), functionName: "totalSupply" }),
    readWalletLimit(client, collection),
  ])

  if (totalSupply !== null) collection.currentSupply = totalSupply.toString()
  else if (allowSupplyFallback && collection.currentSupply !== null && mintedQuantity > 0n) {
    const incremented = BigInt(collection.currentSupply) + mintedQuantity
    collection.currentSupply = collection.maxSupply === null
      ? incremented.toString()
      : (incremented > BigInt(collection.maxSupply) ? BigInt(collection.maxSupply) : incremented).toString()
  }
  if (maxPerWallet !== null) collection.maxPerWallet = maxPerWallet.toString()
}

function collectionMintPrice(collection, events = collection.events) {
  if (collection.configuredMintPriceWei !== null && collection.configuredMintPriceWei !== undefined) {
    const raw = String(collection.configuredMintPriceWei)
    return { label: shortPrice(BigInt(raw)), raw }
  }
  const pricedEvent = events.find((event) => event.unitPriceWei !== null && event.unitPriceWei !== undefined)
    || collection.events.find((event) => event.unitPriceWei !== null && event.unitPriceWei !== undefined)
  const raw = pricedEvent?.unitPriceWei ?? collection.lastPriceWei ?? null
  return { label: raw === null ? "Unknown" : shortPrice(BigInt(raw)), raw }
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
    output[windowKey] = rows.filter((row) => /^0x[a-fA-F0-9]{40}$/.test(String(row.address || "")))
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
  initialResponseWaitMs = Number(process.env.MINT_MONITOR_INITIAL_RESPONSE_WAIT_MS || 2000),
  providerResponseWaitMs = Number(process.env.MINT_MONITOR_PROVIDER_RESPONSE_WAIT_MS || 300),
  collectionGasWaitMs = Number(process.env.MINT_MONITOR_COLLECTION_GAS_WAIT_MS || 1500),
  minterStore = null,
  blockscoutBases = BLOCKSCOUT_BASES,
  minterBackfillPageDelayMs = Number(process.env.MINT_MONITOR_MINTER_BACKFILL_PAGE_DELAY_MS || DEFAULT_MINTER_BACKFILL_PAGE_DELAY_MS),
  minterBackfillRetryMs = Number(process.env.MINT_MONITOR_MINTER_BACKFILL_RETRY_MS || DEFAULT_MINTER_BACKFILL_RETRY_MS),
  fetchImpl = fetch,
  autoPoll = true,
} = {}) {
  const states = new Map()
  const subscribers = new Map()
  let providerCache = null
  let providerCheckedAt = 0
  let providerError = ""
  const providerCollectionCache = new Map()
  const providerCollectionRequests = new Map()
  const collectionMediaQueue = []
  const mediaQueue = []
  const pendingCollectionMedia = new Set()
  let activeMediaJobs = 0
  const minterBackfillQueue = []
  const queuedMinterBackfills = new Set()
  const minterBackfillRetryTimers = new Set()
  let activeMinterBackfill = null
  let minterBackfillTimer = null

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
    const progress = minterStore.progress(job.chainId, job.address) || minterStore.ensure(job.chainId, job.address)
    if (progress.status === "complete") return { complete: true, retry: false }
    minterStore.markLoading(job.chainId, job.address)
    try {
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
      const snapshot = minterStore.markError(job.chainId, job.address, compactError(error))
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
        const progress = minterStore.progress(job.chainId, job.address)
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

  async function settlesWithin(promise, timeoutMs) {
    let timer
    try {
      return await Promise.race([
        Promise.resolve(promise).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function drainMediaQueue() {
    while (mediaResolver && activeMediaJobs < 4 && (collectionMediaQueue.length || mediaQueue.length)) {
      const job = collectionMediaQueue.shift() || mediaQueue.shift()
      activeMediaJobs += 1
      void mediaResolver.resolveToken(job.request).then((tokenMedia) => {
        if (!tokenMedia?.imageUrl) return
        Object.assign(job.event, {
          imageUrl: tokenMedia.imageUrl,
          image_url: tokenMedia.imageUrl,
          tokenName: tokenMedia.tokenName || "",
        })
        const state = stateFor(job.event.chainId)
        const collection = state.collections.get(job.event.address.toLowerCase())
        if (collection && (!collection.imageUpdatedAt || job.event.timestamp >= collection.imageUpdatedAt)) {
          collection.imageUrl = tokenMedia.imageUrl
          collection.imageUpdatedAt = job.event.timestamp
        }
        publish(job.event.chainId, {
          type: "mint_update",
          id: job.event.id,
          chainId: job.event.chainId,
          address: job.event.address,
          txHash: job.event.txHash,
          tokenIds: job.event.tokenIds,
          imageUrl: tokenMedia.imageUrl,
          image_url: tokenMedia.imageUrl,
          tokenName: tokenMedia.tokenName || "",
        })
      }).finally(() => {
        if (job.collectionKey) pendingCollectionMedia.delete(job.collectionKey)
        activeMediaJobs -= 1
        drainMediaQueue()
      })
    }
  }

  function enqueueMedia(request, event) {
    if (!mediaResolver || !event.tokenIds[0]) return
    const collectionKey = `${event.chainId}:${event.address.toLowerCase()}`
    const collection = stateFor(event.chainId).collections.get(event.address.toLowerCase())
    const job = { request: { ...request, tokenId: event.tokenIds[0] }, event }
    if (!collection?.imageUrl && !pendingCollectionMedia.has(collectionKey)) {
      pendingCollectionMedia.add(collectionKey)
      collectionMediaQueue.push({ ...job, collectionKey })
    } else {
      mediaQueue.push(job)
      if (mediaQueue.length > 120) mediaQueue.shift()
    }
    drainMediaQueue()
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
      const client = getClient(chainId)
      const latest = await client.getBlockNumber()
      state.chainHeadBlock = latest
      let fromBlock = state.lastScannedBlock === null
        ? latest > BigInt(initialBlocks) ? latest - BigInt(initialBlocks) : 0n
        : state.lastScannedBlock + 1n
      if (fromBlock > latest) {
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
        state.metadata.set(key, await readCollectionMetadata(client, descriptor.address, descriptor.standard))
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
          blockNumber: first.blockNumber.toString(),
          timestamp: Number(block?.timestamp || BigInt(Math.floor(Date.now() / 1000))),
          quantity: quantity.toString(),
          tokenIds: ids.slice(0, 20),
          mintValueWei: value === null ? null : value.toString(),
          unitPriceWei: unitPrice === null ? null : unitPrice.toString(),
          mintPrice: unitPrice === null ? "Unknown" : shortPrice(unitPrice),
          gasUsed: gasUsed ? gasUsed.toString() : null,
          effectiveGasPriceWei: effectiveGasPrice ? effectiveGasPrice.toString() : null,
          gasFeeWei: gasUsed && effectiveGasPrice ? gasFeeWei.toString() : null,
          gasFeeNative: gasUsed && effectiveGasPrice ? formatEther(gasFeeWei) : null,
          nativeSymbol: chain.nativeSymbol || "ETH",
          isFree: value === 0n,
          isAirdrop: value === 0n && transactionSender && transactionSender.toLowerCase() !== eventRecipient.toLowerCase(),
          isMintable: true,
        }
        return { address, event, meta, quantity, transaction }
      })

      for (const { address, event, meta, quantity, transaction } of enrichedGroups) {
        if (existingEventIds.has(event.id)) continue
        existingEventIds.add(event.id)
        state.events.unshift(event)
        const key = address.toLowerCase()
        const existedBeforeScan = state.collections.has(key)
        const collection = state.collections.get(key) || { ...meta, events: [], minters: new Set() }
        collection.events.unshift(event)
        collection.events = collection.events.slice(0, MAX_COLLECTION_EVENTS)
        collection.minters.add(event.recipient.toLowerCase())
        minterStore?.recordMinter(Number(chainId), address, event.recipient)
        enqueueMinterBackfill(chainId, address)
        collection.lastMintAt = event.timestamp
        if (event.unitPriceWei !== null) collection.lastPriceWei = event.unitPriceWei
        collection.lastMintTransaction = transaction ? { to: transaction.to, input: transaction.input } : null
        collection.isAirdrop = event.isAirdrop
        collection.isMintable = true
        state.collections.set(key, collection)
        const touched = touchedCollections.get(key) || { collection, quantity: 0n, allowSupplyFallback: existedBeforeScan }
        touched.quantity += quantity
        touched.allowSupplyFallback ||= existedBeforeScan
        touchedCollections.set(key, touched)
        pendingEvents.push(event)
        publish(chainId, event)
        enqueueMedia({
          client,
          chainId: Number(chainId),
          address,
          tokenStandard: meta.tokenStandard,
        }, event)
      }
      await mapConcurrent([...touchedCollections.values()], 6, ({ collection, quantity, allowSupplyFallback }) => (
        refreshCollectionState(client, collection, quantity, allowSupplyFallback)
      ))
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

  function directOverview(chainId, windowSeconds = DEFAULT_WINDOW_SECONDS) {
    const state = stateFor(chainId)
    const seconds = ALLOWED_WINDOWS.has(Number(windowSeconds)) ? Number(windowSeconds) : DEFAULT_WINDOW_SECONDS
    const cutoff = Math.floor(Date.now() / 1000) - seconds
    const rows = [...state.collections.values()].map((collection) => {
      const recent = collection.events.filter((event) => event.timestamp >= cutoff)
      const recentMints = recent.reduce((sum, event) => sum + toNumber(event.quantity), 0)
      const price = collectionMintPrice(collection, recent)
      return {
        address: collection.address,
        name: collection.name,
        symbol: collection.symbol,
        token_standard: collection.tokenStandard,
        current_supply: collection.currentSupply,
        max_supply: collection.maxSupply,
        max_per_wallet: collection.maxPerWallet ?? null,
        recent_mints: recentMints,
        ...minterFields(chainId, collection),
        mint_price: price.label,
        mint_price_raw: price.raw,
        is_airdrop: recent.some((event) => event.isAirdrop),
        is_mintable: collectionMintable(collection),
        last_mint_time: collection.lastMintAt,
        chain: getChain(chainId).key,
        chainId: Number(chainId),
        source: "direct_rpc",
        image_url: collection.imageUrl || recent.find((event) => event.imageUrl)?.imageUrl || null,
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
      windows: { [String(seconds)]: rows },
      events: state.events.filter((event) => event.timestamp >= cutoff).slice(0, 100),
    }
  }

  async function overview(chainId, windowSeconds) {
    const state = ensure(chainId)
    const scanRequest = scan(chainId)
    if (state.lastScannedBlock === null) await settlesWithin(scanRequest, initialResponseWaitMs)

    const providerRequest = providerOverview()
    await settlesWithin(providerRequest, providerResponseWaitMs)
    const provider = providerCache
    const chain = getChain(chainId)
    if (provider) {
      const seconds = ALLOWED_WINDOWS.has(Number(windowSeconds)) ? Number(windowSeconds) : DEFAULT_WINDOW_SECONDS
      const rows = (provider.windows?.[String(seconds)] || []).filter((row) => (
        !row.chain || row.chain === chain.key || (chain.key === "robinhood" && row.chain === "hood")
      )).map((row) => {
        const local = state.collections.get(String(row.address).toLowerCase())
        const minters = local || { address: row.address, minters: new Set() }
        const localPrice = local ? collectionMintPrice(local) : null
        enqueueMinterBackfill(chainId, row.address)
        return {
          ...row,
          current_supply: local?.currentSupply ?? row.current_supply,
          max_supply: local?.maxSupply ?? row.max_supply,
          max_per_wallet: local?.maxPerWallet ?? row.max_per_wallet ?? null,
          mint_price: localPrice?.label ?? row.mint_price,
          mint_price_raw: localPrice?.raw ?? row.mint_price_raw ?? null,
          is_mintable: local ? collectionMintable(local) : row.is_mintable,
          ...minterFields(chainId, minters),
          image_url: mediaResolver ? mediaResolver.registerMedia?.(row.image_url, "0") : row.image_url || null,
          recent_mint_preview: local?.events.slice(0, MAX_OVERVIEW_COLLECTION_EVENTS).map(recentMintPayload) || [],
        }
      })
      return { ...provider, source: "provider", mode: "live", providerError: "", windows: { [String(seconds)]: rows }, events: stateFor(chainId).events.slice(0, 100) }
    }
    return directOverview(chainId, windowSeconds)
  }

  function recentMintPayload(event) {
    return {
      timestamp: event.timestamp,
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
      image_url: event.imageUrl || null,
      token_name: event.tokenName || null,
    }
  }

  function directCollection(chainId, address, provider = null) {
    const state = stateFor(chainId)
    const entry = state.collections.get(address.toLowerCase())
    if (!entry) return null
    const providerImage = provider?.image_url
      ? (mediaResolver ? mediaResolver.registerMedia?.(provider.image_url, "0") : provider.image_url)
      : null
    const price = collectionMintPrice(entry)
    return {
      source: "direct_rpc",
      address: entry.address,
      name: entry.name,
      symbol: entry.symbol,
      token_standard: entry.tokenStandard,
      current_supply: entry.currentSupply,
      max_supply: entry.maxSupply,
      ...minterFields(chainId, entry),
      mint_price: price.label,
      mint_price_raw: price.raw,
      max_per_wallet: provider?.max_per_wallet ?? entry.maxPerWallet ?? null,
      floor_price_eth: provider?.floor_price_eth ?? null,
      website: provider?.website || null,
      twitter: provider?.twitter || null,
      discord_url: provider?.discord_url || null,
      last_mint_time: entry.lastMintAt,
      is_airdrop: entry.events.some((event) => event.isAirdrop),
      is_mintable: collectionMintable(entry),
      image_url: entry.imageUrl || entry.events.find((event) => event.imageUrl)?.imageUrl || providerImage || null,
      recent_mints: entry.events.map(recentMintPayload),
    }
  }

  async function collection(chainId, address) {
    const state = ensure(chainId)
    const chain = getChain(chainId)
    const chainKey = chain.key === "robinhood" ? "hood" : chain.key
    enqueueMinterBackfill(chainId, address, { priority: true })

    // Collection rows are produced from this same state. Return that snapshot before
    // polling the next block or waiting for optional third-party enrichment.
    let direct = directCollection(chainId, address, cachedProviderCollection(address, chainKey))
    if (direct) {
      await settlesWithin(enrichCollectionGas(getClient(chainId), state.collections.get(address.toLowerCase())), collectionGasWaitMs)
      void providerCollection(address, chainKey)
      return directCollection(chainId, address, cachedProviderCollection(address, chainKey))
    }

    // Direct API visits can briefly join the initial scan, but must never inherit
    // an unbounded RPC scan latency. The scan continues in the background.
    if (state.lastScannedBlock === null) {
      await settlesWithin(state.scanPromise || scan(chainId), initialResponseWaitMs)
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
    return {
      ...provider,
      source: "provider",
      ...minterFields(chainId, { address, minters: new Set() }),
      image_url: mediaResolver ? mediaResolver.registerMedia?.(provider.image_url, "0") : provider.image_url || null,
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
    }
  }

  function stop() {
    for (const state of states.values()) if (state.timer) clearInterval(state.timer)
    if (minterBackfillTimer) clearTimeout(minterBackfillTimer)
    for (const timer of minterBackfillRetryTimers) clearTimeout(timer)
    minterBackfillRetryTimers.clear()
  }

  return { collection, directOverview, ensure, overview, scan, status, stop, subscribe }
}
