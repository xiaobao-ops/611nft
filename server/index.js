import "./env.js"
import express from "express"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { connect as connectSocket } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import {
  createPublicClient,
  custom,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  webSocket,
  zeroAddress,
} from "viem"
import { arbitrum, base, bsc, mainnet, optimism, polygon, shibarium, zksync } from "viem/chains"
import { createAdvancedMintService } from "./advanced-mint-service.js"
import { createAlertService, migrateAlertRules, toMonitorAlertEvent } from "./alert-service.js"
import { createCollectionFlagStore, migrateCollectionFlags } from "./collection-flags.js"
import { createDeployerProfileStore, migrateDeployerProfiles } from "./deployer-profile-store.js"
import {
  buildNftMintPreview,
  mapMintConcurrent,
  parseMintPreviewInput,
  refreshNftMintPlan,
} from "./nft-mint.js"
import { createFollowMintService, migrateFollowMint } from "./follow-mint.js"
import { createMintIntelService } from "./mint-intel.js"
import { createMintMonitor, createMintMonitorWssBridge, ERC1155_TRANSFER_BATCH, ERC1155_TRANSFER_SINGLE, ERC721_TRANSFER, readCollectionMetadata } from "./mint-monitor.js"
import { createMintTrending } from "./mint-trending.js"
import {
  attachListingState,
  attachOfferState,
  buildNftApprovalPlan,
  createNftListingService,
  fetchActiveListings,
  fetchCollectionOffers,
  nftMarketplaceCatalog,
} from "./nft-management.js"
import { createOfferAcceptService } from "./offer-accept.js"
import { createNftMediaResolver } from "./nft-media.js"
import { createNftMinterStore, migrateNftMinterStore } from "./nft-minter-store.js"
import { createTelegramNotifier } from "./notifier.js"
import { selectRealtimeHealth } from "./realtime-health.js"
import { createRealtimeStream, formatSseMessage } from "./realtime-stream.js"
import { createRpcManager, createViemWssClient, createWssFailoverManager } from "./rpc-pool.js"
import { broadcastWithFailover } from "./rpc-broadcast.js"
import { createRpcProfileStore } from "./rpc-profiles.js"
import { createSeaDropRadar, migrateSeaDropRadar, SEADROP_EVENTS_ABI } from "./seadrop-radar.js"
import { parseCredentialBundle } from "./opensea-mint/intelligence.js"
import { createOpenSeaMintService, enforceSniperProtections, serializePlan } from "./opensea-mint/mint-service.js"
import { fetchOpenSeaWalletEligibilities } from "./opensea-mint/wallet-auth.js"
import { pickOpenSeaAllowlistStage } from "./opensea-mint/stage-select.js"
import { createWalletActivityMonitor } from "./wallet-activity.js"
import { resolveListenHosts } from "./listen-hosts.js"
import { assertSecureRemoteConfiguration, requireRemoteApiAuth } from "./security.js"
import { createTaskConfirmationStore } from "./task-confirmations.js"
import { mapWithLimit } from "./concurrency.js"
import { ABORT_REASON, createNonceAllocator, sendersOf } from "./execution-policy.js"
import { assignTransferGas, estimateTransferGas } from "./transfer-gas.js"
import { baseNonce, pendingGap } from "./nonce-baseline.js"
import { broadcastConnectionFailure, broadcastUncertain } from "./broadcast-classify.js"
import { sweepEntryFromEnvelope } from "./sweep-envelope.js"
import { burstConcurrencyFor } from "./burst-limit.js"
import { createNftHoldingsIndexer } from "./nft-holdings.js"
import { buildTokenCollectPlan, queryContractHoldings } from "./token-collect.js"
import {
  inspectSignatureTransaction,
  normalizeSignatureLabInput,
  preflightSignatureTransaction,
} from "./signature-lab.js"
import {
  createAwpWalletProvider,
  normalizeWalletGroup,
  requireWalletCapability,
} from "./wallet-provider.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)
const WALLET_ROOT = process.env.WALLET_BOARD_WALLET_ROOT || join(homedir(), ".openclaw-wallet")
const WALLETS_PATH = join(WALLET_ROOT, "wallets.json")
const DB_PATH = process.env.WALLET_BOARD_DB_PATH || join(ROOT, "wallet-board.sqlite")
const DIST_ROOT = join(ROOT, "dist")
const NFTTOOL_RUNTIME_ROOT = join(DIST_ROOT, "nfttool-runtime")
const PORT = Number(process.env.WALLET_BOARD_PORT || 8791)
const API_HOST = process.env.WALLET_BOARD_API_HOST || "127.0.0.1"
const API_HOSTS = resolveListenHosts(API_HOST, process.env.WALLET_BOARD_API_HOSTS)
const walletProvider = createAwpWalletProvider({ root: ROOT, walletRoot: WALLET_ROOT, walletsPath: WALLETS_PATH })
// Measured on 2026-08-29 from this machine, warm keepalive connection, p50 of 10 samples:
// robinhood-rpc.publicnode.com answers in 75ms and rpc.mainnet.chain.robinhood.com in 234ms,
// and publicnode was 4 blocks (~0.4s) ahead of the official endpoint at the same instant.
// Every read on this chain pays that difference, so publicnode leads and the official
// endpoint stays as the fallback rather than the primary.
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://robinhood-rpc.publicnode.com"
const NFT_MINT_CONFIRM_TTL_MS = safeDurationMs(process.env.NFT_MINT_CONFIRM_TTL_MS, 10 * 60 * 1000)
const NFT_MINT_JOB_TTL_MS = 30 * 60 * 1000
const ADVANCED_MINT_CONFIRM_TTL_MS = safeDurationMs(process.env.ADVANCED_MINT_CONFIRM_TTL_MS, 10 * 60 * 1000)
const ADVANCED_MINT_JOB_TTL_MS = safeDurationMs(process.env.ADVANCED_MINT_JOB_TTL_MS, 30 * 60 * 1000)
const TASK_CONFIRM_TTL_MS = safeDurationMs(process.env.WALLET_BOARD_TASK_CONFIRM_TTL_MS, 10 * 60 * 1000)
const NFT_HOLDING_METADATA_BUDGET_MS = safeDurationMs(process.env.NFT_HOLDING_METADATA_BUDGET_MS, 8000)
const API_TOKEN = String(process.env.WALLET_BOARD_API_TOKEN || "").trim()

assertSecureRemoteConfiguration(API_HOSTS, API_TOKEN)

function safeDurationMs(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback
}

function rpcPool(primary, configured = "", defaults = []) {
  const explicit = String(configured || "").split(",").map((value) => value.trim()).filter(Boolean)
  const selected = explicit.length ? [primary, ...explicit] : [primary, ...defaults]
  return [...new Set(selected.map((value) => value.trim()).filter(Boolean))]
}

function wssPool(chainKey, defaults = []) {
  const suffix = String(chainKey || "").toUpperCase()
  const configured = process.env[`WSS_RPC_URLS_${suffix}`] || process.env[`${suffix}_WSS_RPC_URLS`] || ""
  const primary = process.env[`WSS_RPC_URL_${suffix}`] || process.env[`${suffix}_WSS_RPC_URL`] || ""
  const explicit = [primary, ...String(configured).split(",")].map((value) => value.trim()).filter(Boolean)
  return [...new Set(explicit.length ? explicit : defaults)]
}

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
})

const CHAINS = {
  1: {
    id: 1,
    key: "ethereum",
    name: "Ethereum",
    nativeSymbol: "ETH",
    viem: mainnet,
    rpcUrl: process.env.ETH_RPC_URL || "https://ethereum.publicnode.com",
    rpcUrls: rpcPool(process.env.ETH_RPC_URL || "https://ethereum.publicnode.com", process.env.ETH_RPC_URLS, ["https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io", "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://rpc.flashbots.net"]),
    wssUrls: wssPool("ethereum", ["wss://ethereum-rpc.publicnode.com", "wss://0xrpc.io/eth", "wss://mainnet.gateway.tenderly.co"]),
    explorer: "https://etherscan.io",
  },
  8453: {
    id: 8453,
    key: "base",
    name: "Base",
    nativeSymbol: "ETH",
    viem: base,
    rpcUrl: process.env.BASE_RPC_URL || "https://base.publicnode.com",
    rpcUrls: rpcPool(process.env.BASE_RPC_URL || "https://base.publicnode.com", process.env.BASE_RPC_URLS, [
      "https://mainnet.base.org",
      "https://developer-access-mainnet.base.org",
      "https://base.drpc.org",
    ]),
    wssUrls: wssPool("base", ["wss://base-rpc.publicnode.com"]),
    explorer: "https://basescan.org",
  },
  324: {
    id: 324,
    key: "zks",
    name: "zkSync Era",
    nativeSymbol: "ETH",
    viem: zksync,
    rpcUrl: process.env.ZKS_RPC_URL || "https://mainnet.era.zksync.io",
    rpcUrls: rpcPool(process.env.ZKS_RPC_URL || "https://mainnet.era.zksync.io", process.env.ZKS_RPC_URLS, ["https://zksync.drpc.org", "https://1rpc.io/zksync"]),
    wssUrls: wssPool("zks", []),
    explorer: "https://explorer.zksync.io",
  },
  42161: {
    id: 42161,
    key: "arbitrum",
    name: "Arbitrum",
    nativeSymbol: "ETH",
    viem: arbitrum,
    rpcUrl: process.env.ARBITRUM_RPC_URL || "https://arbitrum-one.publicnode.com",
    rpcUrls: rpcPool(process.env.ARBITRUM_RPC_URL || "https://arbitrum-one.publicnode.com", process.env.ARBITRUM_RPC_URLS, ["https://arb1.arbitrum.io/rpc"]),
    wssUrls: wssPool("arbitrum", ["wss://arbitrum-one-rpc.publicnode.com"]),
    explorer: "https://arbiscan.io",
  },
  10: {
    id: 10,
    key: "optimism",
    name: "Optimism",
    nativeSymbol: "ETH",
    viem: optimism,
    rpcUrl: process.env.OPTIMISM_RPC_URL || "https://optimism.publicnode.com",
    rpcUrls: rpcPool(process.env.OPTIMISM_RPC_URL || "https://optimism.publicnode.com", process.env.OPTIMISM_RPC_URLS, ["https://mainnet.optimism.io"]),
    wssUrls: wssPool("optimism", ["wss://optimism-rpc.publicnode.com"]),
    explorer: "https://optimistic.etherscan.io",
  },
  137: {
    id: 137,
    key: "polygon",
    name: "Polygon",
    nativeSymbol: "POL",
    viem: polygon,
    rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
    rpcUrls: rpcPool(process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com", process.env.POLYGON_RPC_URLS, ["https://polygon-rpc.com"]),
    wssUrls: wssPool("polygon", ["wss://polygon-bor-rpc.publicnode.com"]),
    explorer: "https://polygonscan.com",
  },
  56: {
    id: 56,
    key: "bsc",
    name: "BNB Chain",
    nativeSymbol: "BNB",
    viem: bsc,
    rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    rpcUrls: rpcPool(process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org", process.env.BSC_RPC_URLS, ["https://bsc-dataseed1.binance.org"]),
    wssUrls: wssPool("bsc", ["wss://bsc-rpc.publicnode.com"]),
    explorer: "https://bscscan.com",
  },
  4663: {
    id: 4663,
    key: "robinhood",
    name: "Robinhood Chain",
    nativeSymbol: "ETH",
    viem: robinhood,
    rpcUrl: ROBINHOOD_RPC_URL,
    // rpc.arrowrpc.com answered "error code: 1033" (Cloudflare tunnel down) and
    // robinhood.api.pocket.network refuses eth_sendRawTransaction outright — see
    // broadcast-classify.js:22 — so neither belongs in a pool that serves sends.
    rpcUrls: rpcPool(ROBINHOOD_RPC_URL, process.env.ROBINHOOD_RPC_URLS, ["https://rpc.mainnet.chain.robinhood.com"]),
    // Both endpoints connect, but publicnode completes the handshake in 230ms against
    // 802ms for blxrbdn, and the slower one leading the pool is why /api/rpc-pool/status
    // reported wssHits:0 with httpFallbacks:58 — the subscription timed out before it
    // was ready and every read silently fell back to HTTP polling.
    wssUrls: wssPool("robinhood", ["wss://robinhood-rpc.publicnode.com", "wss://robinhood.rpc.blxrbdn.com"]),
    explorer: "https://robinhoodchain.blockscout.com",
  },
  109: {
    id: 109,
    key: "shib",
    name: "Shibarium",
    nativeSymbol: "BONE",
    viem: shibarium,
    rpcUrl: process.env.SHIB_RPC_URL || "https://www.shibrpc.com",
    rpcUrls: rpcPool(process.env.SHIB_RPC_URL || "https://www.shibrpc.com", process.env.SHIB_RPC_URLS, ["https://rpc.shibarium.shib.io", "https://www.shibrpc.com"]),
    wssUrls: wssPool("shib", []),
    explorer: "https://www.shibariumscan.io",
  },
}

// A custom write profile may target a chain outside the built-in catalogue.
// Expose it through the same public read lane so previews and receipts keep
// the read/write separation contract.
const customChainId = Number(String(process.env.NFT_WRITE_RPC_CUSTOM_CHAIN_ID || "").trim())
const customChainUrl = String(process.env.NFT_WRITE_RPC_CUSTOM_URL || "").trim()
if (Number.isInteger(customChainId) && customChainId > 0 && customChainUrl && !CHAINS[customChainId]) {
  const customViemChain = defineChain({
    id: customChainId,
    name: "Custom Chain",
    nativeCurrency: { name: "Native", symbol: process.env.NFT_WRITE_RPC_CUSTOM_NATIVE_SYMBOL || "ETH", decimals: 18 },
    rpcUrls: { default: { http: [customChainUrl] } },
    blockExplorers: { default: { name: "Explorer", url: process.env.NFT_WRITE_RPC_CUSTOM_EXPLORER_URL || "https://example.invalid" } },
  })
  CHAINS[customChainId] = {
    id: customChainId,
    key: "custom",
    name: "Custom Chain",
    nativeSymbol: process.env.NFT_WRITE_RPC_CUSTOM_NATIVE_SYMBOL || "ETH",
    viem: customViemChain,
    rpcUrl: customChainUrl,
    rpcUrls: rpcPool(customChainUrl, process.env.NFT_WRITE_RPC_CUSTOM_URLS),
    wssUrls: wssPool("custom", []),
    explorer: process.env.NFT_WRITE_RPC_CUSTOM_EXPLORER_URL || "",
  }
}

const db = new DatabaseSync(DB_PATH)
db.exec("PRAGMA busy_timeout = 5000")
db.exec("PRAGMA journal_mode = WAL")

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_meta (
      wallet_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      wallet_group TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      risk TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS balance_cache (
      wallet_id TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      token_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      balance_wei TEXT NOT NULL,
      formatted TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (wallet_id, chain_id, token_key)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tx_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      tx_type TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const walletMetaColumns = new Set(db.prepare("PRAGMA table_info(wallet_meta)").all().map((column) => column.name))
  if (!walletMetaColumns.has("proxy_ip")) db.exec("ALTER TABLE wallet_meta ADD COLUMN proxy_ip TEXT NOT NULL DEFAULT ''")
  if (!walletMetaColumns.has("exchange_address")) db.exec("ALTER TABLE wallet_meta ADD COLUMN exchange_address TEXT NOT NULL DEFAULT ''")
  const timestamp = now()
  const normalizeGroup = db.prepare("UPDATE wallet_meta SET wallet_group = ?, updated_at = ? WHERE wallet_id = ?")
  for (const row of db.prepare("SELECT wallet_id, wallet_group FROM wallet_meta").all()) {
    const group = normalizeWalletGroup(row.wallet_group)
    if (group !== row.wallet_group) normalizeGroup.run(group, timestamp, row.wallet_id)
  }
  db.prepare("UPDATE tasks SET status = 'interrupted', error = CASE WHEN error = '' THEN 'Server restarted before task completion' ELSE error END, updated_at = ? WHERE status = 'running'").run(timestamp)
  db.prepare("UPDATE tx_log SET status = 'interrupted', error = CASE WHEN error = '' THEN 'Server restarted before broadcast' ELSE error END, updated_at = ? WHERE status = 'running' AND tx_hash = ''").run(timestamp)
  db.prepare("UPDATE tx_log SET status = 'confirmation_pending', updated_at = ? WHERE status IN ('running', 'sent', 'pending') AND tx_hash <> ''").run(timestamp)
  migrateNftMinterStore(db)
  migrateFollowMint(db)
  migrateAlertRules(db)
  migrateCollectionFlags(db)
  migrateDeployerProfiles(db)
  migrateSeaDropRadar(db)
}

migrate()

const app = express()
app.use(express.json({ limit: "2mb" }))
app.use("/api", (req, res, next) => {
  if (requireRemoteApiAuth({
    localAddress: req.socket.localAddress,
    authorization: req.headers.authorization,
    expectedToken: API_TOKEN,
  })) {
    next()
    return
  }
  res.setHeader("WWW-Authenticate", "Bearer")
  res.status(401).json({ ok: false, error: "需要有效的 WALLET_BOARD_API_TOKEN 访问令牌" })
})

function now() {
  return new Date().toISOString()
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item))
}

function taskId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

function readRegistry() {
  return walletProvider.registry()
}

function hostnameFor(value) {
  try {
    return new URL(value).hostname
  } catch {
    return ""
  }
}

const nftMintJobs = new Map()
const tokenHoldingSnapshots = new Map()
const taskConfirmations = createTaskConfirmationStore({ ttlMs: TASK_CONFIRM_TTL_MS })

function mintConfirmationMatches(expected, provided) {
  if (!expected || !provided) return false
  const expectedBytes = Buffer.from(expected)
  const providedBytes = Buffer.from(String(provided))
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
}

function publicNftMintJob(job, { includeConfirmation = false } = {}) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    status: job.status,
    chainId: job.chainId,
    chainName: job.chainName,
    nativeSymbol: job.nativeSymbol,
    rpcProfileId: job.rpcProfileId || "main",
    rpcProfileRef: job.rpcProfileRef || "",
    contractAddress: job.contractAddress,
    quantity: job.quantity,
    tokenId: job.tokenId,
    concurrency: job.concurrency,
    maxMintCostEth: job.maxMintCostEth,
    confirmationToken: includeConfirmation && job.status === "previewed" ? job.confirmationToken : undefined,
    wallets: job.wallets,
    summary: {
      total: job.wallets.length,
      eligible: job.wallets.filter((wallet) => wallet.preflightStatus === "ready").length,
      ready: job.wallets.filter((wallet) => wallet.status === "ready").length,
      skipped: job.wallets.filter((wallet) => wallet.status === "skipped").length,
      failed: job.wallets.filter((wallet) => wallet.status === "failed").length,
      pending: job.wallets.filter((wallet) => ["pending", "confirmation_pending"].includes(wallet.status)).length,
      sent: job.wallets.filter((wallet) => wallet.status === "sent").length,
      confirmed: job.wallets.filter((wallet) => wallet.status === "confirmed").length,
    },
  }
}

function touchNftMintJob(job, ttlMs = NFT_MINT_JOB_TTL_MS) {
  job.updatedAt = now()
  job.expiresAtMs = Date.now() + ttlMs
  job.expiresAt = new Date(job.expiresAtMs).toISOString()
}

function cleanupNftMintJobs() {
  const timestamp = Date.now()
  for (const [id, job] of nftMintJobs) {
    if (job.status === "sending") continue
    if (job.expiresAtMs <= timestamp) nftMintJobs.delete(id)
  }
}

setInterval(cleanupNftMintJobs, 60_000).unref()

function cleanupTokenHoldingSnapshots() {
  const timestamp = Date.now()
  for (const [id, snapshot] of tokenHoldingSnapshots) {
    if (snapshot.expiresAtMs <= timestamp) tokenHoldingSnapshots.delete(id)
  }
}

setInterval(cleanupTokenHoldingSnapshots, 60_000).unref()

function settleWithin(promise, timeoutMs) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs)) }),
  ]).finally(() => clearTimeout(timer))
}

// Resolving NFT metadata costs a tokenURI read plus an off-chain fetch per row, so the
// total is bounded by one shared budget instead of rows x per-request timeout. Rows that
// miss the budget come back without metadata; the resolver keeps filling its cache in the
// background, so re-querying picks them up.
async function attachHoldingMetadata(holdings, chainId, budgetMs = NFT_HOLDING_METADATA_BUDGET_MS) {
  const deadline = Date.now() + budgetMs
  let pending = 0
  const rows = await mapWithLimit(holdings.rows, 8, async (row) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      pending += 1
      return { ...row, metadata: null, metadataPending: true }
    }
    const metadata = await settleWithin(nftMediaResolver.resolveToken({
      client: publicClient(chainId),
      chainId,
      address: holdings.contractAddress,
      tokenStandard: holdings.standard,
      tokenId: row.tokenId,
    }), remaining)
    if (metadata) return { ...row, metadata }
    pending += 1
    return { ...row, metadata: null, metadataPending: true }
  })
  return { ...holdings, rows, metadataPending: pending }
}

// Indexer first: it answers in one request per wallet, covers contracts without
// ERC721Enumerable, and already carries name and image so the per-token tokenURI reads
// are skipped entirely. On-chain enumeration stays as the no-API-key fallback.
async function resolveHoldings({ chainId, contractAddress, wallets }) {
  const contract = assertAddress(contractAddress, "NFT 合约地址")
  if (nftHoldingsIndexer.configured) {
    try {
      const indexed = await nftHoldingsIndexer.query({ chainId, contractAddress: contract, wallets })
      if (indexed) return indexed
    } catch (error) {
      console.warn(`[holdings] 索引器查询失败，回退链上枚举：${error.message}`)
    }
  }
  return queryContractHoldings({ client: publicClient(chainId), contractAddress: contract, wallets })
}

function metaMap() {
  const rows = db.prepare("SELECT * FROM wallet_meta").all()
  return Object.fromEntries(rows.map((row) => [row.wallet_id, row]))
}

function balanceRows() {
  const rows = db.prepare("SELECT * FROM balance_cache ORDER BY updated_at DESC").all()
  const out = {}
  for (const row of rows) {
    out[row.wallet_id] ||= []
    out[row.wallet_id].push({
      chainId: row.chain_id,
      tokenKey: row.token_key,
      symbol: row.symbol,
      decimals: row.decimals,
      balanceWei: row.balance_wei,
      formatted: row.formatted,
      updatedAt: row.updated_at,
    })
  }
  return out
}

function listWallets() {
  const registry = readRegistry()
  const metas = metaMap()
  const balances = balanceRows()
  return Object.entries(registry)
    .map(([id, info]) => {
      const meta = metas[id] || {}
      return {
        id,
        address: info.address,
        source: info.source || (id === "default" ? "default" : "agent"),
        provider: info.provider,
        capabilities: info.capabilities,
        createdAt: info.createdAt || "",
        lastUsed: info.lastUsed || "",
        label: meta.label || "",
        group: meta.wallet_group || "",
        note: meta.note || "",
        favorite: Boolean(meta.favorite),
        risk: meta.risk || "",
        proxyIp: meta.proxy_ip || "",
        exchangeAddress: meta.exchange_address || "",
        balances: balances[id] || [],
      }
    })
    .sort((a, b) => {
      if (a.id === "default") return -1
      if (b.id === "default") return 1
      return a.id.localeCompare(b.id, undefined, { numeric: true })
    })
}

function requireWallet(id) {
  const registry = readRegistry()
  const wallet = registry[id]
  if (!wallet) throw httpError(404, `未找到钱包：${id}`)
  return {
    id,
    address: wallet.address,
    provider: wallet.provider,
    capabilities: wallet.capabilities,
  }
}

function chainConfig(chainId) {
  const chain = CHAINS[Number(chainId)]
  if (!chain) throw httpError(400, `不支持的链：${chainId}`)
  return chain
}

const clients = new Map()
const readRpcPools = new Map()
const monitorClients = new Map()
const readRpcManagers = new Map()

function publicReadRpcStatus(chainId) {
  const manager = readRpcManagers.get(Number(chainId))
  if (!manager) return { chainId: Number(chainId), state: "idle", activeHost: null, activeId: null, upstreams: [], lanes: {} }
  const status = manager.status()
  return {
    chainId: status.chainId,
    state: status.state,
    activeHost: status.activeHost,
    activeId: status.activeId,
    upstreams: (status.upstreams || []).map(({ preferred: _preferred, ...upstream }) => upstream),
    lanes: status.lanes || {},
  }
}

function publicReadPoolStatus(chainId) {
  const manager = readRpcManagers.get(Number(chainId))
  if (!manager) return []
  return (manager.pool.status() || []).map(({ preferred: _preferred, ...upstream }) => upstream)
}

function readRpcManagerFor(chainId) {
  const chain = chainConfig(chainId)
  if (!readRpcManagers.has(chain.id)) {
    const manager = createRpcManager({ chainId: chain.id, urls: chain.rpcUrls })
    readRpcManagers.set(chain.id, manager)
    readRpcPools.set(chain.id, manager.pool)
  }
  return readRpcManagers.get(chain.id)
}
function publicClient(chainId) {
  const chain = chainConfig(chainId)
  if (!clients.has(chain.id)) {
    const manager = readRpcManagerFor(chain.id)
    clients.set(chain.id, createPublicClient({
      chain: chain.viem,
      transport: custom({ request: manager.interactive.request }, { retryCount: 0 }),
    }))
  }
  return clients.get(chain.id)
}

function monitorPublicClient(chainId) {
  const chain = chainConfig(chainId)
  if (!monitorClients.has(chain.id)) {
    const manager = readRpcManagerFor(chain.id)
    monitorClients.set(chain.id, createPublicClient({
      chain: chain.viem,
      transport: custom({ request: manager.monitor.request }, { retryCount: 0 }),
    }))
  }
  return monitorClients.get(chain.id)
}

const nftMediaResolver = createNftMediaResolver({
  cacheDir: process.env.NFT_MEDIA_CACHE_DIR || join(ROOT, ".runtime", "nft-media"),
})
const nftListingService = createNftListingService({
  accountForWallet: (walletId) => walletProvider.accountForWallet(walletId),
  clientForChain: (chainId) => publicClient(chainId),
})
const nftOfferService = createOfferAcceptService({
  clientForChain: (chainId) => publicClient(chainId),
})
const nftMinterStore = createNftMinterStore(db)
const nftHoldingsIndexer = createNftHoldingsIndexer()
const blockscoutBases = {
  1: "https://eth.blockscout.com",
  8453: "https://base.blockscout.com",
  42161: "https://arbitrum.blockscout.com",
  324: "https://blockscout.com/zksync/mainnet",
  10: "https://explorer.optimism.io",
  137: "https://polygon.blockscout.com",
  56: "https://bsc.blockscout.com",
  4663: "https://robinhoodchain.blockscout.com",
  109: "https://www.shibariumscan.io",
}
const mintIntel = createMintIntelService({ blockscoutBases })
const deployerProfiles = createDeployerProfileStore({
  db,
  fetchProfile: (chainId, address) => mintIntel.deployerProfile(chainId, address),
})
// realtimeStream and followMint are constructed further down, so these resolve lazily.
// A live SSE subscriber means a person has the monitor open. An enabled follow-mint rule
// means the scan is doing work somebody asked for even with no page open, so the chain
// still counts as watched. The query rides the (enabled, chain_id) index created in
// migrateFollowMint; the table may not exist yet on the first calls, hence the guard.
let enabledFollowChains = null

function chainHasFollowWork(chainId) {
  try {
    enabledFollowChains ||= db.prepare("SELECT 1 FROM follow_mint_rules WHERE enabled = 1 AND chain_id = ? LIMIT 1")
    return Boolean(enabledFollowChains.get(Number(chainId)))
  } catch {
    return false
  }
}

function monitorHasViewers(chainId) {
  if (realtimeStream.status(chainId).subscribers > 0) return true
  return chainHasFollowWork(chainId)
}

const mintMonitor = createMintMonitor({
  getClient: monitorPublicClient,
  getChain: chainConfig,
  mediaResolver: nftMediaResolver,
  minterStore: nftMinterStore,
  blockscoutBases,
  intelService: mintIntel,
  deployerProfileStore: deployerProfiles,
  hasViewers: monitorHasViewers,
})
const chainIds = Object.keys(CHAINS).map(Number)
const rpcProfiles = createRpcProfileStore({ chains: CHAINS })

// OpenSea SeaDrop mint (server/opensea-mint/). createOpenSeaMintService keeps no
// cross-request state, so each request builds its own service carrying that
// request's RPC profile, matching how the other write routes select a profile.
function openSeaMintServiceFor(body = {}) {
  const rpcProfileId = body.rpcProfileId || "main"
  const rpcProfileRef = body.rpcProfileRef || ""
  return createOpenSeaMintService({
    clientForChain: (chainId) => publicClient(chainId),
    // resolve() hands back a profile object; the mint service wants the URL alone.
    writeRpcForChain: (chainId) => rpcProfiles.resolve(rpcProfileId, chainId, rpcProfileRef).url,
    accountForWallet: (walletId) => walletProvider.accountForWallet(walletId),
    fetchWalletEligibilities: fetchOpenSeaWalletEligibilities,
  })
}

// chainIdentifier() throws for chains OpenSea does not index, which is the normal
// outcome for this repo's zkSync, BSC and Shibarium entries rather than a failure.
function openSeaChainIdentifiers(service) {
  const identifiers = []
  for (const id of chainIds) {
    try {
      identifiers.push(service.chainIdentifier(id))
    } catch {
      continue
    }
  }
  return identifiers
}

function requireOpenSeaChain(service, chainId) {
  try {
    return service.chainIdentifier(chainId)
  } catch (error) {
    throw httpError(400, error.message)
  }
}

const collectionFlags = createCollectionFlagStore({ db })
const notifier = createTelegramNotifier()
const activeRealtimeChains = new Set()
const wssManagers = new Map()
const realtimeStream = createRealtimeStream({
  bufferSize: Number(process.env.MINT_MONITOR_REPLAY_BUFFER || 500),
  batchMs: Number(process.env.MINT_MONITOR_BATCH_MS || 2000),
  heartbeatMs: Number(process.env.MINT_MONITOR_HEARTBEAT_MS || 1000),
  getHealth: (chainId, latestStatus) => selectRealtimeHealth({
    wss: wssManagers.get(Number(chainId))?.status() || {
      state: chainConfig(chainId).wssUrls.length ? "idle" : "unconfigured",
      upstreams: [],
    },
    upstreams: publicReadPoolStatus(chainId),
    monitorStatus: { ...mintMonitor.status(chainId), ...latestStatus },
  }),
})
const trending = createMintTrending()
function seaDropLookbackOverrides() {
  return Object.fromEntries(Object.values(CHAINS).map((chain) => {
    const suffix = chain.key.toUpperCase()
    return [chain.id, process.env[`SEADROP_LOOKBACK_BLOCKS_${suffix}`] || process.env.SEADROP_LOOKBACK_BLOCKS || ""]
  }))
}
const seaDropRadar = createSeaDropRadar({ db, lookbackBlocksByChain: seaDropLookbackOverrides() })
const alertService = createAlertService({ db })
const walletActivityMonitor = createWalletActivityMonitor({
  getClient: monitorPublicClient,
  getWatchedAddresses: (chainId) => alertService.list({ chainId }).rules
    .filter((rule) => rule.enabled && rule.type === "wallet_activity")
    .map((rule) => rule.params.address),
  onActivity: (activity) => alertService.evaluate(activity),
})
const detachRealtimeStream = realtimeStream.attach(mintMonitor, chainIds)
const detachTrending = trending.attach(mintMonitor, chainIds)

function deliverMonitorAlert(alert) {
  const value = toMonitorAlertEvent(alert)
  realtimeStream.emit(value.chainId, value)
  return notifier.send(value)
}

const detachAlertDelivery = alertService.subscribe((alert) => void deliverMonitorAlert(alert))
const detachRadar = seaDropRadar.subscribe((snapshot) => {
  realtimeStream.emit(snapshot.chainId, snapshot)
  alertService.evaluate(snapshot)
})
const monitorWssBridges = new Map(chainIds.map((chainId) => [chainId, createMintMonitorWssBridge({
  chainId,
  monitor: mintMonitor,
  getManager: () => wssManagers.get(chainId),
})]))
const rawMonitorUnsubscribers = chainIds.map((chainId) => mintMonitor.subscribe(chainId, (event) => {
  if (event?.type === "mint") alertService.evaluate(event)
  monitorWssBridges.get(chainId).onMonitorEvent(event)
  if (event?.type === "monitor_status" && event.chainHeadBlock) {
    void walletActivityMonitor.observeHead(chainId, event.chainHeadBlock).catch(() => {})
  }
}))

function wssClientFor(chain, input) {
  return createViemWssClient({
    ...input,
    chain: chain.viem,
    events: [
      ERC721_TRANSFER,
      ERC1155_TRANSFER_SINGLE,
      ERC1155_TRANSFER_BATCH,
      ...SEADROP_EVENTS_ABI.map((event) => ({
        event,
        address: seaDropAddresses(chain),
        args: null,
        scope: "seadrop",
      })),
    ],
    mintFrom: zeroAddress,
    createPublicClient,
    webSocketTransport: webSocket,
  })
}

function realtimeWssFor(chainId) {
  const chain = chainConfig(chainId)
  if (!chain.wssUrls.length) return null
  if (!wssManagers.has(chain.id)) {
    wssManagers.set(chain.id, createWssFailoverManager({
      urls: chain.wssUrls,
      createClient: (input) => wssClientFor(chain, input),
      onEvent: (value) => {
        if (value?.scope === "seadrop") seaDropRadar.ingest(chain.id, value.logs)
        else monitorWssBridges.get(chain.id).onWssEvent(value)
        if (value?.type === "head") void walletActivityMonitor.observeHead(chain.id, value.blockNumber).catch(() => {})
      },
    }))
  }
  return wssManagers.get(chain.id)
}

// Activation used to be permanent: one monitor request added a chain here forever, so
// the trending sweep (eight windows plus an alert pass, every five seconds) and the
// SeaDrop radar kept running for it long after the last viewer left, competing with
// user-driven chain reads for the RPC pool. An open monitor page holds an SSE
// subscription, so a live subscriber or a recent request means somebody is watching.
const REALTIME_IDLE_STOP_MS = 60_000
const realtimeChainAccess = new Map()

function releaseIdleRealtimeChains() {
  const timestamp = Date.now()
  for (const chainId of activeRealtimeChains) {
    if (realtimeStream.status(chainId).subscribers > 0) continue
    if (timestamp - (realtimeChainAccess.get(chainId) || 0) <= REALTIME_IDLE_STOP_MS) continue
    activeRealtimeChains.delete(chainId)
    realtimeChainAccess.delete(chainId)
    // createWssFailoverManager.start clears its own stopped flag, so the manager is
    // reusable and ensureRealtimeChain restarts this socket on the next request.
    wssManagers.get(chainId)?.stop()
  }
}

function ensureRealtimeChain(chainId) {
  const chain = chainConfig(chainId)
  activeRealtimeChains.add(chain.id)
  realtimeChainAccess.set(chain.id, Date.now())
  mintMonitor.ensure(chain.id)
  void realtimeWssFor(chain.id)?.start()
  return chain
}

const trendingTimer = setInterval(() => {
  releaseIdleRealtimeChains()
  for (const chainId of activeRealtimeChains) {
    const windows = {}
    for (const window of [60, 300, 600, 1800, 3600, 21600, 43200, 86400]) {
      const snapshot = trending.snapshot({ chainId, window })
      windows[String(window)] = snapshot.collections
      alertService.evaluate(snapshot)
    }
    realtimeStream.emit(chainId, {
      type: "trending_snapshot",
      chainId,
      snapshotId: `${chainId}:${Math.floor(Date.now() / 5000)}`,
      generatedAt: now(),
      windows,
    })
  }
}, 5000)
trendingTimer.unref?.()

const DEFAULT_SEADROP_ADDRESS = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
const radarScans = new Map()
const radarEnrichments = new Map()
const radarEnrichmentReruns = new Set()
const radarMediaEnrichments = new Map()
const radarMediaReruns = new Set()

function seaDropAddresses(chain) {
  const suffix = chain.key.toUpperCase()
  const configured = process.env[`SEADROP_ADDRESSES_${suffix}`] || process.env.SEADROP_ADDRESSES || ""
  const values = String(configured).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
  return [...new Set(values.length ? values : [DEFAULT_SEADROP_ADDRESS])]
}

function refreshSeaDropRadar(chainId) {
  const chain = chainConfig(chainId)
  if (radarScans.has(chain.id)) return radarScans.get(chain.id)
  void enrichSeaDropProjects(chain.id).catch(() => {})
  const request = seaDropRadar.scan({
    chainId: chain.id,
    client: monitorPublicClient(chain.id),
    dropAddresses: seaDropAddresses(chain),
    maxBlocksPerRequest: Number(process.env.SEADROP_SCAN_MAX_BLOCKS || 5000),
  }).then((outcome) => {
    const snapshot = { type: "seadrop_radar", chainId: chain.id, ...seaDropRadar.list({ chainId: chain.id }) }
    alertService.evaluate(snapshot)
    void enrichSeaDropProjects(chain.id).catch(() => {})
    return outcome
  }).finally(() => {
    radarScans.delete(chain.id)
    void enrichSeaDropProjects(chain.id).catch(() => {})
  })
  radarScans.set(chain.id, request)
  return request
}

function enrichSeaDropProjects(chainId) {
  const chain = chainConfig(chainId)
  if (radarEnrichments.has(chain.id)) {
    radarEnrichmentReruns.add(chain.id)
    return radarEnrichments.get(chain.id)
  }
  const missing = new Map()
  for (const drop of seaDropRadar.list({ chainId: chain.id, includeUnscheduled: true }).drops) {
    if ((!drop.name || !drop.image) && !missing.has(drop.contract)) missing.set(drop.contract, drop)
  }
  if (!missing.size) return Promise.resolve([])
  const client = monitorPublicClient(chain.id)
  const request = mapMintConcurrent([...missing.values()], 4, async (drop) => {
    const metadata = await readCollectionMetadata(client, drop.contract).catch(() => null)
    if (metadata?.name) seaDropRadar.enrich({ chainId: chain.id, contract: drop.contract, name: metadata.name })
    return { drop, metadata }
  }).then((projects) => {
    void enrichSeaDropProjectMedia(chain.id, projects).catch(() => {})
    return projects
  }).finally(() => {
    radarEnrichments.delete(chain.id)
    if (radarEnrichmentReruns.delete(chain.id)) void enrichSeaDropProjects(chain.id).catch(() => {})
  })
  radarEnrichments.set(chain.id, request)
  return request
}

function enrichSeaDropProjectMedia(chainId, projects) {
  const chain = chainConfig(chainId)
  if (radarMediaEnrichments.has(chain.id)) {
    radarMediaReruns.add(chain.id)
    return radarMediaEnrichments.get(chain.id)
  }
  const client = monitorPublicClient(chain.id)
  const request = mapMintConcurrent(projects, 4, async ({ drop, metadata }) => {
    const [collectionMedia, market] = await Promise.all([
      nftMediaResolver.resolveCollection({ client, chainId: chain.id, address: drop.contract }).catch(() => null),
      mintIntel.marketCollection(chain.id, drop.contract).catch(() => null),
    ])
    let projectMedia = collectionMedia
    if (!collectionMedia?.imageUrl) {
      let tokenId = ""
      try {
        if (BigInt(metadata?.currentSupply || 0) > 0n) tokenId = "1"
      } catch {
        tokenId = ""
      }
      projectMedia = await nftMediaResolver.resolveProject({
        client,
        chainId: chain.id,
        address: drop.contract,
        tokenStandard: metadata?.tokenStandard || "ERC721",
        tokenId,
        marketImageUrl: market?.imageUrl || "",
      }).catch(() => collectionMedia)
    }
    return seaDropRadar.enrich({
      chainId: chain.id,
      contract: drop.contract,
      name: metadata?.name || collectionMedia?.name || market?.name || "",
      image: projectMedia?.imageUrl || collectionMedia?.imageUrl || "",
    })
  }).finally(() => {
    radarMediaEnrichments.delete(chain.id)
    if (radarMediaReruns.delete(chain.id)) void enrichSeaDropProjects(chain.id).catch(() => {})
  })
  radarMediaEnrichments.set(chain.id, request)
  return request
}

const configuredRadarPollMs = Number(process.env.SEADROP_RADAR_POLL_MS || 30000)
const radarPollMs = Number.isFinite(configuredRadarPollMs) ? Math.max(5000, configuredRadarPollMs) : 30000
const radarTimer = setInterval(() => {
  for (const chainId of activeRealtimeChains) void refreshSeaDropRadar(chainId).catch(() => {})
}, radarPollMs)
radarTimer.unref?.()

function uncertainBroadcastError(error) {
  const result = error instanceof Error ? error : new Error(String(error || "广播结果待确认"))
  result.code = "BROADCAST_UNCERTAIN"
  result.broadcastUncertain = true
  result.message = "广播请求超时，结果待确认；请通过交易哈希或区块浏览器确认，系统不会自动重发"
  return result
}

function redactRpcMessage(value) {
  return String(value || "").replace(/https?:\/\/[^\s)]+/gi, "<rpc>").replace(/wss?:\/\/[^\s)]+/gi, "<rpc>")
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function updateBalanceCache({ walletId, chainId, tokenKey, symbol, decimals, balanceWei, formatted }) {
  db.prepare(`
    INSERT INTO balance_cache (wallet_id, chain_id, token_key, symbol, decimals, balance_wei, formatted, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_id, chain_id, token_key) DO UPDATE SET
      symbol = excluded.symbol,
      decimals = excluded.decimals,
      balance_wei = excluded.balance_wei,
      formatted = excluded.formatted,
      updated_at = excluded.updated_at
  `).run(walletId, chainId, tokenKey, symbol, decimals, balanceWei, formatted, now())
}

function createTask(type, params) {
  const id = taskId(type)
  const ts = now()
  db.prepare(`
    INSERT INTO tasks (task_id, task_type, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, type, "running", JSON.stringify(params), ts, ts)
  return id
}

function finishTask(id, status, result = {}, error = "") {
  db.prepare("UPDATE tasks SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE task_id = ?")
    .run(status, JSON.stringify(result), error, now(), id)
}

function logTx({ taskId: id, walletId, chainId, type, status, txHash = "", summary = "", error = "", metadata = {} }) {
  const ts = now()
  const result = db.prepare(`
    INSERT INTO tx_log (task_id, wallet_id, chain_id, tx_type, status, tx_hash, summary, error, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, walletId, chainId, type, status, txHash, summary, error, JSON.stringify(metadata), ts, ts)
  return result.lastInsertRowid
}

function updateTx(id, patch) {
  const fields = []
  const values = []
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`)
    values.push(key === "metadata_json" && typeof value !== "string" ? JSON.stringify(value) : value)
  }
  fields.push("updated_at = ?")
  values.push(now(), id)
  db.prepare(`UPDATE tx_log SET ${fields.join(", ")} WHERE id = ?`).run(...values)
}

function normalizeWalletIds(value) {
  if (!Array.isArray(value)) throw httpError(400, "钱包编号列表必须是数组")
  return [...new Set(value.map(String))].filter(Boolean)
}

function assertAddress(value, label = "地址") {
  const text = String(value || "")
  if (!/^0x[a-fA-F0-9]{40}$/.test(text)) throw httpError(400, `${label}无效`)
  try {
    return getAddress(text)
  } catch {
    throw httpError(400, `${label}校验和无效`)
  }
}

function assertHex(value, label = "十六进制数据") {
  const text = String(value || "")
  if (!/^0x([a-fA-F0-9]{2})*$/.test(text)) throw httpError(400, `${label}无效`)
  return text
}

async function tokenInfo(chainId, tokenAddress, provided = {}) {
  const client = publicClient(chainId)
  const address = assertAddress(tokenAddress, "代币地址")
  const [decimals, symbol] = await Promise.all([
    provided.decimals !== undefined
      ? Number(provided.decimals)
      : client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    provided.symbol || client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
  ])
  return { address, decimals: Number(decimals), symbol: String(symbol) }
}

function amountToWei(amount, decimals = 18) {
  const text = String(amount || "0").trim()
  if (!/^\d+(\.\d+)?$/.test(text)) throw httpError(400, `金额无效：${text}`)
  return parseUnits(text, decimals)
}

function weiToDecimal(wei, decimals = 18) {
  return formatUnits(BigInt(wei), decimals)
}

async function refreshBalances({ walletIds, chainId, tokenAddress = "" }) {
  const chain = chainConfig(chainId)
  const client = publicClient(chain.id)
  const ids = normalizeWalletIds(walletIds)
  const wallets = ids.map(requireWallet)
  let token = null
  if (tokenAddress) token = await tokenInfo(chain.id, tokenAddress)

  const rows = []
  for (const wallet of wallets) {
    if (token) {
      const balance = await client.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      })
      const row = {
        walletId: wallet.id,
        address: wallet.address,
        chainId: chain.id,
        tokenKey: token.address.toLowerCase(),
        symbol: token.symbol,
        decimals: token.decimals,
        balanceWei: balance.toString(),
        formatted: formatUnits(balance, token.decimals),
      }
      updateBalanceCache(row)
      rows.push(row)
    } else {
      const balance = await client.getBalance({ address: wallet.address })
      const row = {
        walletId: wallet.id,
        address: wallet.address,
        chainId: chain.id,
        tokenKey: "native",
        symbol: chain.nativeSymbol,
        decimals: 18,
        balanceWei: balance.toString(),
        formatted: formatEther(balance),
      }
      updateBalanceCache(row)
      rows.push(row)
    }
  }
  return rows
}

async function sendRawTx({
  walletId, chainId, rpcProfileId = "main", rpcProfileRef = "", to, valueWei = "0", data = "0x", nonce = null, gas = null,
  gasPrice = null, maxFeePerGas = null, maxPriorityFeePerGas = null,
  sweep = null, verifiedProfile = null,
}) {
  const wallet = requireWallet(walletId)
  const chain = chainConfig(chainId)
  if (sweep) requireWalletCapability(wallet, "sweep")
  if ([gasPrice, maxFeePerGas, maxPriorityFeePerGas].some((value) => value !== null && value !== undefined && value !== "")) {
    requireWalletCapability(wallet, "customFees")
  }
  const selectedProfile = verifiedProfile || await rpcProfiles.verifyChain(rpcProfileId || "main", chain.id, rpcProfileRef)
  const endpoints = selectedProfile.endpoints || [{ id: selectedProfile.endpointId, url: selectedProfile.url, host: selectedProfile.host }]
  const effectiveNonce = nonce === null || nonce === undefined || nonce === ""
    ? await baseNonceFor(chain.id, wallet.address, endpoints[0])
    : Number(nonce)
  const sent = await broadcastWithFailover({
    endpoints,
    isUncertain: broadcastUncertain,
    isConnectionFailure: broadcastConnectionFailure,
    send: async (endpoint) => {
      const args = [
        "--chain", String(chainId),
        "--rpc-url", endpoint.url,
        "--native-symbol", chain.nativeSymbol,
        "send-tx",
        "--to", assertAddress(to, "接收地址"),
        "--value", String(valueWei),
        "--data", assertHex(data, "calldata"),
        "--pretty",
      ]
      args.push("--nonce", String(effectiveNonce))
      if (gas !== null && gas !== undefined && gas !== "") args.push("--gas", String(gas))
      const result = await walletProvider.sendTransaction(walletId, args, { timeoutMs: 180_000 })
      return { result, endpoint }
    },
  })
  return { ...sent.result, rpcProfileId: selectedProfile.id, rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "", rpcHost: sent.endpoint.host || selectedProfile.host }
}

// Both counts come from the same client so a multi-endpoint pool cannot mix one node's
// mined count with another's pending count.
async function baseNonceFor(chainId, address, endpoint) {
  const chain = chainConfig(chainId)
  const client = endpoint?.url
    ? createPublicClient({ chain: chain.viem, transport: http(endpoint.url, { retryCount: 0 }) })
    : publicClient(chainId)
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }).catch(() => null),
  ])
  const gap = pendingGap({ latest, pending })
  if (gap > 0) {
    console.warn(`钱包 ${address} 有 ${gap} 笔待确认交易占用序号 ${latest}..${Number(pending) - 1}，本次从 ${baseNonce({ latest, pending })} 开始发送`)
  }
  return baseNonce({ latest, pending })
}

async function preflightCall({ walletId, chainId, to, valueWei = "0", data = "0x" }) {
  const wallet = requireWallet(walletId)
  const client = publicClient(chainId)
  await client.call({
    account: wallet.address,
    to: assertAddress(to, "接收地址"),
    value: BigInt(valueWei || "0"),
    data: assertHex(data, "calldata"),
  })
}

async function executeEntries({ type, chainId, rpcProfileId = "main", rpcProfileRef = "", entries, mode = "burst", preflight = true }) {
  const chain = chainConfig(chainId)
  for (const entry of entries) {
    if (entry.sweep) requireWalletCapability(requireWallet(entry.walletId), "sweep")
  }
  const selectedProfile = await rpcProfiles.verifyChain(rpcProfileId || "main", chainId, rpcProfileRef)
  const writeEndpoint = (selectedProfile.endpoints || [selectedProfile])[0]
  const id = createTask(type, { chainId, rpcProfileId: selectedProfile.id, rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "", entries, mode, preflight })
  const resultByIndex = new Array(entries.length)
  const baseNonces = new Map(await Promise.all(sendersOf(entries).map(async (walletId) => [
    walletId,
    await baseNonceFor(chainId, requireWallet(walletId).address, writeEndpoint),
  ])))
  const allocator = createNonceAllocator(baseNonces)
  const applySweepEnvelope = (entry, envelope) => {
    if (!envelope) return entry
    Object.assign(entry, sweepEntryFromEnvelope(entry, envelope, {
      nativeSymbol: chain.nativeSymbol,
      formatAmount: (valueWei) => formatEther(BigInt(valueWei)),
    }))
    return entry
  }
  const runEntry = async (entry, index) => {
    const txRowId = logTx({
      taskId: id,
      walletId: entry.walletId,
      chainId,
      type,
      status: "running",
      summary: entry.summary || "",
      metadata: { rpcProfileId: selectedProfile.id, rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "", rpcHost: selectedProfile.host, to: entry.to, valueWei: entry.valueWei || "0" },
    })
    try {
      if (preflight && !entry.sweep) await preflightCall({ walletId: entry.walletId, chainId, to: entry.to, valueWei: entry.valueWei || "0", data: entry.data || "0x" })
      const sent = await sendRawTx({
        walletId: entry.walletId,
        chainId,
        rpcProfileId: selectedProfile.id,
        rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "",
        to: entry.to,
        valueWei: entry.valueWei || "0",
        data: entry.data || "0x",
        nonce: entry.nonce,
        gas: entry.gas,
        gasPrice: entry.gasPrice,
        maxFeePerGas: entry.maxFeePerGas,
        maxPriorityFeePerGas: entry.maxPriorityFeePerGas,
        sweep: entry.sweep ? {
          keepReserveWei: entry.keepReserveWei || 0n,
          multiplierBps: entry.sweepMultiplierBps || 12_500n,
        } : null,
        verifiedProfile: selectedProfile,
      })
      applySweepEnvelope(entry, sent.envelope)
      const txHash = String(sent.txHash || "")
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("钱包签名器未返回有效交易哈希")
      updateTx(txRowId, {
        status: "confirmation_pending",
        tx_hash: txHash,
        summary: entry.summary || "",
        metadata_json: { ...entry, rpcProfileId: selectedProfile.id, rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "", rpcHost: selectedProfile.host, broadcastStage: "accepted", sent },
      })
      resultByIndex[index] = { ...entry, ok: true, status: "confirmation_pending", txHash, sent }
      return "accepted"
    } catch (error) {
      applySweepEnvelope(entry, error?.sweepEnvelope)
      const uncertain = broadcastUncertain(error)
      const failureMetadata = {
        ...entry,
        rpcProfileId: selectedProfile.id,
        rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "",
        rpcHost: selectedProfile.host,
        broadcastStage: uncertain ? "unknown" : "rejected",
        ...(error?.sweepEnvelope ? { sweepEnvelope: error.sweepEnvelope } : {}),
        ...(error?.reconciliation ? { reconciliation: jsonSafe(error.reconciliation) } : {}),
      }
      if (uncertain) {
        const pendingError = uncertainBroadcastError(error)
        updateTx(txRowId, { status: "confirmation_pending", tx_hash: error.txHash || "", summary: entry.summary || "", error: pendingError.message, metadata_json: failureMetadata })
        resultByIndex[index] = { ...entry, ok: false, status: "confirmation_pending", pending: true, uncertain: true, txHash: error.txHash || "", error: pendingError.message, ...(error?.sweepEnvelope ? { sweepEnvelope: error.sweepEnvelope } : {}) }
      } else {
        updateTx(txRowId, { status: "failed", summary: entry.summary || "", error: error.message, metadata_json: failureMetadata })
        resultByIndex[index] = { ...entry, ok: false, status: "failed", error: error.message, ...(error?.sweepEnvelope ? { sweepEnvelope: error.sweepEnvelope } : {}) }
      }
      return uncertain ? "unknown" : "rejected"
    }
  }

  const groups = [...entries.reduce((map, entry, index) => {
    const items = map.get(entry.walletId) || []
    items.push({ entry, index })
    map.set(entry.walletId, items)
    return map
  }, new Map()).entries()]
  await mapWithLimit(groups, Math.max(1, Math.min(groups.length, burstConcurrencyFor(chainId))), async ([walletId, items]) => {
    for (let offset = 0; offset < items.length; offset += 1) {
      const { entry, index } = items[offset]
      const nonce = allocator.current(walletId)
      if (nonce === null) break
      entry.nonce = nonce
      const outcome = await runEntry(entry, index)
      if (outcome === "accepted") {
        if (Number(entry.nonce) > nonce) allocator.synchronize(walletId, entry.nonce)
        allocator.accept(walletId, entry.nonce)
      } else if (outcome === "unknown") {
        allocator.block(walletId, nonce)
        for (const skipped of items.slice(offset + 1)) {
          resultByIndex[skipped.index] = {
            ...skipped.entry,
            ok: false,
            status: "skipped",
            skipped: true,
            error: ABORT_REASON,
          }
        }
        break
      } else {
        allocator.reject(walletId, nonce)
      }
    }
  })
  const results = resultByIndex.filter(Boolean)
  const hasPending = results.some((result) => result.status === "confirmation_pending")
  const hasFailed = results.some((result) => result.status === "failed" || result.status === "skipped")
  const hasAccepted = results.some((result) => result.ok)
  const taskStatus = hasPending
    ? (hasFailed ? "partial" : "confirmation_pending")
    : (hasFailed ? (hasAccepted ? "partial" : "failed") : "done")
  finishTask(id, taskStatus, { results }, hasFailed ? results.find((result) => result.error)?.error || "" : "")

  const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(id)
  return {
    taskId: id,
    status: task.status,
    error: task.error,
    results,
  }
}

// OpenSea SeaDrop mints do not go through executeEntries. The ported service
// prefetches each wallet's own pending nonce and fees and signs before the sale
// opens, which is the whole point of the scheduled path, so it broadcasts itself.
// This wraps it in the same tasks and tx_log rows so /api/tasks, the result panel
// and reconcilePendingTransactions still see the work.
function openSeaMintTaskContext({ chainId, contractAddress, rpcProfileId, rpcProfileRef, executionMode, walletIdByAddress = {}, preview }) {
  const scheduled = executionMode === "scheduled"
  const type = scheduled ? "opensea_mint_scheduled" : "opensea_mint"
  const selectedProfile = rpcProfiles.resolve(rpcProfileId || "main", chainId, rpcProfileRef || "")
  const profileMeta = {
    rpcProfileId: selectedProfile.id,
    rpcProfileRef: selectedProfile.profileRef || rpcProfileRef || "",
    rpcHost: selectedProfile.host,
  }
  const id = createTask(type, {
    chainId,
    contractAddress,
    ...profileMeta,
    executionMode,
    mintRoute: preview.mintRoute,
    saleMode: preview.saleMode,
    scheduledAt: preview.scheduledAt,
    quantity: preview.quantity.toString(),
    walletCount: preview.readyPlans.length,
  })
  const rows = new Map()
  const walletIdFor = (address) => walletIdByAddress[String(address || "").toLowerCase()] || String(address || "")
  for (const plan of preview.readyPlans) {
    const address = plan.account.address
    rows.set(address.toLowerCase(), logTx({
      taskId: id,
      walletId: walletIdFor(address),
      chainId,
      type,
      status: scheduled ? "armed" : "running",
      summary: `${preview.mintRoute} × ${preview.quantity}`,
      metadata: { ...profileMeta, to: contractAddress, quantity: preview.quantity.toString() },
    }))
  }
  return { id, type, scheduled, chainId, contractAddress, profileMeta, rows, walletIdFor, results: [] }
}

async function runOpenSeaMintTask(context, execution) {
  const { id, scheduled, contractAddress, profileMeta, rows, walletIdFor, results } = context
  const { rpcProfileId, rpcProfileRef, preview } = execution
  const rowFor = (address) => rows.get(String(address || "").toLowerCase())

  const recordSuccess = (address, result) => {
    const rowId = rowFor(address)
    if (rowId) updateTx(rowId, { status: "confirmation_pending", tx_hash: result.hash || "", metadata_json: { ...profileMeta, to: contractAddress, ...result } })
    results.push({ walletId: walletIdFor(address), address, ok: true, status: "confirmation_pending", txHash: result.hash || "", ...result })
  }
  // A missing receipt leaves the transaction in flight, so it is reported the way
  // executeEntries reports an uncertain broadcast rather than as a clean failure.
  const recordFailure = (address, error) => {
    const message = error instanceof Error ? error.message : String(error)
    const uncertain = error?.code === "MINT_RECEIPT_UNKNOWN"
    const hash = error?.hash || ""
    const rowId = rowFor(address)
    if (rowId) {
      updateTx(rowId, uncertain
        ? { status: "confirmation_pending", tx_hash: hash, error: message }
        : { status: "failed", tx_hash: hash, error: message })
    }
    results.push({ walletId: walletIdFor(address), address, ok: false, status: uncertain ? "confirmation_pending" : "failed", uncertain, ...(hash ? { txHash: hash } : {}), error: message })
  }

  const runImmediate = async (service) => {
    // A preview can be minutes old, so reprice and re-run the protections against
    // current numbers before anything is signed.
    const gasPrice = await preview.publicClient.getGasPrice()
    for (const plan of preview.readyPlans) {
      plan.gasPrice = gasPrice
      plan.estimatedFee = plan.gasLimit * gasPrice
      plan.estimatedTotal = plan.transaction.value + plan.estimatedFee
    }
    enforceSniperProtections({
      readyPlans: preview.readyPlans,
      inspection: preview.inspection,
      protections: preview.protections,
      quantity: preview.quantity,
    })
    await mapWithLimit(preview.readyPlans, Math.max(1, Number(preview.concurrency) || 1), async (plan) => {
      try {
        recordSuccess(plan.account.address, await service.executePlan({ plan, preview, contractAddress }))
      } catch (error) {
        recordFailure(plan.account.address, error)
      }
    })
  }

  const runScheduled = async (service) => {
    const execute = preview.mintRoute === "opensea_scheduled" ? service.executeScheduledOpenSea : service.executeScheduled
    await execute({
      preview,
      plans: preview.readyPlans,
      contractAddress,
      scheduledAt: preview.scheduledAt,
      onStage: (stage) => {
        db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(String(stage), now(), id)
      },
      onWallet: ({ plan, status, error, hash, result }) => {
        const address = plan?.account?.address
        if (!address) return
        if (result) {
          recordSuccess(address, result)
          return
        }
        const rowId = rowFor(address)
        if (!rowId) return
        // Intermediate stages (preflighted, signed, credential_ready) are progress
        // only; none of them is a status reconcilePendingTransactions picks up.
        updateTx(rowId, { status: String(status), ...(hash ? { tx_hash: hash } : {}), ...(error ? { error: String(error) } : {}) })
      },
    })
  }

  try {
    // Built inside the try: loadAppConfig validates the OpenSea env and throws,
    // and an armed run has no request left to answer by the time it gets here.
    const service = openSeaMintServiceFor({ rpcProfileId, rpcProfileRef })
    if (scheduled) await runScheduled(service)
    else await runImmediate(service)
    const pending = results.some((result) => result.status === "confirmation_pending")
    const failed = results.some((result) => result.status === "failed")
    finishTask(id, pending ? (failed ? "partial" : "confirmation_pending") : (results.some((result) => result.ok) ? "done" : "failed"), { results })
  } catch (error) {
    finishTask(id, results.some((result) => result.ok) ? "partial" : "failed", { results }, error.message)
  }

  const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(id)
  return { taskId: id, status: task.status, error: task.error, results }
}
async function reconcilePendingTransactions() {
  const rows = db.prepare(`
    SELECT id, task_id, chain_id, tx_hash
    FROM tx_log
    WHERE status IN ('sent', 'pending', 'confirmation_pending') AND tx_hash <> ''
    ORDER BY updated_at ASC
    LIMIT 100
  `).all()
  await mapWithLimit(rows, 8, async (row) => {
    try {
      const receipt = await publicClient(row.chain_id).getTransactionReceipt({ hash: row.tx_hash })
      const confirmed = receipt.status === "success"
      updateTx(row.id, {
        status: confirmed ? "confirmed" : "failed",
        error: confirmed ? "" : "交易已在链上回退",
      })
      for (const job of nftMintJobs.values()) {
        const wallet = job.wallets.find((item) => String(item.txHash || "").toLowerCase() === row.tx_hash.toLowerCase())
        if (!wallet) continue
        wallet.status = confirmed ? "confirmed" : "failed"
        wallet.blockNumber = receipt.blockNumber?.toString() || ""
        wallet.reason = confirmed ? "" : "交易已在链上回退"
        touchNftMintJob(job)
      }
    } catch {
      // A missing receipt is expected until the transaction is mined.
    }
  })

  const taskIds = [...new Set(rows.map((row) => row.task_id))]
  for (const taskIdValue of taskIds) {
    const statuses = db.prepare("SELECT status FROM tx_log WHERE task_id = ?").all(taskIdValue).map((row) => row.status)
    if (!statuses.length) continue
    const pending = statuses.some((status) => ["running", "sent", "pending", "confirmation_pending"].includes(status))
    const failed = statuses.some((status) => ["failed", "interrupted"].includes(status))
    const confirmed = statuses.some((status) => status === "confirmed")
    const status = pending ? (failed || confirmed ? "partial" : "confirmation_pending") : failed ? (confirmed ? "partial" : "failed") : "done"
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(status, now(), taskIdValue)
  }

  for (const job of nftMintJobs.values()) {
    if (job.status !== "confirmation_pending") continue
    const pending = job.wallets.some((wallet) => wallet.status === "confirmation_pending")
    const failed = job.wallets.some((wallet) => wallet.status === "failed")
    const confirmed = job.wallets.some((wallet) => wallet.status === "confirmed")
    job.status = pending ? "confirmation_pending" : failed ? (confirmed ? "partial" : "failed") : "completed"
    touchNftMintJob(job)
  }
}

const receiptReconcileTimer = setInterval(() => void reconcilePendingTransactions(), 15000)
receiptReconcileTimer.unref()

async function buildOneToManyPlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const fromId = String(body.fromId || "default")
  requireWallet(fromId)
  const targets = normalizeWalletIds(body.targetIds).map(requireWallet)
  const asset = body.asset || "native"
  const mode = body.amountMode || "fixed"
  let token = null
  if (asset === "erc20") token = await tokenInfo(chain.id, body.tokenAddress, body)

  const entries = []
  // A target can drop out legitimately (already funded in topup mode, or a zero amount),
  // but dropping it silently makes a 3-wallet disperse look like it only ever had 2.
  // Every exclusion is reported with its reason so the operator can see the difference.
  const excluded = []
  for (const target of targets) {
    let amountWei
    if (mode === "topup") {
      const targetWei = amountToWei(body.targetBalance || "0", token?.decimals || 18)
      let current = 0n
      if (asset === "native") {
        current = await publicClient(chain.id).getBalance({ address: target.address })
      } else {
        current = await publicClient(chain.id).readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [target.address],
        })
      }
      amountWei = targetWei > current ? targetWei - current : 0n
    } else {
      amountWei = amountToWei(body.amount || "0", token?.decimals || 18)
    }
    if (amountWei <= 0n) {
      excluded.push({
        walletId: target.id,
        address: target.address,
        reason: mode === "topup" ? "余额已达到目标值，无需补足" : "发送金额为 0",
      })
      continue
    }
    const data = asset === "native"
      ? "0x"
      : encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [target.address, amountWei] })
    entries.push({
      walletId: fromId,
      toWalletId: target.id,
      to: asset === "native" ? target.address : token.address,
      recipient: target.address,
      valueWei: asset === "native" ? amountWei.toString() : "0",
      amountWei: amountWei.toString(),
      amount: weiToDecimal(amountWei, token?.decimals || 18),
      data,
      summary: `${fromId} -> ${target.id} ${weiToDecimal(amountWei, token?.decimals || 18)} ${token?.symbol || chain.nativeSymbol}`,
    })
  }
  // Native transfers used to carry a hardcoded 21000 here, which is below the intrinsic
  // minimum on Nitro chains and rejected every entry. ERC20 entries keep their unset gas
  // and are estimated by the broadcast layer as before.
  const gasWarnings = asset === "native"
    ? await assignTransferGas({
        client: publicClient(chain.id),
        entries,
        addressOf: (walletId) => requireWallet(walletId).address,
      })
    : []
  return { chain, asset, token, entries, excluded, targetCount: targets.length, gasWarnings }
}

async function buildManyToOnePlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const sourceIds = normalizeWalletIds(body.sourceIds)
  if (!sourceIds.length) throw httpError(400, "请至少选择一个来源钱包")
  const sources = sourceIds.map((sourceId) => requireWallet(sourceId))
  for (const source of sources) requireWalletCapability(source, "sweep")
  const destinationWalletId = String(body.destinationWalletId || "")
  if (!destinationWalletId) throw httpError(400, "请选择目标钱包")
  const destinationWallet = requireWallet(destinationWalletId)
  const destination = destinationWallet.address
  const reserveWei = parseEther(String(body.reserveEth || "0.00005"))
  const gasPrice = await publicClient(chain.id).getGasPrice()
  // Collection sends the whole spendable balance, so the fee reserve and the entry's gas
  // limit must come from the same number. Measuring it beats assuming 21000 twice over: a
  // limit below the chain's intrinsic minimum is rejected outright, and a reserve computed
  // from that same 21000 under-withholds the fee, so a collection that got past the limit
  // would then fail on insufficient funds.
  //
  // The probe uses value 0 because the value is not known until the reserve is: the amount
  // moved does not change a transfer's gas, only whether the estimate can be afforded.
  // Every entry shares one destination and carries no calldata, so one probe covers all.
  const gasEstimate = await estimateTransferGas({
    client: publicClient(chain.id),
    from: sources[0].address,
    to: destination,
  })
  if (!gasEstimate.estimated || gasEstimate.gas === null) {
    throw httpError(400, `归集 Gas 估算失败：${gasEstimate.error || "写入 RPC 未返回估算值"}`)
  }
  const gasLimit = gasEstimate.gas
  const gasWarnings = []
  // One cushion, expressed in basis points, used both for the preview reserve here and for
  // the recomputation at send time, so the two can never disagree.
  const multiplierBps = BigInt(Math.max(10_000, Math.round(Number(body.gasMultiplier || 1.25) * 10_000)))
  const bufferedGasPrice = (gasPrice * multiplierBps + 9_999n) / 10_000n
  const gasWei = bufferedGasPrice * gasLimit
  const entries = []

  for (const source of sources) {
    const balance = await publicClient(chain.id).getBalance({ address: source.address })
    const spendable = balance - reserveWei - gasWei
    if (spendable <= 0n) continue
    entries.push({
      walletId: source.id,
      to: destination,
      valueWei: spendable.toString(),
      amountWei: spendable.toString(),
      amount: formatEther(spendable),
      data: "0x",
      gas: gasLimit.toString(),
      summary: `${source.id} -> ${destination.slice(0, 6)}...${destination.slice(-4)} ${formatEther(spendable)} ${chain.nativeSymbol}`,
      gasReserveWei: gasWei.toString(),
      keepReserveWei: reserveWei.toString(),
      // Marks the amount as "whatever is spendable when this is sent". The value above is a
      // preview figure; executeEntries recomputes it against the balance and gas price of
      // the moment, because a sweep leaves no slack for a gas price that rose since.
      sweep: true,
      sweepMultiplierBps: multiplierBps.toString(),
    })
  }
  return { chain, entries, destination, destinationWalletId: destinationWallet.id, reserveWei: reserveWei.toString(), gasWei: gasWei.toString(), gasLimit: gasLimit.toString(), gasWarnings }
}

async function buildManyToManyPlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const senderIds = normalizeWalletIds(body.senderIds)
  const receiverIds = normalizeWalletIds(body.receiverIds)
  if (!senderIds.length) throw httpError(400, "请至少选择一个发送钱包")
  if (!receiverIds.length) throw httpError(400, "请至少选择一个接收钱包")
  if (senderIds.length !== receiverIds.length) throw httpError(400, "多对多转账的发送与接收钱包数量必须一致")
  const entries = []
  const asset = body.asset || "native"
  let token = null
  if (asset === "erc20") token = await tokenInfo(chain.id, body.tokenAddress, body)

  for (let index = 0; index < senderIds.length; index += 1) {
    const source = requireWallet(senderIds[index])
    const receiver = requireWallet(receiverIds[index])
    if (source.id === receiver.id) throw httpError(400, `第 ${index + 1} 行的发送与接收钱包相同`)
    const amountWei = amountToWei(body.amount || "0", token?.decimals || 18)
    const data = asset === "native"
      ? "0x"
      : encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [receiver.address, amountWei] })
    entries.push({
      walletId: source.id,
      toWalletId: receiver.id,
      to: asset === "native" ? receiver.address : token.address,
      recipient: receiver.address,
      valueWei: asset === "native" ? amountWei.toString() : "0",
      amountWei: amountWei.toString(),
      amount: weiToDecimal(amountWei, token?.decimals || 18),
      data,
      summary: `${source.id} -> ${receiver.id} ${weiToDecimal(amountWei, token?.decimals || 18)} ${token?.symbol || chain.nativeSymbol}`,
      row: index + 1,
    })
  }
  return { chain, asset, token, entries }
}

async function buildApprovalPlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const walletIds = normalizeWalletIds(body.walletIds)
  if (!walletIds.length) throw httpError(400, "请至少选择一个钱包")
  walletIds.forEach(requireWallet)
  const token = await tokenInfo(chain.id, body.tokenAddress, body)
  const spender = assertAddress(body.spender, "被授权地址")
  const amountWei = body.revoke ? 0n : amountToWei(body.amount || "0", token.decimals)
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amountWei] })
  const entries = walletIds.map((walletId) => ({
    walletId,
    to: token.address,
    valueWei: "0",
    data,
    summary: `${walletId} ${body.revoke ? "撤销授权" : "授权"} ${token.symbol} -> ${spender.slice(0, 6)}...${spender.slice(-4)}`,
  }))
  return { chain, token, spender, revoke: Boolean(body.revoke), entries }
}

function buildContractCallPlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const walletIds = normalizeWalletIds(body.walletIds)
  if (!walletIds.length) throw httpError(400, "请至少选择一个钱包")
  walletIds.forEach(requireWallet)
  const to = assertAddress(body.to, "合约地址")
  const data = assertHex(body.data || "0x", "calldata")
  const valueWei = String(body.valueWei || "0")
  if (!/^\d+$/.test(valueWei)) throw httpError(400, "交易金额必须是非负 wei 整数")
  const entries = walletIds.map((walletId) => ({
    walletId,
    to,
    valueWei,
    data,
    summary: `${walletId} 调用 ${to.slice(0, 6)}...${to.slice(-4)}`,
  }))
  return { chain, to, valueWei, entries }
}

function taskPreview(type, plan, body, mode = body.executionMode || "burst") {
  const selectedProfile = rpcProfiles.resolve(body.rpcProfileId || "main", plan.chain.id, body.rpcProfileRef || "")
  const execution = {
    type,
    chainId: plan.chain.id,
    rpcProfileId: selectedProfile.id,
    rpcProfileRef: selectedProfile.profileRef || body.rpcProfileRef || "",
    entries: plan.entries,
    mode,
    preflight: body.preflight !== false,
  }
  return taskConfirmations.create(type, execution)
}

async function executeConfirmedTask(type, body) {
  const execution = taskConfirmations.consume(type, body.previewId, body.confirmationToken)
  return executeEntries(execution)
}

function shortForSummary(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

async function previewNftMint(body) {
  const input = parseMintPreviewInput(body)
  const chain = chainConfig(body.chainId || 1)
  const selectedProfile = rpcProfiles.resolve(body.rpcProfileId || "main", chain.id, body.rpcProfileRef || "")
  const walletIds = normalizeWalletIds(body.walletIds)
  if (!walletIds.length) throw httpError(400, "请至少选择一个钱包")
  const wallets = walletIds.map(requireWallet)
  const gasBufferBps = BigInt(String(process.env.NFT_MINT_GAS_BUFFER_BPS || "12000"))
  const preview = await buildNftMintPreview({
    client: publicClient(chain.id),
    chain,
    wallets,
    contractAddress: input.contractAddress,
    quantity: input.quantity,
    tokenId: input.tokenId,
    concurrency: input.concurrency,
    maxMintCostWei: input.maxMintCostWei,
    gasBufferBps,
    graphqlUrl: process.env.NFT_MINT_GRAPHQL_URL || process.env.OPENSEA_GRAPHQL_URL,
  })

  const createdAt = now()
  const job = {
    id: randomUUID(),
    createdAt,
    updatedAt: createdAt,
    expiresAtMs: Date.now() + NFT_MINT_CONFIRM_TTL_MS,
    expiresAt: new Date(Date.now() + NFT_MINT_CONFIRM_TTL_MS).toISOString(),
    status: "previewed",
    chainId: chain.id,
    chainName: chain.name,
    rpcProfileId: selectedProfile.id,
    rpcProfileRef: selectedProfile.profileRef || body.rpcProfileRef || "",
    nativeSymbol: chain.nativeSymbol,
    contractAddress: input.contractAddress,
    quantity: input.quantity.toString(),
    tokenId: input.tokenId,
    concurrency: input.concurrency,
    maxMintCostEth: input.maxMintCostEth,
    maxMintCostWei: input.maxMintCostWei,
    gasBufferBps: gasBufferBps.toString(),
    confirmationToken: randomBytes(24).toString("hex"),
    preview,
    wallets: preview.wallets,
  }
  nftMintJobs.set(job.id, job)
  return job
}

async function sendNftMintJob(job) {
  const client = publicClient(job.chainId)
  const readyPlans = job.preview.readyPlans
  const results = await mapMintConcurrent(readyPlans, job.concurrency, async (previewPlan) => {
    let plan = previewPlan
    const walletRow = job.wallets.find((wallet) => wallet.walletId === previewPlan.wallet.id)
    const txRowId = logTx({
      taskId: job.id,
      walletId: previewPlan.wallet.id,
      chainId: job.chainId,
      type: "nft_mint",
      status: "running",
      summary: `${plan.wallet.id} 从 ${shortForSummary(job.contractAddress)} 铸造 ${job.quantity} 个`,
      metadata: {
        contractAddress: job.contractAddress,
        quantity: job.quantity,
        tokenId: job.tokenId,
        rpcProfileId: job.rpcProfileId,
        rpcProfileRef: job.rpcProfileRef || "",
        mintTarget: plan.transaction.to,
        valueWei: plan.transaction.value.toString(),
      },
    })

    try {
      if (walletRow) walletRow.status = "pending"
      touchNftMintJob(job)

      plan = await refreshNftMintPlan({
        client,
        chain: chainConfig(job.chainId),
        plan: previewPlan,
        contractAddress: job.contractAddress,
        quantity: BigInt(job.quantity),
        tokenId: job.tokenId,
        maxMintCostWei: job.maxMintCostWei,
        gasBufferBps: BigInt(job.gasBufferBps || "12000"),
        graphqlUrl: process.env.NFT_MINT_GRAPHQL_URL || process.env.OPENSEA_GRAPHQL_URL,
      })
      updateTx(txRowId, {
        metadata_json: {
          contractAddress: job.contractAddress,
          quantity: job.quantity,
          tokenId: job.tokenId,
          rpcProfileId: job.rpcProfileId,
          rpcProfileRef: job.rpcProfileRef || "",
          rpcHost: rpcProfiles.metadata(job.rpcProfileId, job.chainId).host,
          mintTarget: plan.transaction.to,
          valueWei: plan.transaction.value.toString(),
          estimatedGas: plan.estimatedGas.toString(),
          gasLimit: plan.gasLimit.toString(),
          gasPriceWei: plan.gasPrice?.toString() || "",
          maxFeePerGasWei: plan.maxFeePerGas?.toString() || "",
          maxPriorityFeePerGasWei: plan.maxPriorityFeePerGas?.toString() || "",
          feeModel: plan.feeModel || "legacy",
        },
      })

      const currentBalance = await client.getBalance({ address: plan.wallet.address })
      if (currentBalance < plan.estimatedTotal) {
        throw new Error(`余额已变化：可用 ${formatEther(currentBalance)}，预计需要 ${formatEther(plan.estimatedTotal)} ${job.nativeSymbol}`)
      }
      await client.call({
        account: plan.wallet.address,
        to: plan.transaction.to,
        value: plan.transaction.value,
        data: plan.transaction.data,
      })

      const sent = await sendRawTx({
        walletId: plan.wallet.id,
        chainId: job.chainId,
        rpcProfileId: job.rpcProfileId,
        rpcProfileRef: job.rpcProfileRef || "",
        to: plan.transaction.to,
        valueWei: plan.transaction.value.toString(),
        data: plan.transaction.data,
        gas: plan.gasLimit.toString(),
      })
      const txHash = String(sent.txHash || "")
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("钱包签名器未返回有效交易哈希")

      if (walletRow) {
        Object.assign(walletRow, {
          status: "sent",
          txHash,
          valueEth: formatEther(plan.transaction.value),
          reason: "",
        })
      }
      updateTx(txRowId, {
        status: sent.status || "sent",
        tx_hash: txHash,
        metadata_json: {
          contractAddress: job.contractAddress,
          quantity: job.quantity,
          tokenId: job.tokenId,
          rpcProfileId: job.rpcProfileId,
          rpcProfileRef: job.rpcProfileRef || "",
          rpcHost: rpcProfiles.metadata(job.rpcProfileId, job.chainId).host,
          mintTarget: plan.transaction.to,
          valueWei: plan.transaction.value.toString(),
          sent,
        },
      })
      touchNftMintJob(job)

      try {
        const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120000 })
        const confirmed = receipt.status === "success"
        if (walletRow) {
          walletRow.status = confirmed ? "confirmed" : "failed"
          walletRow.blockNumber = receipt.blockNumber?.toString() || ""
          if (!confirmed) walletRow.reason = "交易已在链上回退"
        }
        updateTx(txRowId, {
          status: confirmed ? "confirmed" : "failed",
          error: confirmed ? "" : "交易已在链上回退",
        })
      } catch (receiptError) {
        if (walletRow) {
          walletRow.status = "confirmation_pending"
          walletRow.reason = `广播已被接受，交易仍待确认：${receiptError.message}`
        }
        updateTx(txRowId, { status: "confirmation_pending", error: `交易仍待确认：${receiptError.message}` })
      }
      touchNftMintJob(job)
      return { walletId: previewPlan.wallet.id, ok: walletRow?.status !== "failed", pending: walletRow?.status === "confirmation_pending", txHash }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (broadcastUncertain(error)) {
        const pendingError = uncertainBroadcastError(error)
        if (walletRow) Object.assign(walletRow, { status: "confirmation_pending", reason: pendingError.message })
        updateTx(txRowId, { status: "confirmation_pending", error: pendingError.message, metadata_json: { rpcProfileId: job.rpcProfileId, rpcProfileRef: job.rpcProfileRef || "", rpcHost: rpcProfiles.metadata(job.rpcProfileId, job.chainId).host, broadcastStage: "unknown" } })
        touchNftMintJob(job)
        return { walletId: previewPlan.wallet.id, ok: false, pending: true, uncertain: true, error: pendingError.message }
      }
      if (walletRow) Object.assign(walletRow, { status: "failed", reason: message })
      updateTx(txRowId, { status: "failed", error: message })
      touchNftMintJob(job)
      return { walletId: previewPlan.wallet.id, ok: false, error: message }
    }
  })

  const sentCount = results.filter((result) => result.ok).length
  const failedCount = results.length - sentCount
  const pendingCount = results.filter((result) => result.pending).length
  job.status = pendingCount ? "confirmation_pending" : failedCount ? (sentCount ? "partial" : "failed") : "completed"
  touchNftMintJob(job)
}

const advancedMint = createAdvancedMintService({
  getChain: chainConfig,
  getClient: publicClient,
  getWallets: listWallets,
  sendTransaction: sendRawTx,
  resolveRpcProfile: (profileId, chainId, profileRef = "") => rpcProfiles.resolve(profileId || "main", chainId, profileRef),
  startTask: createTask,
  finishTask,
  logTransaction: logTx,
  updateTransaction: updateTx,
  confirmationTtlMs: ADVANCED_MINT_CONFIRM_TTL_MS,
  jobTtlMs: ADVANCED_MINT_JOB_TTL_MS,
})

const followMint = createFollowMintService({
  db,
  monitor: {
    ensure: (chainId) => ensureRealtimeChain(chainId),
    subscribe: (chainId, listener) => mintMonitor.subscribe(chainId, listener),
  },
  chainIds,
  previewMint: previewNftMint,
  sendMint: sendNftMintJob,
  publicJob: (job) => publicNftMintJob(job),
  validateWalletIds: (walletIds) => walletIds.forEach(requireWallet),
  getCollectionFlag: (chainId, address) => collectionFlags.get(chainId, address),
  resolveRpcProfile: (profileId, chainId, profileRef = "") => rpcProfiles.resolve(profileId || "main", chainId, profileRef),
  emitAlert: deliverMonitorAlert,
})
followMint.start()

app.get("/api/health", (_req, res) => {
  const wallets = listWallets()
  res.json({
    ok: true,
    walletCount: wallets.length,
    localWalletCount: 0,
    externalWalletCount: wallets.length,
    port: PORT,
  })
})

app.get("/api/chains", (_req, res) => {
  res.json({ chains: Object.values(CHAINS).map(({ id, key, name, nativeSymbol, explorer }) => ({ id, key, name, nativeSymbol, explorer })) })
})

app.get("/api/nft-marketplaces", (req, res, next) => {
  try {
    const chain = chainConfig(req.query.chainId || 1)
    res.json({ ok: true, chainId: chain.id, marketplaces: nftMarketplaceCatalog(chain.id) })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/opensea-mint/resolve", async (req, res, next) => {
  try {
    const chain = chainConfig(req.body.chainId || 1)
    const service = openSeaMintServiceFor(req.body)
    requireOpenSeaChain(service, chain.id)
    const target = await service.resolveTarget({
      input: req.body.target ?? req.body.url,
      chainId: chain.id,
      supportedChainIdentifiers: openSeaChainIdentifiers(service),
    })
    const intelligence = await service.inspect({
      chainId: chain.id,
      contractAddress: target.contractAddress,
      wallets: normalizeWalletIds(req.body.walletIds),
      quantity: BigInt(req.body.quantity || 1),
      credentials: parseCredentialBundle(req.body.whitelistCredentials || null),
      slug: target.slug,
    })
    res.json({
      ok: true,
      chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol },
      target,
      intelligence,
    })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/opensea-mint/preview", async (req, res, next) => {
  try {
    const chain = chainConfig(req.body.chainId || 1)
    const service = openSeaMintServiceFor(req.body)
    requireOpenSeaChain(service, chain.id)
    const contractAddress = getAddress(String(req.body.contractAddress || ""))
    const walletIds = normalizeWalletIds(req.body.walletIds)
    if (!walletIds.length) throw httpError(400, "请先选择要铸造的钱包")
    for (const walletId of walletIds) requireWalletCapability(requireWallet(walletId), "signExactEnvelope")
    const quantity = BigInt(req.body.quantity || 1)
    const executionMode = req.body.executionMode === "scheduled" ? "scheduled" : "immediate"
    const saleMode = req.body.saleMode || "auto"
    // Resolve the signers before the stage is chosen, not after: picking a stage
    // now depends on which wallets are eligible for it. They are needed either
    // way, so send can map a plan's address back to a wallet id for its tx_log
    // row; plans only ever carry the address.
    const accounts = await service.accountsFor(walletIds)
    const walletIdByAddress = Object.fromEntries(accounts.map((account, index) => [account.address.toLowerCase(), walletIds[index]]))
    let openSeaCatalog = null
    let openSeaStage = null
    if (executionMode === "scheduled" && saleMode === "auto") {
      openSeaCatalog = await service.fetchDropCatalog({ chainId: chain.id, contractAddress, slug: req.body.slug || null })
      let eligibilities = []
      try {
        eligibilities = await fetchOpenSeaWalletEligibilities({
          opensea: service.config.opensea,
          catalog: openSeaCatalog,
          accounts,
        })
      } catch {
        // Eligibility needs a SIWE session per address and is advisory here, the
        // same as on the inspect path. Losing it costs precision, not the mint:
        // pickOpenSeaAllowlistStage falls back to its catalog-only choice.
      }
      openSeaStage = pickOpenSeaAllowlistStage(openSeaCatalog, {
        stageUuid: req.body.openSeaStageUuid,
        scheduleAt: req.body.scheduleAt,
        eligibilities,
      })
    }
    const credentials = parseCredentialBundle(req.body.whitelistCredentials || null)
    const preview = await service.preview({
      contractAddress,
      quantity,
      tokenId: Number(req.body.tokenId || 0),
      chainId: chain.id,
      concurrency: Number(req.body.concurrency || 2),
      accounts,
      executionMode,
      requestedScheduleAt: executionMode === "scheduled" ? req.body.scheduleAt || null : null,
      saleMode,
      whitelistCredentials: ["allowlist", "signed"].includes(saleMode) ? credentials[saleMode] : null,
      protections: req.body.protections || null,
      openSeaCatalog,
      openSeaStageUuid: openSeaStage?.uuid || null,
    })
    const selectedProfile = rpcProfiles.resolve(req.body.rpcProfileId || "main", chain.id, req.body.rpcProfileRef || "")
    const wallets = [
      ...preview.readyPlans.map((plan) => ({ ...serializePlan(plan), status: "ready" })),
      ...preview.skippedWallets.map((item) => ({ address: item.address, status: "skipped", reason: item.reason })),
      ...preview.failedWallets.map((item) => ({ address: item.address, status: "failed", error: item.message })),
    ]
    // The live preview holds a viem client and BigInt plans, so it stays server
    // side and only the serialized view goes out; /api/opensea-mint/send will
    // consume this confirmation once that route lands.
    const confirmation = preview.readyPlans.length ? taskConfirmations.create("opensea_mint", {
      chainId: chain.id,
      contractAddress,
      rpcProfileId: selectedProfile.id,
      rpcProfileRef: selectedProfile.profileRef || req.body.rpcProfileRef || "",
      executionMode,
      walletIdByAddress,
      preview,
    }) : null
    res.json({
      ok: Boolean(preview.readyPlans.length),
      chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol },
      contractAddress,
      quantity: quantity.toString(),
      executionMode,
      saleMode: preview.saleMode || saleMode,
      mintRoute: preview.mintRoute,
      routeReason: preview.routeReason,
      scheduledAt: preview.scheduledAt,
      openSeaStage: preview.openSeaStage || null,
      inspection: preview.inspection || null,
      estimatedTotalEth: formatEther(preview.readyPlans.reduce((sum, plan) => sum + plan.estimatedTotal, 0n)),
      wallets,
      confirmation,
    })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/opensea-mint/send", async (req, res, next) => {
  try {
    const execution = taskConfirmations.consume("opensea_mint", req.body.previewId, req.body.confirmationToken)
    const context = openSeaMintTaskContext(execution)
    if (context.scheduled) {
      // Arming waits for the sale to open, so the request cannot be held until
      // then. The task and its rows already exist, so /api/tasks reports progress.
      // Like osmint, an armed run lives only in this process and is lost on restart.
      // An unhandled rejection here would terminate the server, so the armed run
      // records its own failure instead of escaping.
      void runOpenSeaMintTask(context, execution).catch((error) => {
        finishTask(context.id, "failed", { results: context.results }, error.message)
      })
      res.status(202).json({
        ok: true,
        taskId: context.id,
        status: "armed",
        scheduledAt: execution.preview.scheduledAt,
        walletCount: execution.preview.readyPlans.length,
      })
      return
    }
    const result = await runOpenSeaMintTask(context, execution)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})
app.get("/api/follow-mint", (_req, res) => {
  res.json({ ok: true, ...followMint.list() })
})

app.post("/api/follow-mint/rules", (req, res, next) => {
  try {
    res.status(201).json({ ok: true, rule: followMint.create(req.body) })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.patch("/api/follow-mint/rules/:id", (req, res, next) => {
  try {
    const rule = followMint.update(req.params.id, req.body)
    if (!rule) throw httpError(404, "未找到跟单铸造规则")
    res.json({ ok: true, rule })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.delete("/api/follow-mint/rules/:id", (req, res, next) => {
  try {
    if (!followMint.remove(req.params.id)) throw httpError(404, "未找到跟单铸造规则")
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post("/api/follow-mint/rules/:id/arm", (req, res, next) => {
  try {
    const rule = followMint.arm(req.params.id, req.body.phrase)
    if (!rule) throw httpError(404, "未找到跟单铸造规则")
    res.json({ ok: true, rule })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/follow-mint/rules/:id/disarm", (req, res, next) => {
  try {
    const rule = followMint.disarm(req.params.id)
    if (!rule) throw httpError(404, "未找到跟单铸造规则")
    res.json({ ok: true, rule })
  } catch (error) {
    next(error)
  }
})

app.post("/api/follow-mint/rules/:id/preview", async (req, res, next) => {
  try {
    const run = await followMint.preview(req.params.id)
    if (!run) throw httpError(404, "未找到跟单铸造规则，或该规则已在运行")
    res.status(201).json({ ok: run.status !== "failed", run })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/signature-lab/analyze", async (req, res, next) => {
  try {
    const input = normalizeSignatureLabInput(req.body)
    const chain = chainConfig(input.chainId)
    const report = await inspectSignatureTransaction({ client: publicClient(chain.id), input })
    res.json({ ok: true, chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol }, ...report })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/signature-lab/preflight", async (req, res, next) => {
  try {
    const input = normalizeSignatureLabInput(req.body)
    const chain = chainConfig(input.chainId)
    const walletIds = normalizeWalletIds(req.body.walletIds)
    if (!walletIds.length) throw httpError(400, "请至少选择一个钱包")
    const wallets = walletIds.map(requireWallet)
    const report = await inspectSignatureTransaction({ client: publicClient(chain.id), input })
    const preflight = await preflightSignatureTransaction({
      client: publicClient(chain.id),
      transaction: report.transaction,
      wallets,
    })
    res.json({ ok: true, chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol }, ...report, preflight })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/advanced-mint/preview", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, job: await advancedMint.preview(req.body) })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/advanced-mint/send", (req, res, next) => {
  try {
    res.status(202).json({ ok: true, job: advancedMint.send(req.body) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/advanced-mint/jobs/:id", async (req, res, next) => {
  try {
    res.json({ ok: true, job: await advancedMint.reconcile(req.params.id) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/advanced-mint/jobs/:id/stop", (req, res, next) => {
  try {
    res.json({ ok: true, job: advancedMint.stop(req.params.id) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/advanced-mint/jobs/:id/accelerate", async (req, res, next) => {
  try {
    res.status(202).json({ ok: true, job: await advancedMint.accelerate(req.params.id, req.body) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/advanced-mint/jobs/:id/cancel", async (req, res, next) => {
  try {
    res.status(202).json({ ok: true, job: await advancedMint.cancel(req.params.id, req.body) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/overview", async (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    const windowSeconds = Number(req.query.window || 1800)
    res.json({ ok: true, ...(await mintMonitor.overview(chain.id, windowSeconds)) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/collection/:address", async (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    const address = assertAddress(req.params.address, "合集地址")
    const detail = await mintMonitor.collection(chain.id, address)
    if (!detail) throw httpError(404, "本地扫描窗口内没有该合集的铸造活动")
    res.json({ ok: true, collection: detail })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/status", (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    res.json({
      ok: true,
      status: {
        ...mintMonitor.status(chain.id),
        realtime: realtimeStream.status(chain.id),
        rpc: publicReadRpcStatus(chain.id),
        wss: realtimeWssFor(chain.id)?.status() || { state: "unconfigured", upstreams: [] },
        walletActivity: walletActivityMonitor.status(chain.id),
      },
    })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/trending", (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    const snapshot = trending.snapshot({
      chainId: chain.id,
      window: Number(req.query.window || 60),
      limit: Number(req.query.limit || 20),
    })
    res.json({ ok: true, ...snapshot })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.get("/api/collections/flags", (req, res, next) => {
  try {
    const chain = chainConfig(req.query.chainId || 1)
    res.json({ ok: true, ...collectionFlags.list({ chainId: chain.id, flag: req.query.flag }) })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/collections/:address/flag", (req, res, next) => {
  try {
    const chain = chainConfig(req.body.chainId || req.query.chainId || 1)
    const value = collectionFlags.upsert({
      chainId: chain.id,
      address: assertAddress(req.params.address, "合集地址"),
      flag: req.body.flag || "scam",
      note: req.body.note || "",
    })
    res.status(201).json({ ok: true, flag: value })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.delete("/api/collections/:address/flag", (req, res, next) => {
  try {
    const chain = chainConfig(req.body?.chainId || req.query.chainId || 1)
    if (!collectionFlags.remove(chain.id, assertAddress(req.params.address, "合集地址"))) throw httpError(404, "未找到个人合集标记")
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get("/api/seadrop-radar", async (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    const price = String(req.query.price || "all")
    if (!["all", "free", "paid"].includes(price)) throw httpError(400, "价格筛选无效")
    let scanError = ""
    try {
      await refreshSeaDropRadar(chain.id)
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error)
    }
    const snapshot = seaDropRadar.list({
      chainId: chain.id,
      includeUnscheduled: req.query.includeUnscheduled === "true",
      price,
      liveOnly: req.query.live === "true",
      publicOnly: req.query.publicOnly === "true",
    })
    res.json({ ok: true, chainId: chain.id, scanError, ...snapshot })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.get("/api/alerts", (req, res, next) => {
  try {
    const chainId = req.query.chainId ? chainConfig(req.query.chainId).id : undefined
    res.json({ ok: true, ...alertService.list({ chainId }), notifier: notifier.status() })
  } catch (error) {
    next(error)
  }
})

app.post("/api/alerts", (req, res, next) => {
  try {
    chainConfig(req.body.chainId)
    res.status(201).json({ ok: true, rule: alertService.create(req.body) })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.patch("/api/alerts/:id", (req, res, next) => {
  try {
    if (req.body.chainId !== undefined) chainConfig(req.body.chainId)
    const rule = alertService.update(req.params.id, req.body)
    if (!rule) throw httpError(404, "未找到报警规则")
    res.json({ ok: true, rule })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.delete("/api/alerts/:id", (req, res, next) => {
  try {
    if (!alertService.remove(req.params.id)) throw httpError(404, "未找到报警规则")
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post("/api/alerts/test", async (req, res, next) => {
  try {
    const chain = chainConfig(req.body.chainId || 1)
    const alert = {
      id: randomUUID(),
      chainId: chain.id,
      title: String(req.body.title || "611nft 测试报警").slice(0, 120),
      message: String(req.body.message || "报警通道工作正常").slice(0, 500),
      triggeredAt: now(),
    }
    const result = await deliverMonitorAlert(alert)
    res.json({ ok: true, alert, notification: result })
  } catch (error) {
    next(error)
  }
})

app.get("/api/bootstrap", async (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    const window = Number(req.query.window || 1800)
    const realtimeCursor = realtimeStream.status(chain.id).latestCursor
    const overviewRequest = mintMonitor.overview(chain.id, window)
    void refreshSeaDropRadar(chain.id).catch(() => {})
    const overview = await overviewRequest
    res.json({
      ok: true,
      snapshotVersion: 1,
      serverTime: now(),
      realtimeCursor,
      chainId: chain.id,
      status: {
        ...mintMonitor.status(chain.id),
        realtime: realtimeStream.status(chain.id),
        rpc: publicReadRpcStatus(chain.id),
        wss: realtimeWssFor(chain.id)?.status() || { state: "unconfigured", upstreams: [] },
        walletActivity: walletActivityMonitor.status(chain.id),
      },
      overview,
      trending: trending.snapshot({ chainId: chain.id, window, limit: 20 }),
      radar: seaDropRadar.list({ chainId: chain.id }),
      flags: collectionFlags.list({ chainId: chain.id }).flags,
    })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.get("/api/mint-monitor/stream", (req, res, next) => {
  try {
    const chain = ensureRealtimeChain(req.query.chainId || 1)
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders?.()
    const send = (message) => res.write(formatSseMessage(message))
    const headerCursor = String(req.headers["last-event-id"] || "").trim()
    const queryCursor = String(req.query.cursor || "").trim()
    const unsubscribe = realtimeStream.subscribe(chain.id, headerCursor || queryCursor, send)
    send({ cursor: null, value: { type: "monitor_status", chainId: chain.id, ...mintMonitor.status(chain.id) } })
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000)
    keepAlive.unref?.()
    req.on("close", () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/media/:id", async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) throw httpError(404, "未找到 NFT 媒体")
    let payload
    try {
      payload = await nftMediaResolver.loadMedia(req.params.id)
    } catch {
      res.setHeader("Cache-Control", "public, max-age=300")
      res.status(204).end()
      return
    }
    if (!payload) {
      res.setHeader("Cache-Control", "public, max-age=300")
      res.status(204).end()
      return
    }
    res.setHeader("Content-Type", payload.contentType)
    res.setHeader("Cache-Control", "public, max-age=86400, immutable")
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.send(payload.bytes)
  } catch (error) {
    next(error)
  }
})

app.get("/api/rpc-pool/status", async (_req, res) => {
  const requestedChainId = String(_req.query.chainId || "").trim()
  const chains = requestedChainId ? [chainConfig(requestedChainId)] : Object.values(CHAINS)
  const rows = await Promise.all(chains.map(async (chain) => {
    const started = performance.now()
    try {
      const blockNumber = await publicClient(chain.id).getBlockNumber()
      return {
        chainId: chain.id,
        chainName: chain.name,
        ok: true,
        blockNumber: blockNumber.toString(),
        latencyMs: Math.round(performance.now() - started),
        activeHost: publicReadRpcStatus(chain.id).activeHost || null,
        upstreams: publicReadRpcStatus(chain.id).upstreams.length ? publicReadRpcStatus(chain.id).upstreams : chain.rpcUrls.map((url) => ({ host: hostnameFor(url), state: "unprobed" })),
        lanes: publicReadRpcStatus(chain.id).lanes,
        wss: realtimeWssFor(chain.id)?.status() || { state: "unconfigured", upstreams: [] },
      }
    } catch (error) {
      return {
        chainId: chain.id,
        chainName: chain.name,
        ok: false,
        error: error.message,
        latencyMs: Math.round(performance.now() - started),
        activeHost: publicReadRpcStatus(chain.id).activeHost || null,
        upstreams: publicReadRpcStatus(chain.id).upstreams.length ? publicReadRpcStatus(chain.id).upstreams : chain.rpcUrls.map((url) => ({ host: hostnameFor(url), state: "unprobed" })),
        lanes: publicReadRpcStatus(chain.id).lanes,
        wss: realtimeWssFor(chain.id)?.status() || { state: "unconfigured", upstreams: [] },
      }
    }
  }))
  res.status(rows.some((row) => row.ok) ? 200 : 503).json({ ok: rows.every((row) => row.ok), chains: rows })
})

function optionalRpcChainId(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw httpError(400, `无效 chainId：${value}`)
  return parsed
}

function rpcProfileRequestOptions(body = {}) {
  const options = { profileRef: body.profileRef || "" }
  if (Object.prototype.hasOwnProperty.call(body, "endpoints")) options.endpoints = body.endpoints
  else if (Object.prototype.hasOwnProperty.call(body, "rpcUrls")) options.endpoints = body.rpcUrls
  else if (Object.prototype.hasOwnProperty.call(body, "rpcUrl")) options.endpoints = body.rpcUrl
  return options
}

app.get("/api/rpc-profiles", (req, res, next) => {
  try {
    const chainId = optionalRpcChainId(req.query.chainId)
    // The public list is always the sender list. `all=true` and an omitted
    // chainId are both supported; a supplied chainId is only a custom-profile
    // hint and never disables the other built-in senders.
    const profiles = rpcProfiles.list(chainId)
    res.json({ ok: true, ...(chainId === undefined ? {} : { chainId }), profiles })
  } catch (error) {
    next(error)
  }
})

app.post("/api/rpc-profiles/test", async (req, res, next) => {
  try {
    const chainId = optionalRpcChainId(req.body?.chainId)
    const result = await rpcProfiles.test(req.body?.profileId || "main", chainId, rpcProfileRequestOptions(req.body))
    res.json({ ok: true, chainId: result.chainId, test: result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/rpc-profiles/select", async (req, res, next) => {
  try {
    const chainId = optionalRpcChainId(req.body?.chainId)
    const profile = await rpcProfiles.select(req.body?.profileId || "main", chainId, rpcProfileRequestOptions(req.body))
    res.json({ ok: true, chainId: profile.chainId, profile })
  } catch (error) {
    next(error)
  }
})

app.post("/api/rpc-pool/select", async (req, res, next) => {
  try {
    const chainId = optionalRpcChainId(req.body?.chainId)
    const requested = req.body?.profileId || (req.body?.upstreamId ? "main" : "main")
    const profile = await rpcProfiles.select(requested, chainId, rpcProfileRequestOptions(req.body))
    res.json({ ok: true, chainId: profile.chainId, profile, deprecated: true })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/nft-mint/preview", async (req, res, next) => {
  try {
    const job = await previewNftMint(req.body)
    res.status(201).json({ ok: true, job: publicNftMintJob(job, { includeConfirmation: true }) })
  } catch (error) {
    if (!error.status) error.status = 400
    next(error)
  }
})

app.post("/api/nft-mint/send", (req, res, next) => {
  try {
    const job = nftMintJobs.get(String(req.body.jobId || ""))
    if (!job) throw httpError(404, "铸造预览不存在或已过期")
    if (job.status !== "previewed") throw httpError(409, "铸造任务当前状态不允许发送")
    if (job.expiresAtMs <= Date.now()) {
      nftMintJobs.delete(job.id)
      throw httpError(410, "铸造预览已过期，请在发送前重新预览")
    }
    if (!mintConfirmationMatches(job.confirmationToken, req.body.confirmationToken)) {
      throw httpError(403, "铸造确认凭据缺失或无效")
    }
    if (!job.preview.readyPlans.length) throw httpError(409, "没有钱包通过预检")

    job.confirmationToken = ""
    job.status = "sending"
    for (const wallet of job.wallets) {
      if (wallet.status === "ready") wallet.status = "pending"
    }
    touchNftMintJob(job)
    res.status(202).json({ ok: true, job: publicNftMintJob(job) })
    void sendNftMintJob(job)
  } catch (error) {
    next(error)
  }
})

app.get("/api/nft-mint/jobs/:id", (req, res, next) => {
  try {
    const job = nftMintJobs.get(req.params.id)
    if (!job) throw httpError(404, "铸造任务不存在或已过期")
    res.json({ ok: true, job: publicNftMintJob(job) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/wallets", (_req, res) => {
  const wallets = listWallets()
  res.json({
    wallets,
    walletProvider: walletProvider.summary(),
    localWalletCount: 0,
    externalWalletCount: wallets.length,
  })
})

app.patch("/api/wallets/:id", (req, res) => {
  requireWallet(req.params.id)
  const label = String(req.body.label || "")
  const group = normalizeWalletGroup(req.body.group)
  const note = String(req.body.note || "")
  const risk = String(req.body.risk || "")
  const proxyIp = String(req.body.proxyIp || "").trim().slice(0, 300)
  const exchangeAddress = String(req.body.exchangeAddress || "").trim().slice(0, 160)
  const favorite = req.body.favorite ? 1 : 0
  db.prepare(`
    INSERT INTO wallet_meta (wallet_id, label, wallet_group, note, favorite, risk, proxy_ip, exchange_address, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_id) DO UPDATE SET
      label = excluded.label,
      wallet_group = excluded.wallet_group,
      note = excluded.note,
      favorite = excluded.favorite,
      risk = excluded.risk,
      proxy_ip = excluded.proxy_ip,
      exchange_address = excluded.exchange_address,
      updated_at = excluded.updated_at
  `).run(req.params.id, label, group, note, favorite, risk, proxyIp, exchangeAddress, now())
  res.json({ ok: true, wallet: listWallets().find((wallet) => wallet.id === req.params.id) })
})

app.post("/api/wallets/bulk-group", (req, res, next) => {
  try {
    const walletIds = normalizeWalletIds(req.body.walletIds)
    walletIds.forEach(requireWallet)
    const group = normalizeWalletGroup(req.body.group)
    const statement = db.prepare(`
      INSERT INTO wallet_meta (wallet_id, wallet_group, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(wallet_id) DO UPDATE SET wallet_group = excluded.wallet_group, updated_at = excluded.updated_at
    `)
    for (const id of walletIds) statement.run(id, group, now())
    res.json({ ok: true, wallets: listWallets() })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/network/test-proxy", (req, res, next) => {
  try {
    const raw = String(req.body.proxy || "").trim()
    if (!raw) throw httpError(400, "必须填写代理主机和端口")
    const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`)
    const host = parsed.hostname
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, "代理地址无效")
    const started = performance.now()
    const socket = connectSocket({ host, port })
    const timer = setTimeout(() => socket.destroy(new Error("Proxy connection timed out")), 5000)
    socket.once("connect", () => {
      clearTimeout(timer)
      const latencyMs = Math.round(performance.now() - started)
      socket.destroy()
      res.json({ ok: true, host, port, latencyMs, testedAt: now() })
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      error.status = 502
      next(error)
    })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/wallets/create", async (req, res, next) => {
  try {
    const requestedCount = Number(req.body.count || 1)
    const requestedStart = Number(req.body.start || 1)
    if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > 500) throw httpError(400, "创建数量必须是 1 到 500 的整数")
    if (!Number.isSafeInteger(requestedStart) || requestedStart < 0) throw httpError(400, "起始编号必须是非负整数")
    const count = requestedCount
    const prefix = String(req.body.prefix || "wallet").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "wallet"
    const { created, skipped } = await walletProvider.createWallets({ prefix, start: requestedStart, count })
    res.json({ ok: true, created, skipped, totalCount: listWallets().length })
  } catch (error) {
    next(error)
  }
})

app.post("/api/balances/refresh", async (req, res, next) => {
  try {
    const rows = await refreshBalances(req.body)
    res.json({ ok: true, balances: rows, wallets: listWallets() })
  } catch (error) {
    next(error)
  }
})

app.post("/api/token-holdings/query", async (req, res, next) => {
  try {
    cleanupTokenHoldingSnapshots()
    const chain = chainConfig(req.body.chainId || 1)
    const walletIds = normalizeWalletIds(req.body.walletIds)
    const wallets = walletIds.map(requireWallet)
    let holdings = await resolveHoldings({ chainId: chain.id, contractAddress: req.body.contractAddress, wallets })
    if (req.body.includeMetadata && !holdings.source && ["ERC721", "ERC1155"].includes(holdings.standard)) {
      holdings = await attachHoldingMetadata(holdings, chain.id)
    }
    // Listing state comes back from OpenSea so it survives re-queries, page switches and
    // restarts; a failure here must not cost the caller their holdings.
    if (["ERC721", "ERC1155"].includes(holdings.standard)) {
      holdings = attachListingState(holdings, await fetchActiveListings({
        chainId: chain.id,
        contractAddress: holdings.contractAddress,
        // Naming the tokens turns a bounded collection-wide scan into one exact lookup per
        // held token. On a 6000-listing collection the scan reached only a fraction of a
        // wallet's listings, so most of them read as "not listed".
        tokenIds: holdings.rows.map((row) => row.tokenId),
        owners: holdings.rows.map((row) => row.address),
      }).catch((error) => {
        console.warn(`[holdings] 挂单状态查询失败：${error.message}`)
        return null
      }))
      holdings = attachOfferState(holdings, await fetchCollectionOffers({
        chainId: chain.id,
        contractAddress: holdings.contractAddress,
      }).catch((error) => {
        console.warn(`[holdings] 报价状态查询失败：${error.message}`)
        return null
      }))
    }
    const snapshotId = randomUUID()
    const expiresAtMs = Date.now() + TASK_CONFIRM_TTL_MS
    tokenHoldingSnapshots.set(snapshotId, { snapshotId, chainId: chain.id, walletIds, holdings, expiresAtMs })
    res.json({
      ok: true,
      snapshotId,
      chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol },
      holdings,
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/plan/token-collect", (req, res, next) => {
  try {
    cleanupTokenHoldingSnapshots()
    const snapshot = tokenHoldingSnapshots.get(String(req.body.snapshotId || ""))
    if (!snapshot) throw httpError(404, "持仓查询结果不存在或已过期，请重新查询")
    const selectedIds = normalizeWalletIds(req.body.holdingIds)
    const rowsById = new Map(snapshot.holdings.rows.map((row) => [row.id, row]))
    const rows = selectedIds.map((id) => {
      const row = rowsById.get(id)
      if (!row) throw httpError(400, `持仓行不属于当前查询结果：${id}`)
      return row
    })
    const plan = {
      chain: chainConfig(snapshot.chainId),
      standard: snapshot.holdings.standard,
      rows,
      ...buildTokenCollectPlan({
        contractAddress: snapshot.holdings.contractAddress,
        destination: req.body.destination,
        rows,
      }),
    }
    res.json({ ok: true, ...plan, confirmation: taskPreview("token_collect", plan, req.body, "burst") })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/tasks/token-collect", async (req, res, next) => {
  try {
    const result = await executeConfirmedTask("token_collect", req.body)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/plan/nft-approval", async (req, res, next) => {
  try {
    cleanupTokenHoldingSnapshots()
    const chain = chainConfig(req.body.chainId || 1)
    let walletIds = normalizeWalletIds(req.body.walletIds)
    let contractAddress = req.body.contractAddress
    let standard = ""
    if (req.body.snapshotId) {
      const snapshot = tokenHoldingSnapshots.get(String(req.body.snapshotId))
      if (!snapshot) throw httpError(404, "持仓查询结果不存在或已过期，请重新查询")
      if (snapshot.chainId !== chain.id) throw httpError(400, "持仓查询结果不属于当前链")
      contractAddress = snapshot.holdings.contractAddress
      standard = snapshot.holdings.standard
      if (req.body.holdingsOnly) {
        const holdingWalletIds = new Set(snapshot.holdings.rows.map((row) => row.walletId))
        walletIds = walletIds.filter((id) => holdingWalletIds.has(id))
      }
    }
    const wallets = walletIds.map(requireWallet)
    const plan = await buildNftApprovalPlan({
      client: publicClient(chain.id),
      chainId: chain.id,
      contractAddress,
      wallets,
      marketplaceId: req.body.marketplace,
      approved: req.body.approved !== false,
      standard,
    })
    const confirmation = plan.entries.length ? taskConfirmations.create("nft_approval", {
      type: plan.approved ? "nft_approval" : "nft_approval_revoke",
      chainId: chain.id,
      rpcProfileId: rpcProfiles.resolve(req.body.rpcProfileId || "main", chain.id, req.body.rpcProfileRef || "").id,
      rpcProfileRef: rpcProfiles.resolve(req.body.rpcProfileId || "main", chain.id, req.body.rpcProfileRef || "").profileRef || req.body.rpcProfileRef || "",
      entries: plan.entries,
      mode: req.body.executionMode || "burst",
      preflight: req.body.preflight !== false,
    }) : null
    res.json({ ok: true, chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol }, ...plan, confirmation })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/tasks/nft-approval", async (req, res, next) => {
  try {
    const execution = taskConfirmations.consume("nft_approval", req.body.previewId, req.body.confirmationToken)
    const result = await executeEntries(execution)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/nft-listings/preview", async (req, res, next) => {
  try {
    cleanupTokenHoldingSnapshots()
    const snapshot = tokenHoldingSnapshots.get(String(req.body.snapshotId || ""))
    if (!snapshot) throw httpError(404, "持仓查询结果不存在或已过期，请重新查询")
    if (!["ERC721", "ERC1155"].includes(snapshot.holdings.standard)) throw httpError(400, "挂单只支持 ERC721 或 ERC1155")
    const holdingIds = normalizeWalletIds(req.body.holdingIds)
    const rowsById = new Map(snapshot.holdings.rows.map((row) => [row.id, row]))
    const rows = holdingIds.map((id) => {
      const row = rowsById.get(id)
      if (!row) throw httpError(400, `持仓行不属于当前查询结果：${id}`)
      return row
    })
    const job = await nftListingService.preview({
      chainId: snapshot.chainId,
      contractAddress: snapshot.holdings.contractAddress,
      standard: snapshot.holdings.standard,
      rows,
      prices: req.body.prices,
      amounts: req.body.amounts,
      marketplaceId: req.body.marketplace,
      durationSeconds: req.body.durationSeconds,
    })
    res.status(201).json({ ok: true, job })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/nft-listings/submit", async (req, res, next) => {
  const taskIdValue = createTask("nft_listing", { previewId: req.body.previewId })
  try {
    const job = await nftListingService.submit(req.body)
    finishTask(taskIdValue, job.status === "submitted" ? "done" : job.status, { job })
    res.status(202).json({ ok: job.status === "submitted", taskId: taskIdValue, job })
  } catch (error) {
    finishTask(taskIdValue, "failed", {}, error.message)
    error.status = error.status || 400
    next(error)
  }
})

app.get("/api/nft-listings/:id", (req, res, next) => {
  try {
    const job = nftListingService.get(req.params.id)
    if (!job) throw httpError(404, "未找到挂单任务")
    res.json({ ok: true, job })
  } catch (error) {
    next(error)
  }
})

app.post("/api/nft-offers/preview", async (req, res, next) => {
  try {
    cleanupTokenHoldingSnapshots()
    const snapshot = tokenHoldingSnapshots.get(String(req.body.snapshotId || ""))
    if (!snapshot) throw httpError(404, "持仓查询结果不存在或已过期，请重新查询")
    if (!["ERC721", "ERC1155"].includes(snapshot.holdings.standard)) throw httpError(400, "接 offer 只支持 ERC721 或 ERC1155")
    const holdingIds = normalizeWalletIds(req.body.holdingIds)
    const rowsById = new Map(snapshot.holdings.rows.map((row) => [row.id, row]))
    const rows = holdingIds.map((id) => {
      const row = rowsById.get(id)
      if (!row) throw httpError(400, `持仓行不属于当前查询结果：${id}`)
      return row
    })
    const plan = await nftOfferService.preview({
      chainId: snapshot.chainId,
      contractAddress: snapshot.holdings.contractAddress,
      standard: snapshot.holdings.standard,
      rows,
      marketplaceId: req.body.marketplace || "opensea",
    })
    const selectedProfile = rpcProfiles.resolve(req.body.rpcProfileId || "main", snapshot.chainId, req.body.rpcProfileRef || "")
    const confirmation = plan.summary.ready ? taskConfirmations.create("offer_accept", {
      type: "offer_accept",
      chainId: snapshot.chainId,
      rpcProfileId: selectedProfile.id,
      rpcProfileRef: selectedProfile.profileRef || req.body.rpcProfileRef || "",
      entries: plan.entries,
      mode: req.body.executionMode || "burst",
      preflight: req.body.preflight !== false,
    }) : null
    res.status(201).json({ ok: true, ...plan, confirmation })
  } catch (error) {
    error.status = error.status || 400
    next(error)
  }
})

app.post("/api/tasks/nft-offers/accept", async (req, res, next) => {
  try {
    const execution = taskConfirmations.consume("offer_accept", req.body.previewId, req.body.confirmationToken)
    const result = await executeEntries(execution)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/plan/one-to-many", async (req, res, next) => {
  try {
    const plan = await buildOneToManyPlan(req.body)
    res.json({ ok: true, ...plan, confirmation: taskPreview("one_to_many", plan, req.body) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/tasks/one-to-many", async (req, res, next) => {
  try {
    const result = await executeConfirmedTask("one_to_many", req.body)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/plan/many-to-one", async (req, res, next) => {
  try {
    const plan = await buildManyToOnePlan(req.body)
    res.json({ ok: true, ...plan, confirmation: taskPreview("many_to_one", plan, req.body, "burst") })
  } catch (error) {
    next(error)
  }
})

app.post("/api/tasks/many-to-one", async (req, res, next) => {
  try {
    const result = await executeConfirmedTask("many_to_one", req.body)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/plan/many-to-many", async (req, res, next) => {
  try {
    const plan = await buildManyToManyPlan(req.body)
    res.json({ ok: true, ...plan, confirmation: taskPreview("many_to_many", plan, req.body) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/tasks/many-to-many", async (req, res, next) => {
  try {
    const result = await executeConfirmedTask("many_to_many", req.body)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/plan/approval", async (req, res, next) => {
  try {
    const plan = await buildApprovalPlan(req.body)
    const executionType = plan.revoke ? "revoke" : "approve"
    const confirmation = taskConfirmations.create("approval", {
      type: executionType,
      chainId: plan.chain.id,
      rpcProfileId: rpcProfiles.resolve(req.body.rpcProfileId || "main", plan.chain.id, req.body.rpcProfileRef || "").id,
      rpcProfileRef: rpcProfiles.resolve(req.body.rpcProfileId || "main", plan.chain.id, req.body.rpcProfileRef || "").profileRef || req.body.rpcProfileRef || "",
      entries: plan.entries,
      mode: req.body.executionMode || "burst",
      preflight: req.body.preflight !== false,
    })
    res.json({ ok: true, ...plan, confirmation })
  } catch (error) {
    next(error)
  }
})

app.post("/api/tasks/approval", async (req, res, next) => {
  try {
    const execution = taskConfirmations.consume("approval", req.body.previewId, req.body.confirmationToken)
    const result = await executeEntries(execution)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.post("/api/plan/contract-call", (req, res, next) => {
  try {
    const plan = buildContractCallPlan(req.body)
    res.json({ ok: true, ...plan, confirmation: taskPreview("contract_call", plan, req.body) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/tasks/contract-call", async (req, res, next) => {
  try {
    const result = await executeConfirmedTask("contract_call", req.body)
    res.json({ ok: result.status !== "failed", ...result })
  } catch (error) {
    next(error)
  }
})

app.get("/api/tasks", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)))
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit).map((task) => ({
    taskId: task.task_id,
    type: task.task_type,
    status: task.status,
    params: JSON.parse(task.params_json || "{}"),
    result: JSON.parse(task.result_json || "{}"),
    error: task.error,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  }))
  res.json({ tasks })
})

app.get("/api/transactions", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)))
  const rows = db.prepare("SELECT * FROM tx_log ORDER BY created_at DESC LIMIT ?").all(limit).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    walletId: row.wallet_id,
    chainId: row.chain_id,
    type: row.tx_type,
    status: row.status,
    txHash: row.tx_hash,
    summary: row.summary,
    error: row.error,
    metadata: JSON.parse(row.metadata_json || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
  res.json({ transactions: rows })
})

app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "未找到 API 路由" })
})

if (existsSync(DIST_ROOT)) {
  app.use(express.static(DIST_ROOT, { index: false }))

  app.get(/^\/nfttool-runtime(?:\/.*)?$/, (_req, res) => {
    res.sendFile(join(NFTTOOL_RUNTIME_ROOT, "index.html"))
  })

  app.get(/.*/, (_req, res) => {
    res.sendFile(join(DIST_ROOT, "index.html"))
  })
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500
  res.status(status).json({ ok: false, error: redactRpcMessage(err.message || "服务器内部错误") })
})

const httpServers = API_HOSTS.map((host) => app.listen(PORT, host, () => {
  console.log(`钱包工作区正在监听 http://${host}:${PORT}`)
}))

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(receiptReconcileTimer)
  clearInterval(trendingTimer)
  clearInterval(radarTimer)
  followMint.stop()
  detachRealtimeStream()
  detachTrending()
  detachAlertDelivery()
  detachRadar()
  for (const unsubscribe of rawMonitorUnsubscribers) unsubscribe()
  for (const manager of wssManagers.values()) manager.stop()
  walletActivityMonitor.stop()
  realtimeStream.stop()
  mintMonitor.stop()
  await notifier.flush()
  await Promise.all(httpServers.map((server) => new Promise((resolve) => server.close(resolve))))
  process.exit(0)
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
