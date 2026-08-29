import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = `0x${"11".repeat(20)}`
const DESTINATION = `0x${"22".repeat(20)}`

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

test("an AWP sweep plan is rejected before the writer RPC is touched", { timeout: 30_000 }, async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), "611nft-sweep-provider-"))
  const walletRoot = join(runtime, "wallets")
  await mkdir(walletRoot, { recursive: true })
  await writeFile(join(walletRoot, "wallets.json"), JSON.stringify({
    source: {
      address: SOURCE,
      source: "root-env",
      provider: "local",
      capabilities: { sweep: true, signExactEnvelope: true },
    },
    destination: { address: DESTINATION, source: "external" },
  }))

  const rpcState = { calls: 0 }
  const rpc = createServer(async (req, res) => {
    rpcState.calls += 1
    for await (const _chunk of req) {
      // Drain the request before returning the trap response.
    }
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "writer RPC must not be called" }))
  })
  const rpcPort = await listen(rpc)
  const rpcUrl = `http://127.0.0.1:${rpcPort}`
  const appPort = await unusedPort()
  const appUrl = `http://127.0.0.1:${appPort}`
  let output = ""
  const child = spawn(process.execPath, ["--experimental-sqlite", join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      WALLET_BOARD_PORT: String(appPort),
      WALLET_BOARD_API_HOST: "127.0.0.1",
      WALLET_BOARD_API_HOSTS: "",
      WALLET_BOARD_API_TOKEN: "",
      WALLET_BOARD_DB_PATH: join(runtime, "test.sqlite"),
      WALLET_BOARD_WALLET_ROOT: walletRoot,
      WALLET_KEYS_FILE: join(runtime, "wallet-keys.env"),
      ETH_RPC_URL: rpcUrl,
      ETH_RPC_URLS: rpcUrl,
      WSS_RPC_URL_ETHEREUM: "ws://127.0.0.1:1",
      MINT_MONITOR_ENABLE_INTEL: "false",
      MINT_MONITOR_POLL_MS: "60000",
      MINT_MONITOR_HEARTBEAT_MS: "0",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM")
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    if (child.exitCode === null) child.kill("SIGKILL")
    if (rpc.listening) await new Promise((resolve) => rpc.close(resolve))
    await rm(runtime, { recursive: true, force: true })
  })

  await waitForServer(appUrl, child, () => output)
  const walletsResponse = await fetch(`${appUrl}/api/wallets`)
  assert.equal(walletsResponse.status, 200)
  const walletsPayload = await walletsResponse.json()
  const source = walletsPayload.wallets.find((wallet) => wallet.id === "source")
  assert.equal(source.provider, "awp")
  assert.equal(source.capabilities.sweep, false)
  assert.equal(Object.hasOwn(walletsPayload, "walletRoot"), false)

  rpcState.calls = 0
  const response = await fetch(`${appUrl}/api/plan/many-to-one`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: 1,
      sourceIds: ["source"],
      destinationWalletId: "destination",
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 400, JSON.stringify(payload))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /provider=awp/)
  assert.equal(rpcState.calls, 0, "capability rejection must happen before any RPC read")
})
