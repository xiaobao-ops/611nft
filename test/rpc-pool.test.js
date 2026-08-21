import assert from "node:assert/strict"
import test from "node:test"
import { zeroAddress } from "viem"
import { ERC1155_TRANSFER_BATCH, ERC1155_TRANSFER_SINGLE, ERC721_TRANSFER } from "../server/mint-monitor.js"
import { createRpcPool, createViemWssClient, createWssFailoverManager } from "../server/rpc-pool.js"

function rpcResponse(result) {
  return { ok: true, status: 200, async json() { return { jsonrpc: "2.0", id: 1, result } } }
}

test("RPC pool hedges slow reads to the next upstream", async () => {
  const calls = []
  const pool = createRpcPool({
    urls: ["https://slow.example", "https://fast.example"],
    hedgeDelayMs: 5,
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      calls.push(new URL(url).hostname)
      if (url.includes("slow")) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100)
          options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")) })
        })
      }
      return rpcResponse("0x2a")
    },
  })

  assert.equal(await pool.request({ method: "eth_blockNumber", params: [] }), "0x2a")
  assert.deepEqual(calls, ["slow.example", "fast.example"])
})

test("RPC pool coalesces and caches identical realtime reads", async () => {
  let calls = 0
  const pool = createRpcPool({
    urls: ["https://rpc.example"],
    cacheTtlMs: 1000,
    fetchImpl: async () => { calls += 1; return rpcResponse("0x5") },
  })
  const request = { method: "eth_blockNumber", params: [] }
  assert.deepEqual(await Promise.all([pool.request(request), pool.request(request)]), ["0x5", "0x5"])
  assert.equal(await pool.request(request), "0x5")
  assert.equal(calls, 1)
})

test("RPC pool sends write methods to one upstream exactly once", async () => {
  const calls = []
  const pool = createRpcPool({
    urls: ["https://one.example", "https://two.example"],
    fetchImpl: async (url) => { calls.push(url); return rpcResponse(`0x${"aa".repeat(32)}`) },
  })
  const hash = await pool.request({ method: "eth_sendRawTransaction", params: ["0xsigned"] })
  assert.equal(hash, `0x${"aa".repeat(32)}`)
  assert.equal(calls.length, 1)
})

test("transport failures open the upstream circuit", async () => {
  const pool = createRpcPool({
    urls: ["https://broken.example"],
    maxAttempts: 1,
    circuitFailureThreshold: 2,
    fetchImpl: async () => { throw new Error("network down") },
  })
  await assert.rejects(() => pool.request({ method: "net_version", params: [] }))
  await assert.rejects(() => pool.request({ method: "net_version", params: [] }))
  assert.equal(pool.status()[0].state, "open")
})

test("deterministic RPC errors are checked across upstreams without retry loops", async () => {
  let calls = 0
  const pool = createRpcPool({
    urls: ["https://one.example", "https://two.example"],
    hedgeDelayMs: 1,
    maxAttempts: 3,
    fetchImpl: async () => {
      calls += 1
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } } } }
    },
  })
  await assert.rejects(() => pool.request({ method: "eth_getLogs", params: [{}] }), /All RPC upstreams failed/)
  assert.equal(calls, 1)
})

test("heavy log scans fail over sequentially without hedge amplification", async () => {
  const calls = []
  const pool = createRpcPool({
    urls: ["https://limited.example", "https://working.example"],
    hedgeDelayMs: 1,
    maxAttempts: 2,
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname)
      if (url.includes("limited")) throw new Error("transport unavailable")
      return rpcResponse([])
    },
  })
  assert.deepEqual(await pool.request({ method: "eth_getLogs", params: [{}] }), [])
  assert.deepEqual(calls, ["limited.example", "working.example"])
})

test("upstream payment and archive restrictions fail over to a usable log node", async () => {
  const calls = []
  const pool = createRpcPool({
    urls: ["https://paid.example", "https://archive.example", "https://working.example"],
    maxAttempts: 3,
    fetchImpl: async (url) => {
      calls.push(new URL(url).hostname)
      if (url.includes("paid")) return { ok: false, status: 402, async json() { return {} } }
      if (url.includes("archive")) {
        return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Archive requests require a personal token" } } } }
      }
      return rpcResponse([])
    },
  })
  assert.deepEqual(await pool.request({ method: "eth_getLogs", params: [{}] }), [])
  assert.deepEqual(calls, ["paid.example", "archive.example", "working.example"])
})

test("RPC status redacts endpoint paths and counts rate limits and HTTP fallbacks", async () => {
  const pool = createRpcPool({
    urls: ["https://token:secret@limited.example/private-key", "https://working.example/rpc"],
    maxAttempts: 2,
    fetchImpl: async (url) => url.includes("limited")
      ? { ok: false, status: 429, async json() { return {} } }
      : rpcResponse([]),
  })
  assert.deepEqual(await pool.request({ method: "eth_getLogs", params: [{}] }), [])
  const status = pool.status()
  assert.equal("url" in status[0], false)
  assert.equal(status[0].host, "limited.example")
  assert.equal(status[0].rateLimitCount, 1)
  assert.equal(status[1].httpFallbacks, 1)
  assert.equal(Number.isFinite(status[0].lastLatencyMs), true)
})

test("WSS manager fails over, records hits, redacts endpoints, and stays stopped", async () => {
  const calls = []
  const hooks = []
  let closes = 0
  let limitedAttempts = 0
  const manager = createWssFailoverManager({
    urls: ["wss://token@limited.example/private", "wss://working.example/rpc"],
    reconnectDelayMs: 1,
    createClient: async (options) => {
      calls.push(new URL(options.url).hostname)
      hooks.push(options)
      if (options.url.includes("limited") && limitedAttempts++ === 0) throw new Error("429 rate limit")
      return { close() { closes += 1 } }
    },
  })

  await manager.start()
  hooks.at(-1).onEvent([{ id: 1 }])
  manager.recordHttpFallback()
  const status = manager.status()
  assert.equal(status.state, "active")
  assert.equal(status.activeHost, "working.example")
  assert.equal(status.wssHits, 1)
  assert.equal(status.httpFallbacks, 1)
  assert.equal(status.rateLimitCount, 1)
  assert.equal(status.upstreams.every((item) => !("url" in item)), true)
  assert.equal(Number.isFinite(status.lastLatencyMs), true)

  hooks.at(-1).onDisconnect(new Error("working socket closed"))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ["limited.example", "working.example", "limited.example"])
  assert.equal(manager.status().activeHost, "limited.example")

  manager.stop()
  hooks.at(-1).onDisconnect(new Error("socket closed after stop"))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(calls, ["limited.example", "working.example", "limited.example"])
  assert.equal(closes, 2)
  assert.equal(manager.status().state, "stopped")
})

test("WSS manager fails over when a client reports a subscription error during setup", async () => {
  const calls = []
  let closes = 0
  const manager = createWssFailoverManager({
    urls: ["wss://broken.example", "wss://working.example"],
    createClient: async (options) => {
      calls.push(options.host)
      if (options.host === "broken.example") options.onError(new Error("subscription rejected"))
      return { close() { closes += 1 } }
    },
  })

  await manager.start()
  assert.deepEqual(calls, ["broken.example", "working.example"])
  assert.equal(closes, 1)
  assert.equal(manager.status().activeHost, "working.example")
  assert.match(manager.status().upstreams[0].lastError, /subscription rejected/)
  manager.stop()
})

test("viem WSS client watches all NFT mint events and closes subscriptions and socket", async () => {
  const eventWatches = []
  const emitted = []
  const errors = []
  const disconnects = []
  const unwatchCalls = []
  const socketListeners = new Map()
  let blockWatch
  let socketCloses = 0
  let transportInput
  const rpcClient = {
    socket: {
      addEventListener(name, listener) { socketListeners.set(name, listener) },
      removeEventListener(name, listener) {
        if (socketListeners.get(name) === listener) socketListeners.delete(name)
      },
    },
    close() { socketCloses += 1 },
  }
  const client = {
    transport: { async getRpcClient() { return rpcClient } },
    async getChainId() { return 1 },
    watchBlockNumber(options) {
      blockWatch = options
      return () => unwatchCalls.push("head")
    },
    watchEvent(options) {
      eventWatches.push(options)
      return () => unwatchCalls.push(options.event.name)
    },
  }

  const connection = await createViemWssClient({
    url: "wss://token@events.example/private",
    chain: { id: 1 },
    events: [ERC721_TRANSFER, ERC1155_TRANSFER_SINGLE, ERC1155_TRANSFER_BATCH],
    mintFrom: zeroAddress,
    createPublicClient(options) {
      assert.deepEqual(options, { chain: { id: 1 }, transport: transportInput })
      return client
    },
    webSocketTransport(url, options) {
      assert.equal(url, "wss://token@events.example/private")
      assert.deepEqual(options, { retryCount: 0, keepAlive: true, reconnect: false })
      transportInput = { type: "webSocket" }
      return transportInput
    },
    onEvent: (value) => emitted.push(value),
    onDisconnect: (error) => disconnects.push(error),
    onError: (error) => errors.push(error),
  })

  assert.deepEqual(eventWatches.map((watch) => watch.event.name), ["Transfer", "TransferSingle", "TransferBatch"])
  assert.ok(eventWatches.every((watch) => watch.args.from === zeroAddress && watch.strict === true))
  blockWatch.onBlockNumber(42n)
  const removed = { transactionHash: `0x${"11".repeat(32)}`, address: "0x1111111111111111111111111111111111111111", removed: true }
  eventWatches[0].onLogs([{ removed: false }])
  eventWatches[1].onLogs([removed])
  assert.deepEqual(emitted, [
    { type: "head", blockNumber: 42n },
    { type: "logs", logs: [{ removed: false }] },
    { type: "logs", logs: [removed] },
  ])
  socketListeners.get("close")?.(new Error("socket closed"))
  assert.equal(disconnects.length, 1)
  eventWatches[2].onError(new Error("subscription failed"))
  assert.equal(errors.length, 1)

  connection.close()
  connection.close()
  assert.deepEqual(unwatchCalls, ["head", "Transfer", "TransferSingle", "TransferBatch"])
  assert.equal(socketCloses, 1)
  assert.equal(socketListeners.has("close"), false)
  eventWatches[0].onLogs([{ removed: false }])
  assert.equal(emitted.length, 3)
})

test("viem WSS event descriptors preserve address filters and event scope", async () => {
  let watch
  const emitted = []
  const address = "0x1111111111111111111111111111111111111111"
  const connection = await createViemWssClient({
    url: "wss://events.example",
    chain: { id: 1 },
    events: [{ event: ERC721_TRANSFER, address, args: null, scope: "seadrop" }],
    mintFrom: zeroAddress,
    createPublicClient: () => ({
      transport: { async getRpcClient() { return { close() {} } } },
      async getChainId() { return 1 },
      watchBlockNumber() { return () => {} },
      watchEvent(options) { watch = options; return () => {} },
    }),
    webSocketTransport: () => ({}),
    onEvent: (value) => emitted.push(value),
  })

  assert.equal(watch.address, address)
  assert.equal("args" in watch, false)
  watch.onLogs([{ address }])
  assert.deepEqual(emitted, [{ type: "logs", scope: "seadrop", logs: [{ address }] }])
  connection.close()
})

test("viem WSS client closes the socket when chain validation fails", async () => {
  let closes = 0
  const rpcClient = { close() { closes += 1 } }
  const client = {
    transport: { async getRpcClient() { return rpcClient } },
    async getChainId() { return 8453 },
  }
  await assert.rejects(() => createViemWssClient({
    url: "wss://wrong-chain.example",
    chain: { id: 1 },
    events: [ERC721_TRANSFER],
    mintFrom: zeroAddress,
    createPublicClient: () => client,
    webSocketTransport: () => ({ type: "webSocket" }),
  }), /chain id mismatch/i)
  assert.equal(closes, 1)
})
