import assert from "node:assert/strict"
import test from "node:test"
import { createRpcPool } from "../server/rpc-pool.js"

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
