import "./env.js"
import express from "express"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
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
  parseEther,
  parseUnits,
} from "viem"
import { arbitrum, base, bsc, mainnet, optimism, polygon } from "viem/chains"
import {
  buildNftMintPreview,
  mapMintConcurrent,
  parseMintPreviewInput,
  requoteSeaDropPlan,
} from "./nft-mint.js"
import { createMintMonitor } from "./mint-monitor.js"
import { createNftMediaResolver } from "./nft-media.js"
import { createNftMinterStore, migrateNftMinterStore } from "./nft-minter-store.js"
import { createRpcPool } from "./rpc-pool.js"
import { resolveListenHosts } from "./listen-hosts.js"
import { assertSecureRemoteConfiguration, requireRemoteApiAuth } from "./security.js"
import { createTaskConfirmationStore } from "./task-confirmations.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)
const WALLET_ROOT = join(homedir(), ".openclaw-wallet")
const WALLETS_PATH = join(WALLET_ROOT, "wallets.json")
const DB_PATH = join(ROOT, "wallet-board.sqlite")
const DIST_ROOT = join(ROOT, "dist")
const MINT_ROOT = join(ROOT, "ascii-cats-mint")
const MINT_ENV_PATH = join(MINT_ROOT, ".env")
const PORT = Number(process.env.WALLET_BOARD_PORT || 8787)
const API_HOST = process.env.WALLET_BOARD_API_HOST || "127.0.0.1"
const API_HOSTS = resolveListenHosts(API_HOST, process.env.WALLET_BOARD_API_HOSTS)
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
const MINT_LOG_LIMIT = 2000
const RECEIPT_CACHE_PENDING_MS = 5000
const RECEIPT_CACHE_ERROR_MS = 5000
const NFT_MINT_CONFIRM_TTL_MS = safeDurationMs(process.env.NFT_MINT_CONFIRM_TTL_MS, 10 * 60 * 1000)
const NFT_MINT_JOB_TTL_MS = 30 * 60 * 1000
const TASK_CONFIRM_TTL_MS = safeDurationMs(process.env.WALLET_BOARD_TASK_CONFIRM_TTL_MS, 10 * 60 * 1000)
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
    rpcUrls: rpcPool(process.env.ETH_RPC_URL || "https://ethereum.publicnode.com", process.env.ETH_RPC_URLS, ["https://eth.drpc.org", "https://rpc.flashbots.net"]),
    explorer: "https://etherscan.io",
  },
  8453: {
    id: 8453,
    key: "base",
    name: "Base",
    nativeSymbol: "ETH",
    viem: base,
    rpcUrl: process.env.BASE_RPC_URL || "https://base.publicnode.com",
    rpcUrls: rpcPool(process.env.BASE_RPC_URL || "https://base.publicnode.com", process.env.BASE_RPC_URLS, ["https://base.drpc.org", "https://mainnet.base.org"]),
    explorer: "https://basescan.org",
  },
  42161: {
    id: 42161,
    key: "arbitrum",
    name: "Arbitrum",
    nativeSymbol: "ETH",
    viem: arbitrum,
    rpcUrl: process.env.ARBITRUM_RPC_URL || "https://arbitrum-one.publicnode.com",
    rpcUrls: rpcPool(process.env.ARBITRUM_RPC_URL || "https://arbitrum-one.publicnode.com", process.env.ARBITRUM_RPC_URLS, ["https://arb1.arbitrum.io/rpc"]),
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
    explorer: "https://bscscan.com",
  },
  4663: {
    id: 4663,
    key: "robinhood",
    name: "Robinhood Chain",
    nativeSymbol: "ETH",
    viem: robinhood,
    rpcUrl: ROBINHOOD_RPC_URL,
    rpcUrls: rpcPool(ROBINHOOD_RPC_URL, process.env.ROBINHOOD_RPC_URLS, ["https://rpc.arrowrpc.com"]),
    explorer: "https://robinhoodchain.blockscout.com",
  },
}

const db = new DatabaseSync(DB_PATH)

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
  const timestamp = now()
  db.prepare("UPDATE tasks SET status = 'interrupted', error = CASE WHEN error = '' THEN 'Server restarted before task completion' ELSE error END, updated_at = ? WHERE status = 'running'").run(timestamp)
  db.prepare("UPDATE tx_log SET status = 'interrupted', error = CASE WHEN error = '' THEN 'Server restarted before broadcast' ELSE error END, updated_at = ? WHERE status = 'running' AND tx_hash = ''").run(timestamp)
  db.prepare("UPDATE tx_log SET status = 'confirmation_pending', updated_at = ? WHERE status IN ('running', 'sent', 'pending') AND tx_hash <> ''").run(timestamp)
  migrateNftMinterStore(db)
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
  res.status(401).json({ ok: false, error: "A valid WALLET_BOARD_API_TOKEN bearer token is required" })
})

function now() {
  return new Date().toISOString()
}

function taskId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

function ensureWalletRoot() {
  if (!existsSync(WALLET_ROOT)) mkdirSync(WALLET_ROOT, { recursive: true, mode: 0o700 })
}

function readRegistry() {
  if (!existsSync(WALLETS_PATH)) return {}
  return JSON.parse(readFileSync(WALLETS_PATH, "utf8"))
}

function parseEnvText(text) {
  const env = {}
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const index = line.indexOf("=")
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function readMintEnv() {
  if (!existsSync(MINT_ENV_PATH)) return {}
  return parseEnvText(readFileSync(MINT_ENV_PATH, "utf8"))
}

function countDataLines(filePath) {
  if (!filePath || !existsSync(filePath)) return 0
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")).length
}

function hostnameFor(value) {
  try {
    return new URL(value).hostname
  } catch {
    return ""
  }
}

function mintConfigSnapshot() {
  const env = readMintEnv()
  const proxyFile = env.PROXY_FILE || "proxies.txt"
  const proxyReserveFile = env.PROXY_RESERVE_FILE || ""
  const privateKeysFile = env.PRIVATE_KEYS_FILE || ""
  return {
    envPresent: existsSync(MINT_ENV_PATH),
    walletSource: privateKeysFile ? "private-key-file" : env.MNEMONIC ? "mnemonic" : env.PRIVATE_KEY ? "single-key" : "missing",
    walletCount: Number(env.WALLET_COUNT || 0),
    privateKeysFile: privateKeysFile ? "configured" : "",
    proxyFile,
    proxyFileLines: countDataLines(join(MINT_ROOT, proxyFile)),
    proxyReserveFile,
    proxyReserveLines: proxyReserveFile ? countDataLines(join(MINT_ROOT, proxyReserveFile)) : 0,
    staticProxyCount: Number(env.STATIC_PROXY_COUNT || 0),
    dynamicProxyCount: Number(env.DYNAMIC_PROXY_COUNT || 0),
    proxyCheckTimeoutMs: Number(env.PROXY_CHECK_TIMEOUT_MS || 0),
    proxyMaxReplacements: Number(env.PROXY_MAX_REPLACEMENTS || 0),
    proxyPreheat: ["1", "true", "yes", "on"].includes(String(env.PROXY_PREHEAT || "").toLowerCase()),
    proxyPreheatRecheckMs: Number(env.PROXY_PREHEAT_RECHECK_MS || 0),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 0),
    mintConcurrency: Number(env.MINT_CONCURRENCY || 0),
    failedReceiptRetries: Number(env.MINT_FAILED_RECEIPT_RETRIES || 0),
    rpcHost: hostnameFor(env.RPC_URL || ROBINHOOD_RPC_URL),
    armDefault: ["1", "true", "yes", "on"].includes(String(env.ARM || "").toLowerCase()),
  }
}

let mintChild = null
let mintRun = {
  running: false,
  mode: "",
  pid: null,
  startedAt: "",
  exitedAt: "",
  exitCode: null,
  signal: "",
  command: "",
  error: "",
  logs: [],
}

const receiptCache = new Map()
const nftMintJobs = new Map()
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

function appendMintLog(stream, chunk) {
  const text = String(chunk || "")
  for (const part of text.split(/\r?\n/)) {
    const line = part.trimEnd()
    if (!line) continue
    mintRun.logs.push({ at: now(), stream, line })
    if (mintRun.logs.length > MINT_LOG_LIMIT) {
      mintRun.logs.splice(0, mintRun.logs.length - MINT_LOG_LIMIT)
    }
  }
}

function mintStatus() {
  return {
    ...mintRun,
    config: mintConfigSnapshot(),
    logs: mintRun.logs.slice(-220),
  }
}

function startMintRunner(mode) {
  if (mintChild) throw httpError(409, "Mint runner is already running")
  if (!existsSync(MINT_ROOT)) throw httpError(404, "ascii-cats-mint folder is missing")
  if (!["dry-run", "armed"].includes(mode)) throw httpError(400, "Invalid runner mode")

  const args = mode === "armed" ? ["start", "--", "--arm"] : ["start"]
  mintRun = {
    running: true,
    mode,
    pid: null,
    startedAt: now(),
    exitedAt: "",
    exitCode: null,
    signal: "",
    command: `npm ${args.join(" ")}`,
    error: "",
    logs: [],
  }
  appendMintLog("system", `starting ${mintRun.command}`)
  const child = spawn("npm", args, {
    cwd: MINT_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  mintChild = child
  mintRun.pid = child.pid
  child.stdout.on("data", (data) => appendMintLog("stdout", data))
  child.stderr.on("data", (data) => appendMintLog("stderr", data))
  child.on("error", (error) => {
    mintRun.error = error.message
    appendMintLog("system", error.message)
  })
  child.on("close", (code, signal) => {
    mintRun.running = false
    mintRun.exitedAt = now()
    mintRun.exitCode = code
    mintRun.signal = signal || ""
    appendMintLog("system", `exited code=${code ?? "null"} signal=${signal || "none"}`)
    mintChild = null
  })
  return mintStatus()
}

function hexToBigInt(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null
  return BigInt(value)
}

function parseMintResultLine(line) {
  const match = /^\s*\[(\d+)]\s+(0x[a-fA-F0-9]{40})\s+status=([^\s]+)(?:\s+txHash=(0x[a-fA-F0-9]{64}))?(?:\s+error=(.*))?$/.exec(line)
  if (!match) return null
  return {
    index: Number(match[1]),
    address: match[2],
    status: match[3],
    txHash: match[4] || "",
    txHashSource: match[4] ? "log" : "",
    error: match[5] || "",
  }
}

function parseSummaryLine(line) {
  if (!line.startsWith("summary:")) return null
  const summary = {}
  for (const part of line.replace(/^summary:\s*/, "").split(/\s+/)) {
    const [key, value] = part.split("=")
    if (!key) continue
    summary[key] = Number(value || 0)
  }
  return summary
}

function readMintStateTxs() {
  const dir = join(MINT_ROOT, ".mint-state")
  const byAddress = new Map()
  if (!existsSync(dir)) return byAddress

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    try {
      const state = JSON.parse(readFileSync(join(dir, file), "utf8"))
      const address = String(state.wallet || "").toLowerCase()
      const txHash = String(state.txHash || "")
      if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) continue
      byAddress.set(address, {
        status: String(state.status || ""),
        txHash,
        submittedAt: state.submittedAt || "",
      })
    } catch {
      // Ignore unreadable telemetry here; the mint runner itself remains fail-closed.
    }
  }
  return byAddress
}

function parseMintLogResults() {
  const rowsByIndex = new Map()
  let logSummary = {}
  let sawResultsHeader = false

  for (const entry of mintRun.logs) {
    if (entry.line === "--- results ---") sawResultsHeader = true
    const row = parseMintResultLine(entry.line)
    if (row) rowsByIndex.set(row.index, { ...row, at: entry.at })
    const summary = parseSummaryLine(entry.line)
    if (summary) logSummary = summary
  }

  const stateTxs = readMintStateTxs()
  const rows = [...rowsByIndex.values()].sort((a, b) => a.index - b.index)
  for (const row of rows) {
    if (row.txHash) continue
    const state = stateTxs.get(row.address.toLowerCase())
    if (!state?.txHash) continue
    row.txHash = state.txHash
    row.txHashSource = "state"
    row.stateStatus = state.status
    row.submittedAt = state.submittedAt
  }

  return { rows, logSummary, sawResultsHeader }
}

async function robinhoodRpc(method, params, { timeoutMs = 5000 } = {}) {
  const response = await fetch(ROBINHOOD_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error) throw new Error(payload.error.message || "RPC error")
  return payload.result
}

async function transactionReceiptStats(txHash) {
  const normalized = String(txHash || "").toLowerCase()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) return null

  const cached = receiptCache.get(normalized)
  if (cached) {
    const age = Date.now() - cached.cachedAt
    if (cached.terminal || age < cached.ttlMs) return cached.value
  }

  const started = performance.now()
  let value
  let terminal = false
  let ttlMs = RECEIPT_CACHE_PENDING_MS
  try {
    const receipt = await robinhoodRpc("eth_getTransactionReceipt", [normalized])
    if (!receipt) {
      value = {
        status: "pending",
        fetchedAt: now(),
        latencyMs: Math.round(performance.now() - started),
      }
    } else {
      const gasUsed = hexToBigInt(receipt.gasUsed) ?? 0n
      const effectiveGasPrice = hexToBigInt(receipt.effectiveGasPrice || receipt.gasPrice) ?? 0n
      const feeWei = gasUsed * effectiveGasPrice
      const blockNumber = hexToBigInt(receipt.blockNumber)
      value = {
        status: receipt.status === "0x1" ? "success" : receipt.status === "0x0" ? "failed" : "unknown",
        blockNumber: blockNumber === null ? "" : blockNumber.toString(),
        gasUsed: gasUsed.toString(),
        effectiveGasPriceWei: effectiveGasPrice.toString(),
        effectiveGasPriceGwei: formatUnits(effectiveGasPrice, 9),
        feeWei: feeWei.toString(),
        feeEth: formatEther(feeWei),
        fetchedAt: now(),
        latencyMs: Math.round(performance.now() - started),
      }
      terminal = true
    }
  } catch (error) {
    value = {
      status: "error",
      error: error.message,
      fetchedAt: now(),
      latencyMs: Math.round(performance.now() - started),
    }
    ttlMs = RECEIPT_CACHE_ERROR_MS
  }

  receiptCache.set(normalized, { value, terminal, ttlMs, cachedAt: Date.now() })
  return value
}

async function mapWithLimit(items, limit, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      output[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

async function mintTransactionResults() {
  const parsed = parseMintLogResults()
  const rows = await mapWithLimit(parsed.rows, 12, async (row) => ({
    ...row,
    receipt: row.txHash ? await transactionReceiptStats(row.txHash) : null,
  }))

  const statusCounts = {}
  const receiptCounts = {}
  let totalGasUsed = 0n
  let totalFeeWei = 0n
  let gasRows = 0

  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1
    if (row.receipt?.status) {
      receiptCounts[row.receipt.status] = (receiptCounts[row.receipt.status] || 0) + 1
    }
    if (row.receipt?.gasUsed && row.receipt?.feeWei) {
      totalGasUsed += BigInt(row.receipt.gasUsed)
      totalFeeWei += BigInt(row.receipt.feeWei)
      gasRows += 1
    }
  }

  const failedOrInspection = (statusCounts.failed || 0) + (statusCounts["needs-inspection"] || 0)
  return {
    source: parsed.sawResultsHeader ? "runner-log" : rows.length ? "runner-log-partial" : "none",
    explorer: CHAINS[4663].explorer,
    updatedAt: now(),
    run: {
      running: mintRun.running,
      mode: mintRun.mode,
      startedAt: mintRun.startedAt,
      exitedAt: mintRun.exitedAt,
      exitCode: mintRun.exitCode,
    },
    summary: {
      totalRows: rows.length,
      minted: statusCounts.minted || 0,
      alreadyMinted: statusCounts["already-minted"] || 0,
      dryRunReady: statusCounts["dry-run-ready"] || 0,
      failed: statusCounts.failed || 0,
      needsInspection: statusCounts["needs-inspection"] || 0,
      failedOrInspection,
      statusCounts,
      logSummary: parsed.logSummary,
      receiptCounts,
      receiptSuccess: receiptCounts.success || 0,
      receiptFailed: receiptCounts.failed || 0,
      receiptPending: receiptCounts.pending || 0,
      receiptErrors: receiptCounts.error || 0,
      gasRows,
      totalGasUsed: totalGasUsed.toString(),
      totalFeeWei: totalFeeWei.toString(),
      totalFeeEth: formatEther(totalFeeWei),
    },
    rows,
  }
}

async function testRobinhoodRpc({ samples = 5, timeoutMs = 5000 } = {}) {
  const boundedSamples = Math.max(1, Math.min(20, Number(samples) || 5))
  const boundedTimeout = Math.max(500, Math.min(30000, Number(timeoutMs) || 5000))
  const results = []
  for (let index = 0; index < boundedSamples; index += 1) {
    const started = performance.now()
    try {
      const response = await fetch(ROBINHOOD_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now() + index,
          method: "eth_blockNumber",
          params: [],
        }),
        signal: AbortSignal.timeout(boundedTimeout),
      })
      const elapsedMs = Math.round(performance.now() - started)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload.error) throw new Error(payload.error.message || "RPC error")
      if (!payload.result) throw new Error("Missing block number")
      results.push({
        ok: true,
        ms: elapsedMs,
        blockNumber: Number.parseInt(payload.result, 16),
      })
    } catch (error) {
      results.push({
        ok: false,
        ms: Math.round(performance.now() - started),
        error: error.message,
      })
    }
  }

  const latencies = results.filter((result) => result.ok).map((result) => result.ms).sort((a, b) => a - b)
  const percentile = (p) => {
    if (!latencies.length) return null
    return latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))]
  }
  return {
    ok: latencies.length > 0,
    rpcHost: hostnameFor(ROBINHOOD_RPC_URL),
    samples: boundedSamples,
    timeoutMs: boundedTimeout,
    successCount: latencies.length,
    failureCount: results.length - latencies.length,
    minMs: latencies[0] ?? null,
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    maxMs: latencies.at(-1) ?? null,
    latestBlock: results.findLast?.((result) => result.ok)?.blockNumber ?? [...results].reverse().find((result) => result.ok)?.blockNumber ?? null,
    results,
    testedAt: now(),
  }
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
        createdAt: info.createdAt || "",
        lastUsed: info.lastUsed || "",
        label: meta.label || "",
        group: meta.wallet_group || "",
        note: meta.note || "",
        favorite: Boolean(meta.favorite),
        risk: meta.risk || "",
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
  if (!wallet) throw httpError(404, `Unknown wallet profile: ${id}`)
  return { id, address: wallet.address }
}

function chainConfig(chainId) {
  const chain = CHAINS[Number(chainId)]
  if (!chain) throw httpError(400, `Unsupported chain: ${chainId}`)
  return chain
}

const clients = new Map()
const rpcPools = new Map()
const monitorClients = new Map()
function publicClient(chainId) {
  const chain = chainConfig(chainId)
  if (!clients.has(chain.id)) {
    const pool = createRpcPool({ urls: chain.rpcUrls })
    rpcPools.set(chain.id, pool)
    clients.set(chain.id, createPublicClient({
      chain: chain.viem,
      transport: custom({ request: pool.request }, { retryCount: 0 }),
    }))
  }
  return clients.get(chain.id)
}

function monitorPublicClient(chainId) {
  const chain = chainConfig(chainId)
  if (!monitorClients.has(chain.id)) {
    const pool = createRpcPool({ urls: chain.rpcUrls })
    monitorClients.set(chain.id, createPublicClient({
      chain: chain.viem,
      transport: custom({ request: pool.request }, { retryCount: 0 }),
    }))
  }
  return monitorClients.get(chain.id)
}

const nftMediaResolver = createNftMediaResolver()
const nftMinterStore = createNftMinterStore(db)
const mintMonitor = createMintMonitor({
  getClient: monitorPublicClient,
  getChain: chainConfig,
  mediaResolver: nftMediaResolver,
  minterStore: nftMinterStore,
})

function walletEnv(walletId) {
  const env = { ...process.env }
  delete env.AWP_SESSION_ID
  delete env.AWP_AGENT_ID
  if (walletId !== "default") env.AWP_AGENT_ID = walletId
  return env
}

function parseJsonLoose(text) {
  const trimmed = String(text || "").trim()
  if (!trimmed) return {}
  const direct = JSON.parse(trimmed)
  return direct
}

function runAwp(walletId, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("awp-wallet", args, {
      cwd: ROOT,
      env: walletEnv(walletId),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`awp-wallet timed out: ${args.join(" ")}`))
    }, timeoutMs)
    child.stdout.on("data", (data) => {
      stdout += data.toString()
    })
    child.stderr.on("data", (data) => {
      stderr += data.toString()
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `awp-wallet exited ${code}`))
        return
      }
      try {
        resolve(parseJsonLoose(stdout))
      } catch {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      }
    })
  })
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
  if (!Array.isArray(value)) throw httpError(400, "walletIds must be an array")
  return [...new Set(value.map(String))].filter(Boolean)
}

function assertAddress(value, label = "address") {
  const text = String(value || "")
  if (!/^0x[a-fA-F0-9]{40}$/.test(text)) throw httpError(400, `Invalid ${label}`)
  return text
}

function assertHex(value, label = "hex") {
  const text = String(value || "")
  if (!/^0x([a-fA-F0-9]{2})*$/.test(text)) throw httpError(400, `Invalid ${label}`)
  return text
}

async function tokenInfo(chainId, tokenAddress, provided = {}) {
  const client = publicClient(chainId)
  const address = assertAddress(tokenAddress, "token address")
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
  if (!/^\d+(\.\d+)?$/.test(text)) throw httpError(400, `Invalid amount: ${text}`)
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

async function sendRawTx({ walletId, chainId, to, valueWei = "0", data = "0x", nonce = null, gas = null }) {
  requireWallet(walletId)
  const chain = chainConfig(chainId)
  const args = [
    "--chain", String(chainId),
    "--rpc-url", chain.rpcUrl,
    "--native-symbol", chain.nativeSymbol,
    "send-tx",
    "--to", assertAddress(to, "to"),
    "--value", String(valueWei),
    "--data", assertHex(data, "calldata"),
    "--pretty",
  ]
  if (nonce !== null && nonce !== undefined && nonce !== "") args.push("--nonce", String(nonce))
  if (gas !== null && gas !== undefined && gas !== "") args.push("--gas", String(gas))
  return runAwp(walletId, args, { timeoutMs: 180000 })
}

async function preflightCall({ walletId, chainId, to, valueWei = "0", data = "0x" }) {
  const wallet = requireWallet(walletId)
  const client = publicClient(chainId)
  await client.call({
    account: wallet.address,
    to: assertAddress(to, "to"),
    value: BigInt(valueWei || "0"),
    data: assertHex(data, "calldata"),
  })
}

async function executeEntries({ type, chainId, entries, mode = "sequential", preflight = true }) {
  const id = createTask(type, { chainId, entries, mode, preflight })
  const results = []
  if (mode === "burst") {
    const groups = new Map()
    for (const entry of entries) {
      const group = groups.get(entry.walletId) || []
      group.push(entry)
      groups.set(entry.walletId, group)
    }
    for (const [walletId, group] of groups) {
      const wallet = requireWallet(walletId)
      const baseNonce = await publicClient(chainId).getTransactionCount({ address: wallet.address, blockTag: "pending" })
      group.forEach((entry, index) => {
        if (entry.nonce === undefined || entry.nonce === null || entry.nonce === "") entry.nonce = baseNonce + index
      })
    }
  }
  const runEntry = async (entry) => {
    const txRowId = logTx({
      taskId: id,
      walletId: entry.walletId,
      chainId,
      type,
      status: "running",
      summary: entry.summary || "",
      metadata: { to: entry.to, valueWei: entry.valueWei || "0" },
    })
    try {
      if (preflight) await preflightCall({ walletId: entry.walletId, chainId, to: entry.to, valueWei: entry.valueWei || "0", data: entry.data || "0x" })
      const sent = await sendRawTx({ walletId: entry.walletId, chainId, to: entry.to, valueWei: entry.valueWei || "0", data: entry.data || "0x", nonce: entry.nonce, gas: entry.gas })
      const txHash = String(sent.txHash || "")
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("Wallet signer returned no valid transaction hash")
      updateTx(txRowId, {
        status: "confirmation_pending",
        tx_hash: txHash,
        metadata_json: { ...entry, sent },
      })
      results.push({ ...entry, ok: true, status: "confirmation_pending", txHash, sent })
    } catch (error) {
      updateTx(txRowId, { status: "failed", error: error.message })
      results.push({ ...entry, ok: false, error: error.message })
      if (mode === "sequential") throw error
    }
  }

  try {
    if (mode === "burst") {
      await Promise.all(entries.map((entry) => runEntry(entry)))
    } else {
      for (const entry of entries) await runEntry(entry)
    }
    finishTask(id, results.some((result) => result.status === "confirmation_pending") ? "confirmation_pending" : "done", { results })
  } catch (error) {
    finishTask(id, results.some((result) => result.ok) ? "partial" : "failed", { results }, error.message)
  }

  const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(id)
  return {
    taskId: id,
    status: task.status,
    error: task.error,
    results,
  }
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
        error: confirmed ? "" : "Transaction reverted on-chain",
      })
      for (const job of nftMintJobs.values()) {
        const wallet = job.wallets.find((item) => String(item.txHash || "").toLowerCase() === row.tx_hash.toLowerCase())
        if (!wallet) continue
        wallet.status = confirmed ? "confirmed" : "failed"
        wallet.blockNumber = receipt.blockNumber?.toString() || ""
        wallet.reason = confirmed ? "" : "Transaction reverted on-chain"
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
    if (amountWei <= 0n) continue
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
      gas: asset === "native" ? "21000" : undefined,
      summary: `${fromId} -> ${target.id} ${weiToDecimal(amountWei, token?.decimals || 18)} ${token?.symbol || chain.nativeSymbol}`,
    })
  }
  return { chain, asset, token, entries }
}

async function buildManyToOnePlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const sourceIds = normalizeWalletIds(body.sourceIds)
  if (!sourceIds.length) throw httpError(400, "Select at least one source wallet")
  const destinationWalletId = String(body.destinationWalletId || "")
  if (!destinationWalletId) throw httpError(400, "Select a destination wallet")
  const destinationWallet = requireWallet(destinationWalletId)
  const destination = destinationWallet.address
  const reserveWei = parseEther(String(body.reserveEth || "0.00005"))
  const gasPrice = await publicClient(chain.id).getGasPrice()
  const gasWei = gasPrice * 21000n * BigInt(Math.ceil(Number(body.gasMultiplier || 1.25) * 100)) / 100n
  const entries = []

  for (const sourceId of sourceIds) {
    const source = requireWallet(sourceId)
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
      gas: "21000",
      summary: `${source.id} -> ${destination.slice(0, 6)}...${destination.slice(-4)} ${formatEther(spendable)} ${chain.nativeSymbol}`,
      gasReserveWei: gasWei.toString(),
      keepReserveWei: reserveWei.toString(),
    })
  }
  return { chain, entries, destination, destinationWalletId: destinationWallet.id, reserveWei: reserveWei.toString(), gasWei: gasWei.toString() }
}

async function buildManyToManyPlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const senderIds = normalizeWalletIds(body.senderIds)
  const receiverIds = normalizeWalletIds(body.receiverIds)
  if (!senderIds.length) throw httpError(400, "Select at least one sender wallet")
  if (!receiverIds.length) throw httpError(400, "Select at least one receiver wallet")
  if (senderIds.length !== receiverIds.length) throw httpError(400, "Sender and receiver counts must match for many-to-many")
  const entries = []
  const asset = body.asset || "native"
  let token = null
  if (asset === "erc20") token = await tokenInfo(chain.id, body.tokenAddress, body)

  for (let index = 0; index < senderIds.length; index += 1) {
    const source = requireWallet(senderIds[index])
    const receiver = requireWallet(receiverIds[index])
    if (source.id === receiver.id) throw httpError(400, `Row ${index + 1} sender and receiver are the same wallet`)
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
  if (!walletIds.length) throw httpError(400, "Select at least one wallet")
  walletIds.forEach(requireWallet)
  const token = await tokenInfo(chain.id, body.tokenAddress, body)
  const spender = assertAddress(body.spender, "spender")
  const amountWei = body.revoke ? 0n : amountToWei(body.amount || "0", token.decimals)
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amountWei] })
  const entries = walletIds.map((walletId) => ({
    walletId,
    to: token.address,
    valueWei: "0",
    data,
    summary: `${walletId} ${body.revoke ? "revoke" : "approve"} ${token.symbol} -> ${spender.slice(0, 6)}...${spender.slice(-4)}`,
  }))
  return { chain, token, spender, revoke: Boolean(body.revoke), entries }
}

function buildContractCallPlan(body) {
  const chain = chainConfig(body.chainId || 1)
  const walletIds = normalizeWalletIds(body.walletIds)
  if (!walletIds.length) throw httpError(400, "Select at least one wallet")
  walletIds.forEach(requireWallet)
  const to = assertAddress(body.to, "contract")
  const data = assertHex(body.data || "0x", "calldata")
  const valueWei = String(body.valueWei || "0")
  if (!/^\d+$/.test(valueWei)) throw httpError(400, "valueWei must be a non-negative integer")
  const entries = walletIds.map((walletId) => ({
    walletId,
    to,
    valueWei,
    data,
    summary: `${walletId} call ${to.slice(0, 6)}...${to.slice(-4)}`,
  }))
  return { chain, to, valueWei, entries }
}

function taskPreview(type, plan, body, mode = body.executionMode || "sequential") {
  const execution = {
    type,
    chainId: plan.chain.id,
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
  const walletIds = normalizeWalletIds(body.walletIds)
  if (!walletIds.length) throw httpError(400, "Select at least one wallet")
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
    nativeSymbol: chain.nativeSymbol,
    contractAddress: input.contractAddress,
    quantity: input.quantity.toString(),
    tokenId: input.tokenId,
    concurrency: input.concurrency,
    maxMintCostEth: input.maxMintCostEth,
    maxMintCostWei: input.maxMintCostWei,
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
  const results = await mapMintConcurrent(readyPlans, job.concurrency, async (plan) => {
    const walletRow = job.wallets.find((wallet) => wallet.walletId === plan.wallet.id)
    const txRowId = logTx({
      taskId: job.id,
      walletId: plan.wallet.id,
      chainId: job.chainId,
      type: "nft_mint",
      status: "running",
      summary: `${plan.wallet.id} mint ${job.quantity} from ${shortForSummary(job.contractAddress)}`,
      metadata: {
        contractAddress: job.contractAddress,
        quantity: job.quantity,
        tokenId: job.tokenId,
        mintTarget: plan.transaction.to,
        valueWei: plan.transaction.value.toString(),
      },
    })

    try {
      if (walletRow) walletRow.status = "pending"
      touchNftMintJob(job)

      const quote = await requoteSeaDropPlan({ client, plan })
      if (quote.changed && quote.newValue > quote.oldValue) {
        throw new Error(`Mint price increased from ${formatEther(quote.oldValue)} to ${formatEther(quote.newValue)} ${job.nativeSymbol}. Preview again.`)
      }
      if (quote.changed) {
        plan.transaction.value = quote.newValue
        plan.estimatedTotal = quote.newValue + plan.estimatedFee
      }
      if (job.maxMintCostWei !== null && plan.transaction.value > job.maxMintCostWei) {
        throw new Error("Current mint value exceeds the configured cap")
      }

      const currentBalance = await client.getBalance({ address: plan.wallet.address })
      if (currentBalance < plan.estimatedTotal) {
        throw new Error(`Balance changed: ${formatEther(currentBalance)} available, about ${formatEther(plan.estimatedTotal)} required`)
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
        to: plan.transaction.to,
        valueWei: plan.transaction.value.toString(),
        data: plan.transaction.data,
        gas: plan.gasLimit.toString(),
      })
      const txHash = String(sent.txHash || "")
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("Wallet signer returned no valid transaction hash")

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
          if (!confirmed) walletRow.reason = "Transaction reverted on-chain"
        }
        updateTx(txRowId, {
          status: confirmed ? "confirmed" : "failed",
          error: confirmed ? "" : "Transaction reverted on-chain",
        })
      } catch (receiptError) {
        if (walletRow) {
          walletRow.status = "confirmation_pending"
          walletRow.reason = `Broadcast accepted; confirmation pending: ${receiptError.message}`
        }
        updateTx(txRowId, { status: "confirmation_pending", error: `Confirmation pending: ${receiptError.message}` })
      }
      touchNftMintJob(job)
      return { walletId: plan.wallet.id, ok: walletRow?.status !== "failed", pending: walletRow?.status === "confirmation_pending", txHash }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (walletRow) Object.assign(walletRow, { status: "failed", reason: message })
      updateTx(txRowId, { status: "failed", error: message })
      touchNftMintJob(job)
      return { walletId: plan.wallet.id, ok: false, error: message }
    }
  })

  const sentCount = results.filter((result) => result.ok).length
  const failedCount = results.length - sentCount
  const pendingCount = results.filter((result) => result.pending).length
  job.status = pendingCount ? "confirmation_pending" : failedCount ? (sentCount ? "partial" : "failed") : "completed"
  touchNftMintJob(job)
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, walletCount: listWallets().length })
})

app.get("/api/chains", (_req, res) => {
  res.json({ chains: Object.values(CHAINS).map(({ id, key, name, nativeSymbol, explorer }) => ({ id, key, name, nativeSymbol, explorer })) })
})

app.get("/api/mint-monitor/overview", async (req, res, next) => {
  try {
    const chain = chainConfig(req.query.chainId || 1)
    const windowSeconds = Number(req.query.window || 1800)
    res.json({ ok: true, ...(await mintMonitor.overview(chain.id, windowSeconds)) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/collection/:address", async (req, res, next) => {
  try {
    const chain = chainConfig(req.query.chainId || 1)
    const address = assertAddress(req.params.address, "collection address")
    const detail = await mintMonitor.collection(chain.id, address)
    if (!detail) throw httpError(404, "Collection has no mint activity in the local scan window")
    res.json({ ok: true, collection: detail })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/status", (req, res, next) => {
  try {
    const chain = chainConfig(req.query.chainId || 1)
    res.json({ ok: true, status: mintMonitor.status(chain.id) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-monitor/stream", (req, res, next) => {
  try {
    const chain = chainConfig(req.query.chainId || 1)
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders?.()
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
    send({ type: "monitor_status", chainId: chain.id, ...mintMonitor.status(chain.id) })
    const unsubscribe = mintMonitor.subscribe(chain.id, send)
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
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) throw httpError(404, "NFT media was not found")
    const payload = await nftMediaResolver.loadMedia(req.params.id)
    if (!payload) throw httpError(404, "NFT media was not found")
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
  const rows = await Promise.all(Object.values(CHAINS).map(async (chain) => {
    const started = performance.now()
    try {
      const blockNumber = await publicClient(chain.id).getBlockNumber()
      return {
        chainId: chain.id,
        chainName: chain.name,
        ok: true,
        blockNumber: blockNumber.toString(),
        latencyMs: Math.round(performance.now() - started),
        upstreams: (rpcPools.get(chain.id)?.status() || chain.rpcUrls.map((url) => ({ host: hostnameFor(url), state: "unprobed" }))),
      }
    } catch (error) {
      return {
        chainId: chain.id,
        chainName: chain.name,
        ok: false,
        error: error.message,
        latencyMs: Math.round(performance.now() - started),
        upstreams: (rpcPools.get(chain.id)?.status() || chain.rpcUrls.map((url) => ({ host: hostnameFor(url), state: "unprobed" }))),
      }
    }
  }))
  res.status(rows.some((row) => row.ok) ? 200 : 503).json({ ok: rows.every((row) => row.ok), chains: rows })
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
    if (!job) throw httpError(404, "Mint preview was not found or has expired")
    if (job.status !== "previewed") throw httpError(409, `Mint job is ${job.status}`)
    if (job.expiresAtMs <= Date.now()) {
      nftMintJobs.delete(job.id)
      throw httpError(410, "Mint preview expired. Preview again before sending")
    }
    if (!mintConfirmationMatches(job.confirmationToken, req.body.confirmationToken)) {
      throw httpError(403, "Mint confirmation is missing or invalid")
    }
    if (!job.preview.readyPlans.length) throw httpError(409, "No wallet passed preflight")

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
    if (!job) throw httpError(404, "Mint job was not found or has expired")
    res.json({ ok: true, job: publicNftMintJob(job) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/mint-script/status", (_req, res) => {
  res.json({ ok: true, status: mintStatus() })
})

app.get("/api/mint-script/results", async (_req, res, next) => {
  try {
    res.json({ ok: true, results: await mintTransactionResults() })
  } catch (error) {
    next(error)
  }
})

app.post("/api/mint-script/preview", (req, res, next) => {
  try {
    const mode = String(req.body.mode || "dry-run")
    if (!['dry-run', 'armed'].includes(mode)) throw httpError(400, "Invalid runner mode")
    res.json({ ok: true, mode, confirmation: taskConfirmations.create("mint_script_armed", { mode }) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/mint-script/start", (req, res, next) => {
  try {
    const mode = String(req.body.mode || "dry-run")
    if (mode === "armed") {
      const preview = taskConfirmations.consume("mint_script_armed", req.body.previewId, req.body.confirmationToken)
      if (preview.mode !== "armed") throw httpError(409, "Armed runner preview does not match")
    }
    res.json({ ok: true, status: startMintRunner(mode) })
  } catch (error) {
    next(error)
  }
})

app.post("/api/mint-script/stop", (_req, res, next) => {
  try {
    if (!mintChild) {
      res.json({ ok: true, status: mintStatus() })
      return
    }
    appendMintLog("system", "SIGINT requested")
    mintChild.kill("SIGINT")
    res.json({ ok: true, status: mintStatus() })
  } catch (error) {
    next(error)
  }
})

app.post("/api/mint-script/rpc-latency", async (req, res, next) => {
  try {
    res.json({ ok: true, rpc: await testRobinhoodRpc(req.body || {}) })
  } catch (error) {
    next(error)
  }
})

app.get("/api/wallets", (_req, res) => {
  res.json({ wallets: listWallets() })
})

app.patch("/api/wallets/:id", (req, res) => {
  requireWallet(req.params.id)
  const label = String(req.body.label || "")
  const group = String(req.body.group || "")
  const note = String(req.body.note || "")
  const risk = String(req.body.risk || "")
  const favorite = req.body.favorite ? 1 : 0
  db.prepare(`
    INSERT INTO wallet_meta (wallet_id, label, wallet_group, note, favorite, risk, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_id) DO UPDATE SET
      label = excluded.label,
      wallet_group = excluded.wallet_group,
      note = excluded.note,
      favorite = excluded.favorite,
      risk = excluded.risk,
      updated_at = excluded.updated_at
  `).run(req.params.id, label, group, note, favorite, risk, now())
  res.json({ ok: true, wallet: listWallets().find((wallet) => wallet.id === req.params.id) })
})

app.post("/api/wallets/create", async (req, res, next) => {
  try {
    ensureWalletRoot()
    const count = Math.max(1, Math.min(500, Number(req.body.count || 1)))
    const prefix = String(req.body.prefix || "wallet").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "wallet"
    const start = Number(req.body.start || 1)
    const created = []
    const skipped = []
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${String(start + i).padStart(3, "0")}`
      const registry = readRegistry()
      if (registry[id]) {
        skipped.push({ id, address: registry[id].address })
        continue
      }
      const result = await runAwp(id, ["init"])
      created.push({ id, address: result.address })
    }
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
    res.json({ ok: true, ...plan, confirmation: taskPreview("many_to_one", plan, req.body, "sequential") })
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
      entries: plan.entries,
      mode: req.body.executionMode || "sequential",
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
  res.status(404).json({ ok: false, error: "API route not found" })
})

if (existsSync(DIST_ROOT)) {
  app.use(express.static(DIST_ROOT))
  app.get(/.*/, (_req, res) => {
    res.sendFile(join(DIST_ROOT, "index.html"))
  })
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500
  res.status(status).json({ ok: false, error: err.message || "Internal server error" })
})

const httpServers = API_HOSTS.map((host) => app.listen(PORT, host, () => {
  console.log(`Wallet board listening on http://${host}:${PORT}`)
}))

function shutdown() {
  clearInterval(receiptReconcileTimer)
  mintMonitor.stop()
  Promise.all(httpServers.map((server) => new Promise((resolve) => server.close(resolve))))
    .then(() => process.exit(0))
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
