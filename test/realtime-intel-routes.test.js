import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { after, before, describe, test } from "node:test"
import { encodeAbiParameters } from "viem"
import { createSeaDropRadar } from "../server/seadrop-radar.js"

const CONTRACT = "0x1111111111111111111111111111111111111111"
const WALLET = "0x2222222222222222222222222222222222222222"
const DEFAULT_SEADROP_ADDRESS = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
const ZERO_HASH = `0x${"00".repeat(32)}`
const ZERO_BLOOM = `0x${"00".repeat(256)}`
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const FIXTURE_PROJECT_NAME = "Fixture Radar Collection"
const FIXTURE_PROJECT_IMAGE = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`
const FIXTURE_COLLECTION_URI = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: FIXTURE_PROJECT_NAME, image: FIXTURE_PROJECT_IMAGE })).toString("base64")}`

function blockFixture(tag = "0x64") {
  return {
    number: tag === "latest" ? "0x64" : tag,
    hash: ZERO_HASH,
    parentHash: ZERO_HASH,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO_HASH,
    logsBloom: ZERO_BLOOM,
    transactionsRoot: ZERO_HASH,
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: "0x65d00000",
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x3b9aca00",
    mixHash: ZERO_HASH,
  }
}

function rpcResult(method, params) {
  if (method === "eth_chainId") return "0x1"
  if (method === "net_version") return "1"
  if (method === "eth_blockNumber") return "0x64"
  if (method === "eth_getLogs" || method === "eth_getBlockReceipts") return []
  if (method === "eth_getBlockByNumber") return blockFixture(params?.[0])
  if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return "0x3b9aca00"
  if (method === "eth_feeHistory") {
    return { oldestBlock: "0x63", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0], reward: [["0x3b9aca00"]] }
  }
  if (method === "eth_getBalance" || method === "eth_getTransactionCount") return "0x0"
  if (method === "eth_getCode") return "0x"
  if (method === "eth_call") {
    const selector = String(params?.[0]?.data || "").slice(0, 10).toLowerCase()
    if (selector === "0x06fdde03") return encodeAbiParameters([{ type: "string" }], [FIXTURE_PROJECT_NAME])
    if (selector === "0x95d89b41") return encodeAbiParameters([{ type: "string" }], ["FRC"])
    if (selector === "0xe8a3d485") return encodeAbiParameters([{ type: "string" }], [FIXTURE_COLLECTION_URI])
    if (selector === "0x01ffc9a7") return encodeAbiParameters([{ type: "bool" }], [true])
    if (selector === "0x18160ddd") return encodeAbiParameters([{ type: "uint256" }], [0n])
    return "0x"
  }
  if (method === "eth_estimateGas") return "0x5208"
  if (method === "eth_getStorageAt") return `0x${"00".repeat(32)}`
  if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") return null
  return null
}

async function listen(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server.address().port
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: options.body
      ? { "content-type": "application/json", ...options.headers }
      : options.headers,
  })
  const body = await response.json()
  return { status: response.status, body }
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`server did not become ready\n${logs()}`)
}

describe("realtime intelligence HTTP routes", { concurrency: false }, () => {
  let fixture
  let fixturePort
  let appPort
  let appBase
  let child
  let tempRoot
  let dbPath
  let stdout = ""
  let stderr = ""
  let seaDropScanStarted
  let signalSeaDropScanStarted
  let seaDropLogsReleased
  let releaseSeaDropLogs
  const upstreamRequests = []

  before(async () => {
    seaDropScanStarted = new Promise((resolve) => { signalSeaDropScanStarted = resolve })
    seaDropLogsReleased = new Promise((resolve) => { releaseSeaDropLogs = resolve })
    fixture = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)
      upstreamRequests.push({ method: req.method, path: url.pathname, host: req.headers.host })
      if (req.method === "POST" && url.pathname === "/rpc") {
        let source = ""
        for await (const chunk of req) source += chunk
        const request = JSON.parse(source)
        const filterAddress = request.method === "eth_getLogs" ? request.params?.[0]?.address : ""
        const filterAddresses = Array.isArray(filterAddress) ? filterAddress : [filterAddress]
        if (filterAddresses.some((address) => String(address).toLowerCase() === DEFAULT_SEADROP_ADDRESS)) {
          signalSeaDropScanStarted()
          await seaDropLogsReleased
        }
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: rpcResult(request.method, request.params) }))
        return
      }
      if (req.method === "GET" && url.pathname === "/provider/api/overview/all") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ updatedAt: "2026-08-17T00:00:00.000Z", windows: { 60: [], 1800: [] } }))
        return
      }
      res.statusCode = 404
      res.end("not found")
    })
    fixture.on("upgrade", (req, socket) => {
      upstreamRequests.push({ method: "UPGRADE", path: req.url, host: req.headers.host })
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
    })
    fixturePort = await listen(fixture)
    appPort = await freePort()
    appBase = `http://127.0.0.1:${appPort}`
    tempRoot = await mkdtemp(join(tmpdir(), "611nft-realtime-routes-"))
    dbPath = join(tempRoot, "routes.sqlite")
    const fixtureBase = `http://127.0.0.1:${fixturePort}`
    const networkGuardPath = join(tempRoot, "network-guard.mjs")
    await writeFile(networkGuardPath, `
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const value = typeof input === "string" || input instanceof URL ? String(input) : input.url
  const url = new URL(value)
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    console.error("[test-network-guard] blocked non-loopback fetch")
    return Promise.reject(new Error("test network guard blocked a non-loopback fetch"))
  }
  return originalFetch(input, init)
}
`, "utf8")
    child = spawn(process.execPath, [
      "--experimental-sqlite",
      "--import",
      pathToFileURL(networkGuardPath).href,
      join(ROOT, "server/index.js"),
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        WALLET_BOARD_PORT: String(appPort),
        WALLET_BOARD_API_HOST: "127.0.0.1",
        WALLET_BOARD_API_HOSTS: "",
        WALLET_BOARD_API_TOKEN: "",
        WALLET_BOARD_DB_PATH: dbPath,
        WALLET_BOARD_WALLET_ROOT: join(tempRoot, "wallets"),
        WALLET_KEYS_FILE: join(tempRoot, "wallet-keys.env"),
        NFT_MEDIA_CACHE_DIR: join(tempRoot, "media"),
        ETH_RPC_URL: `${fixtureBase}/rpc`,
        ETH_RPC_URLS: `${fixtureBase}/rpc`,
        WSS_RPC_URL_ETHEREUM: `ws://127.0.0.1:${fixturePort}/wss`,
        WSS_RPC_URLS_ETHEREUM: "",
        MINT_MONITOR_API_BASE: `${fixtureBase}/provider`,
        MINT_MONITOR_POLL_MS: "60000",
        MINT_MONITOR_INITIAL_BLOCKS: "1",
        MINT_MONITOR_MAX_BLOCKS_PER_SCAN: "1",
        MINT_MONITOR_INITIAL_RESPONSE_WAIT_MS: "1000",
        MINT_MONITOR_PROVIDER_RESPONSE_WAIT_MS: "1000",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    await waitForServer(appBase, child, () => `${stdout}\n${stderr}`)
  })

  after(async () => {
    releaseSeaDropLogs?.()
    if (child?.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      let shutdownTimer
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            shutdownTimer = setTimeout(() => reject(new Error(`server shutdown timed out\n${stdout}\n${stderr}`)), 5000)
            shutdownTimer.unref?.()
          }),
        ])
      } finally {
        clearTimeout(shutdownTimer)
      }
    }
    if (fixture?.listening) await new Promise((resolve) => fixture.close(resolve))
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  test("bootstrap and trending expose empty fixture snapshots and reject invalid queries", async () => {
    const seedDb = new DatabaseSync(dbPath)
    seedDb.exec("PRAGMA busy_timeout = 5000")
    const seedRadar = createSeaDropRadar({ db: seedDb })
    seedRadar.ingest(1, [{
      address: DEFAULT_SEADROP_ADDRESS,
      eventName: "AllowListUpdated",
      args: { nftContract: CONTRACT, newMerkleRoot: `0x${"11".repeat(32)}`, allowListURI: "" },
      transactionHash: `0x${"22".repeat(32)}`,
      blockNumber: 99n,
      logIndex: 1,
    }])
    const bootstrapRequest = jsonRequest(appBase, "/api/bootstrap?chainId=1&window=60")
    await Promise.race([
      seaDropScanStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("SeaDrop scan did not start")), 5000)),
    ])
    let bootstrap
    try {
      const metadataDeadline = Date.now() + 3000
      let seededDrop
      while (Date.now() < metadataDeadline) {
        seededDrop = seedDb.prepare("SELECT name, image FROM seadrop_drops WHERE chain_id = 1 AND contract = ?").get(CONTRACT)
        if (seededDrop?.name && seededDrop?.image) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(seededDrop?.name, FIXTURE_PROJECT_NAME)
      assert.match(seededDrop?.image || "", /^\/api\/mint-monitor\/media\//)
      seedDb.prepare("DELETE FROM seadrop_drops WHERE chain_id = 1 AND contract = ?").run(CONTRACT)
      seedDb.prepare("DELETE FROM seadrop_drop_logs WHERE chain_id = 1 AND contract = ?").run(CONTRACT)
      bootstrap = await Promise.race([
        bootstrapRequest,
        new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap waited for SeaDrop scan")), 4000)),
      ])
    } finally {
      seedDb.close()
      releaseSeaDropLogs()
    }
    assert.equal(bootstrap.status, 200)
    assert.equal(bootstrap.body.ok, true)
    assert.equal(bootstrap.body.chainId, 1)
    assert.equal(bootstrap.body.overview.source, "provider")
    assert.deepEqual(bootstrap.body.overview.windows["60"], [])
    assert.deepEqual(bootstrap.body.trending.collections, [])
    assert.deepEqual(bootstrap.body.radar.drops, [])
    assert.deepEqual(bootstrap.body.flags, [])
    assert.equal(typeof bootstrap.body.status.realtime, "object")
    assert.equal(typeof bootstrap.body.status.wss, "object")
    assert.equal(bootstrap.body.status.walletActivity.state, "idle")

    const trending = await jsonRequest(appBase, "/api/mint-monitor/trending?chainId=1&window=300&limit=5")
    assert.equal(trending.status, 200)
    assert.equal(trending.body.type, "trending_snapshot")
    assert.equal(trending.body.window, 300)
    assert.deepEqual(trending.body.collections, [])

    for (const path of [
      "/api/bootstrap?chainId=999999&window=60",
      "/api/bootstrap?chainId=1&window=42",
      "/api/mint-monitor/trending?chainId=1&window=42",
      "/api/mint-monitor/trending?chainId=1&window=60&limit=0",
      "/api/mint-monitor/trending?chainId=999999&window=60",
    ]) {
      const response = await jsonRequest(appBase, path)
      assert.equal(response.status, 400, path)
      assert.equal(response.body.ok, false, path)
    }
  })

  test("collection flags persist, update, filter and validate through HTTP", async () => {
    const empty = await jsonRequest(appBase, "/api/collections/flags?chainId=1")
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.flags, [])

    const created = await jsonRequest(appBase, `/api/collections/${CONTRACT}/flag`, {
      method: "POST",
      body: JSON.stringify({ chainId: 1, flag: "scam", note: "fixture risk" }),
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.flag.flag, "scam")
    assert.equal(created.body.flag.note, "fixture risk")

    const updated = await jsonRequest(appBase, `/api/collections/${CONTRACT}/flag`, {
      method: "POST",
      body: JSON.stringify({ chainId: 1, flag: "watch", note: "reviewed" }),
    })
    assert.equal(updated.status, 201)
    assert.equal(updated.body.flag.flag, "watch")

    const filtered = await jsonRequest(appBase, "/api/collections/flags?chainId=1&flag=watch")
    assert.equal(filtered.status, 200)
    assert.equal(filtered.body.flags.length, 1)
    assert.equal(filtered.body.flags[0].address, CONTRACT)

    for (const [path, options] of [
      ["/api/collections/not-an-address/flag", { method: "POST", body: JSON.stringify({ chainId: 1, flag: "scam" }) }],
      [`/api/collections/${CONTRACT}/flag`, { method: "POST", body: JSON.stringify({ chainId: 1, flag: "unknown" }) }],
      [`/api/collections/${CONTRACT}/flag`, { method: "POST", body: JSON.stringify({ chainId: 1, flag: "scam", note: "x".repeat(501) }) }],
      ["/api/collections/flags?chainId=1&flag=unknown", {}],
    ]) {
      const response = await jsonRequest(appBase, path, options)
      assert.equal(response.status, 400, path)
    }

    const removed = await jsonRequest(appBase, `/api/collections/${CONTRACT}/flag?chainId=1`, { method: "DELETE" })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.ok, true)
    const missing = await jsonRequest(appBase, `/api/collections/${CONTRACT}/flag?chainId=1`, { method: "DELETE" })
    assert.equal(missing.status, 404)
  })

  test("SeaDrop radar scans only the fixture and supports documented filters", async () => {
    const radar = await jsonRequest(appBase, "/api/seadrop-radar?chainId=1")
    assert.equal(radar.status, 200)
    assert.equal(radar.body.ok, true)
    assert.equal(radar.body.chainId, 1)
    assert.equal(radar.body.scanError, "")
    assert.deepEqual(radar.body.drops, [])

    const filtered = await jsonRequest(appBase, "/api/seadrop-radar?chainId=1&price=free&live=true&publicOnly=true&includeUnscheduled=true")
    assert.equal(filtered.status, 200)
    assert.deepEqual(filtered.body.drops, [])

    for (const path of [
      "/api/seadrop-radar?chainId=999999",
      "/api/seadrop-radar?chainId=1&price=unknown",
    ]) {
      const invalid = await jsonRequest(appBase, path)
      assert.equal(invalid.status, 400, path)
      assert.equal(invalid.body.ok, false, path)
    }
  })

  test("alert CRUD validates rules and test delivery keeps Telegram secrets disabled", async () => {
    const empty = await jsonRequest(appBase, "/api/alerts?chainId=1")
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.rules, [])
    assert.deepEqual(empty.body.notifier, { enabled: false, pending: 0, sent: 0, failed: 0, lastError: "" })
    assert.equal("token" in empty.body.notifier, false)
    assert.equal("chatId" in empty.body.notifier, false)

    const created = await jsonRequest(appBase, "/api/alerts", {
      method: "POST",
      body: JSON.stringify({ type: "trending", chainId: 1, name: "fixture threshold", params: { window: 60, threshold: 3 } }),
    })
    assert.equal(created.status, 201)
    const id = created.body.rule.id
    assert.deepEqual(created.body.rule.params, { window: 60, threshold: 3 })

    const updated = await jsonRequest(appBase, `/api/alerts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false, params: { window: 300, threshold: 5 } }),
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.rule.enabled, false)
    assert.deepEqual(updated.body.rule.params, { window: 300, threshold: 5 })

    const invalidChainPatch = await jsonRequest(appBase, `/api/alerts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ chainId: 999999 }),
    })
    assert.equal(invalidChainPatch.status, 400)

    const listed = await jsonRequest(appBase, "/api/alerts?chainId=1")
    assert.equal(listed.body.rules.length, 1)
    assert.equal(listed.body.rules[0].id, id)

    for (const body of [
      { type: "unknown", chainId: 1, params: {} },
      { type: "trending", chainId: 1, params: { window: 42, threshold: 1 } },
      { type: "contract_mint", chainId: 1, params: { address: "0x123" } },
      { type: "wallet_activity", chainId: 999999, params: { address: WALLET } },
    ]) {
      const invalid = await jsonRequest(appBase, "/api/alerts", { method: "POST", body: JSON.stringify(body) })
      assert.equal(invalid.status, 400, JSON.stringify(body))
    }

    const defaultTest = await jsonRequest(appBase, "/api/alerts/test", {
      method: "POST",
      body: JSON.stringify({ chainId: 1 }),
    })
    assert.equal(defaultTest.status, 200)
    assert.equal(defaultTest.body.alert.title, "611nft 测试报警")
    assert.equal(defaultTest.body.notification.skipped, true)

    const truncated = await jsonRequest(appBase, "/api/alerts/test", {
      method: "POST",
      body: JSON.stringify({ chainId: 1, title: "t".repeat(150), message: "m".repeat(550) }),
    })
    assert.equal(truncated.body.alert.title.length, 120)
    assert.equal(truncated.body.alert.message.length, 500)
    assert.equal(truncated.body.notification.skipped, true)

    const removed = await jsonRequest(appBase, `/api/alerts/${id}`, { method: "DELETE" })
    assert.equal(removed.status, 200)
    const missingPatch = await jsonRequest(appBase, `/api/alerts/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })
    assert.equal(missingPatch.status, 404)
    const missingDelete = await jsonRequest(appBase, `/api/alerts/${id}`, { method: "DELETE" })
    assert.equal(missingDelete.status, 404)
  })

  test("all upstream traffic remains on the local RPC/provider fixture", () => {
    assert.ok(upstreamRequests.some((request) => request.path === "/rpc"))
    assert.ok(upstreamRequests.some((request) => request.path === "/provider/api/overview/all"))
    assert.ok(upstreamRequests.every((request) => request.host === `127.0.0.1:${fixturePort}`))
    assert.ok(upstreamRequests.every((request) => ["/rpc", "/provider/api/overview/all", "/wss"].includes(request.path)))
    assert.match(stderr, /\[test-network-guard\] blocked non-loopback fetch/)
    assert.doesNotMatch(`${stdout}\n${stderr}`, /api\.telegram\.org/)
  })
})
