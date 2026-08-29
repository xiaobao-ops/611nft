import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test, { after, before, describe } from "node:test"
import { fileURLToPath } from "node:url"
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from "viem"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONTRACT = "0x00000000000000000000000000000000000000A1"
const TOKEN_COUNT = 24
const METADATA_BUDGET_MS = 2000

const SELECTORS = {
  supportsInterface: toFunctionSelector("supportsInterface(bytes4)"),
  balanceOf: toFunctionSelector("balanceOf(address)"),
  tokenOfOwnerByIndex: toFunctionSelector("tokenOfOwnerByIndex(address,uint256)"),
  symbol: toFunctionSelector("symbol()"),
  tokenURI: toFunctionSelector("tokenURI(uint256)"),
}
const ERC721_INTERFACE = "80ac58cd"

const encodeBool = (value) => encodeAbiParameters(parseAbiParameters("bool"), [value])
const encodeUint = (value) => encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(value)])
const encodeString = (value) => encodeAbiParameters(parseAbiParameters("string"), [value])

async function listen(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server.address().port
}

async function unusedPort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

// Answers every read the ERC721 holdings query needs, then goes silent on tokenURI —
// the exact shape of a metadata host or archive node that accepts and never replies.
function rpcFixture(state) {
  return createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw || "{}")
    const answer = (id, result) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
    }
    if (request.method !== "eth_call") {
      const results = {
        eth_blockNumber: "0x1",
        eth_chainId: "0x1",
        eth_getLogs: [],
        eth_gasPrice: "0x1",
        eth_getCode: "0x60",
        eth_maxPriorityFeePerGas: "0x1",
      }
      answer(request.id, results[request.method] ?? null)
      return
    }
    const data = String(request.params?.[0]?.data || "")
    const selector = data.slice(0, 10)
    if (selector === SELECTORS.supportsInterface) {
      answer(request.id, encodeBool(data.slice(10, 18) === ERC721_INTERFACE))
      return
    }
    if (selector === SELECTORS.balanceOf) return answer(request.id, encodeUint(TOKEN_COUNT))
    if (selector === SELECTORS.tokenOfOwnerByIndex) {
      const index = BigInt(`0x${data.slice(74, 138)}`)
      return answer(request.id, encodeUint(index + 1n))
    }
    if (selector === SELECTORS.symbol) return answer(request.id, encodeString("TST"))
    if (selector === SELECTORS.tokenURI) {
      // Never answered on purpose. Hold the socket exactly like a dead metadata host.
      state.hangingTokenUriCalls += 1
      req.socket.setTimeout(0)
      return
    }
    answer(request.id, null)
  })
}

async function waitForServer(url, child, logs) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${logs()}`)
    try {
      const response = await fetch(`${url}/api/chains`)
      if (response.ok) return
    } catch {
      // The child is still binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`server did not become ready\n${logs()}`)
}

describe("NFT holdings stay bounded when metadata stalls", { timeout: 120_000 }, () => {
  const state = { hangingTokenUriCalls: 0 }
  let child
  let fixture
  let tempRoot
  let appBase
  let stdout = ""
  let stderr = ""

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "nft-holding-metadata-"))
    fixture = rpcFixture(state)
    const fixturePort = await listen(fixture)
    const rpcUrl = `http://127.0.0.1:${fixturePort}`
    const idlePort = await unusedPort()
    appBase = `http://127.0.0.1:${idlePort}`

    child = spawn(process.execPath, ["--experimental-sqlite", join(ROOT, "server/index.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        WALLET_BOARD_PORT: String(idlePort),
        WALLET_BOARD_API_HOST: "127.0.0.1",
        WALLET_BOARD_API_HOSTS: "",
        WALLET_BOARD_API_TOKEN: "",
        WALLET_BOARD_DB_PATH: join(tempRoot, "test.sqlite"),
        WALLET_BOARD_WALLET_ROOT: join(tempRoot, "wallets"),
        WALLET_KEYS_FILE: join(tempRoot, "wallet-keys.env"),
        NFT_MEDIA_CACHE_DIR: join(tempRoot, "media"),
        NFT_HOLDING_METADATA_BUDGET_MS: String(METADATA_BUDGET_MS),
        ETH_RPC_URL: rpcUrl,
        ETH_RPC_URLS: rpcUrl,
        WSS_RPC_URL_ETHEREUM: "ws://127.0.0.1:1",
        WSS_RPC_URLS_ETHEREUM: "",
        MINT_MONITOR_API_BASE: `${rpcUrl}/provider`,
        MINT_MONITOR_ENABLE_INTEL: "false",
        MINT_MONITOR_POLL_MS: "60000",
        MINT_MONITOR_INITIAL_BLOCKS: "1",
        MINT_MONITOR_MAX_BLOCKS_PER_SCAN: "1",
        MINT_MONITOR_HEARTBEAT_MS: "0",
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
    if (child?.exitCode === null) {
      child.kill("SIGTERM")
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000).unref?.())])
      if (child.exitCode === null) child.kill("SIGKILL")
    }
    if (fixture?.listening) await new Promise((resolve) => fixture.close(resolve))
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  test("holdings return within the metadata budget and report what degraded", async () => {
    const created = await fetch(`${appBase}/api/wallets/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 1, prefix: "holder", start: 1 }),
    }).then((response) => response.json())
    assert.equal(created.ok, true, JSON.stringify(created))
    const walletId = (created.created?.[0]?.id) || created.created?.[0]
    assert.ok(walletId, `wallet id missing: ${JSON.stringify(created)}`)

    const started = Date.now()
    const payload = await fetch(`${appBase}/api/token-holdings/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: 1, walletIds: [walletId], contractAddress: CONTRACT, includeMetadata: true }),
    }).then((response) => response.json())
    const elapsed = Date.now() - started

    assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 400))
    // The holdings themselves are complete: stalled metadata never costs us rows.
    assert.equal(payload.holdings.standard, "ERC721")
    assert.equal(payload.holdings.rows.length, TOKEN_COUNT)
    assert.deepEqual(payload.holdings.rows.map((row) => row.tokenId).slice(0, 3), ["1", "2", "3"])
    // Metadata degraded rather than holding the response open.
    assert.equal(payload.holdings.metadataPending, TOKEN_COUNT)
    assert.ok(payload.holdings.rows.every((row) => row.metadata === null), "stalled rows carry no metadata")
    assert.ok(state.hangingTokenUriCalls > 0, "the fixture must actually have stalled tokenURI")
    // Rows past the deadline are skipped outright rather than piling more work on the pool.
    assert.ok(
      state.hangingTokenUriCalls < TOKEN_COUNT,
      `every one of ${TOKEN_COUNT} rows still opened a tokenURI call (${state.hangingTokenUriCalls})`,
    )
    // Pre-fix this was rows/concurrency x per-request timeout with no ceiling.
    assert.ok(elapsed < 15_000, `holdings query took ${elapsed}ms, expected the ${METADATA_BUDGET_MS}ms budget to cap it`)
  })
})
