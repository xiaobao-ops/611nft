import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HASH = `0x${"00".repeat(32)}`
const ADDRESS = "0x0000000000000000000000000000000000000000"

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

function blockResult() {
  return {
    number: "0x1",
    hash: HASH,
    parentHash: HASH,
    nonce: "0x0000000000000000",
    sha3Uncles: HASH,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: HASH,
    stateRoot: HASH,
    receiptsRoot: HASH,
    miner: ADDRESS,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
    transactions: [],
    uncles: [],
  }
}

async function startRpcFixture() {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(503, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "provider fixture disabled" }))
      return
    }
    let raw = ""
    for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    const results = {
      eth_blockNumber: "0x1",
      eth_chainId: "0x1",
      eth_getLogs: [],
      eth_getBlockByNumber: blockResult(),
      eth_gasPrice: "0x1",
      eth_maxPriorityFeePerGas: "0x1",
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] ?? null }))
  })
  const port = await listen(server)
  return { server, url: `http://127.0.0.1:${port}` }
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

async function openSse(url, headers = {}, cursor = "") {
  const controller = new AbortController()
  const query = new URLSearchParams({ chainId: "1" })
  if (cursor) query.set("cursor", cursor)
  const response = await fetch(`${url}/api/mint-monitor/stream?${query}`, {
    headers,
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const queued = []
  let buffered = ""

  function parseBlocks() {
    let separator
    while ((separator = buffered.indexOf("\n\n")) >= 0) {
      const block = buffered.slice(0, separator)
      buffered = buffered.slice(separator + 2)
      let id = null
      const data = []
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim()
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      if (data.length) queued.push({ id, data: JSON.parse(data.join("\n")) })
    }
  }

  return {
    async next(predicate = () => true, timeoutMs = 3000) {
      const timeout = setTimeout(() => controller.abort(new Error("SSE event timeout")), timeoutMs)
      try {
        while (true) {
          while (queued.length) {
            const event = queued.shift()
            if (predicate(event)) return event
          }
          const chunk = await reader.read()
          if (chunk.done) throw new Error("SSE stream ended")
          buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
          parseBlocks()
        }
      } finally {
        clearTimeout(timeout)
      }
    },
    async close() {
      controller.abort()
      await reader.cancel().catch(() => {})
    },
  }
}

test("bootstrap and realtime routes expose WSS state and replay SSE cursors", async (t) => {
  const fixture = await startRpcFixture()
  const runtime = await mkdtemp(join(tmpdir(), "611nft-realtime-routes-"))
  const port = await unusedPort()
  const baseUrl = `http://127.0.0.1:${port}`
  let output = ""
  const child = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      WALLET_BOARD_PORT: String(port),
      WALLET_BOARD_API_HOST: "127.0.0.1",
      WALLET_BOARD_API_HOSTS: "",
      WALLET_BOARD_API_TOKEN: "",
      WALLET_BOARD_DB_PATH: join(runtime, "test.sqlite"),
      WALLET_BOARD_WALLET_ROOT: join(runtime, "wallets"),
      ETH_RPC_URL: fixture.url,
      ETH_RPC_URLS: fixture.url,
      WSS_RPC_URL_ETHEREUM: "ws://127.0.0.1:1",
      MINT_MONITOR_API_BASE: `${fixture.url}/provider`,
      MINT_MONITOR_ENABLE_INTEL: "false",
      MINT_MONITOR_INITIAL_BLOCKS: "1",
      MINT_MONITOR_INITIAL_RESPONSE_WAIT_MS: "500",
      MINT_MONITOR_PROVIDER_RESPONSE_WAIT_MS: "20",
      MINT_MONITOR_POLL_MS: "60000",
      MINT_MONITOR_BATCH_MS: "10",
      MINT_MONITOR_HEARTBEAT_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM")
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))])
    await new Promise((resolve) => fixture.server.close(resolve))
    await rm(runtime, { recursive: true, force: true })
  })
  await waitForServer(baseUrl, child, () => output)

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap?chainId=1&window=60`)
  assert.equal(bootstrapResponse.status, 200)
  const bootstrap = await bootstrapResponse.json()
  assert.equal(bootstrap.ok, true)
  assert.equal(bootstrap.snapshotVersion, 1)
  assert.equal(typeof bootstrap.serverTime, "string")
  assert.ok(bootstrap.realtimeCursor === null || /^1-\d+$/.test(bootstrap.realtimeCursor))
  assert.equal(bootstrap.chainId, 1)
  assert.ok(bootstrap.status.realtime)
  assert.ok(Array.isArray(bootstrap.status.wss.upstreams))
  assert.equal(bootstrap.status.walletActivity.state, "idle")
  assert.equal(bootstrap.status.wss.upstreams[0].host, "127.0.0.1")
  assert.doesNotMatch(JSON.stringify(bootstrap.status.wss), /ws:\/\//)
  assert.equal(Object.hasOwn(bootstrap.status.rpc, "preferredId"), false)
  assert.equal(bootstrap.status.rpc.upstreams.every((upstream) => !Object.hasOwn(upstream, "preferred")), true)
  assert.ok(bootstrap.overview)
  assert.ok(bootstrap.trending)
  assert.ok(bootstrap.radar)
  assert.ok(Array.isArray(bootstrap.flags))

  const firstStream = await openSse(baseUrl)
  await firstStream.next((event) => event.data.type === "monitor_status")
  const firstAlertResponse = await fetch(`${baseUrl}/api/alerts/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: 1, title: "cursor-one" }),
  })
  const firstAlertBody = await firstAlertResponse.json()
  const firstAlert = await firstStream.next((event) => event.data.id === firstAlertBody.alert.id)
  assert.match(firstAlert.id, /^1-\d+$/)
  await firstStream.close()

  const secondAlertResponse = await fetch(`${baseUrl}/api/alerts/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: 1, title: "cursor-two" }),
  })
  const secondAlertBody = await secondAlertResponse.json()
  const replayStream = await openSse(baseUrl, { "last-event-id": firstAlert.id })
  const replayed = await replayStream.next((event) => event.data.id === secondAlertBody.alert.id)
  assert.match(replayed.id, /^1-\d+$/)
  assert.notEqual(replayed.id, firstAlert.id)
  await replayStream.close()

  const queryReplayStream = await openSse(baseUrl, {}, firstAlert.id)
  const queryReplayed = await queryReplayStream.next((event) => event.data.id === secondAlertBody.alert.id)
  assert.equal(queryReplayed.id, replayed.id)
  await queryReplayStream.close()

  const precedenceStream = await openSse(baseUrl, { "last-event-id": firstAlert.id }, "8453-1")
  const precedenceReplay = await precedenceStream.next((event) => event.data.id === secondAlertBody.alert.id)
  assert.equal(precedenceReplay.id, replayed.id)
  await precedenceStream.close()

  const resetStream = await openSse(baseUrl, { "last-event-id": "8453-1" })
  const reset = await resetStream.next((event) => event.data.type === "replay_reset")
  assert.equal(reset.data.reason, "chain_mismatch")
  assert.equal(reset.data.chainId, 1)
  await resetStream.close()
})
