import assert from "node:assert/strict"
import test from "node:test"
import { createRpcManager, createRpcPool } from "../server/rpc-pool.js"

function response(result, status = 200, retryAfter = "") {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name.toLowerCase() === "retry-after" ? retryAfter : null }, async json() { return status === 200 ? { jsonrpc: "2.0", id: 1, result } : {} } }
}

test("verified HTTP endpoints isolate a wrong chain and expose reportedChainId", async () => {
  const pool = createRpcPool({ chainId: 1, urls: ["https://wrong.example"], fetchImpl: async (_url, options) => response("0x2") })
  await assert.rejects(() => pool.request({ method: "eth_blockNumber", params: [] }), /No verified|All RPC upstreams/)
  assert.equal(pool.status()[0].state, "mismatch")
  assert.equal(pool.status()[0].reportedChainId, 2)
  assert.ok(pool.status()[0].retryAfterMs >= 299000)
})

test("429 honors Retry-After while the manager keeps lane accounting shared", async () => {
  const calls = []
  const manager = createRpcManager({ chainId: 1, urls: ["https://limited.example", "https://ready.example"], fetchImpl: async (url, options) => {
    const method = JSON.parse(options.body).method; calls.push([url, method])
    if (method === "eth_chainId") return response("0x1")
    return url.includes("limited") ? response(null, 429, "3") : response("0x10")
  }, maxAttempts: 1 })
  assert.equal(await manager.interactive.request({ method: "eth_blockNumber", params: [] }), "0x10")
  assert.equal(manager.status().upstreams[0].retryAfterMs >= 1900, true)
  assert.equal(manager.status().lanes.interactive.requests, 1)
  assert.equal(calls.some(([, method]) => method === "eth_chainId"), true)
})

test("manual RPC selection verifies the chain and routes reads and writes to the preferred endpoint", async () => {
  const calls = []
  const manager = createRpcManager({
    chainId: 1,
    urls: ["https://first.example", "https://second.example"],
    fetchImpl: async (url, options) => {
      const method = JSON.parse(options.body).method
      calls.push([new URL(url).hostname, method])
      return response(method === "eth_chainId" ? "0x1" : "0xabc")
    },
  })

  await manager.setPreferredEndpoint("rpc-1")
  assert.equal(manager.status().preferredId, "rpc-1")
  assert.equal(await manager.request({ method: "eth_blockNumber", params: [] }), "0xabc")
  assert.equal(await manager.write.request({ method: "eth_sendRawTransaction", params: ["0xsigned"] }), "0xabc")
  assert.deepEqual(calls.slice(-2).map(([host]) => host), ["second.example", "second.example"])
  assert.deepEqual(calls.map(([, method]) => method), ["eth_chainId", "eth_chainId", "eth_blockNumber", "eth_sendRawTransaction"])

  manager.clearPreferredEndpoint()
  assert.equal(manager.status().preferredId, null)
})

test("manual RPC selection rejects an endpoint reporting another chain", async () => {
  const manager = createRpcManager({
    chainId: 1,
    urls: ["https://wrong.example"],
    fetchImpl: async () => response("0x2"),
  })
  await assert.rejects(() => manager.setPreferredEndpoint("rpc-0"), /failed chain verification/)
  assert.equal(manager.status().preferredId, null)
  assert.equal(manager.status().upstreams[0].state, "mismatch")
})

test("a failed preferred RPC falls back in the same request and resumes after backoff", async () => {
  const calls = []
  let secondFailures = 0
  const manager = createRpcManager({
    chainId: 1,
    urls: ["https://fallback.example", "https://preferred.example"],
    maxAttempts: 2,
    hedgeDelayMs: 1,
    halfOpenAfterMs: 100,
    cacheTtlMs: 0,
    fetchImpl: async (url, options) => {
      const method = JSON.parse(options.body).method
      const host = new URL(url).hostname
      calls.push([host, method])
      if (method === "eth_chainId") return response("0x1")
      if (host === "preferred.example" && secondFailures++ === 0) throw new Error("preferred unavailable")
      return response(host === "preferred.example" ? "0xpreferred" : "0xfallback")
    },
  })

  await manager.setPreferredEndpoint("rpc-1")
  assert.equal(await manager.request({ method: "eth_blockNumber", params: [] }), "0xfallback")
  assert.equal(calls.some(([host, method]) => host === "fallback.example" && method === "eth_blockNumber"), true)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(await manager.request({ method: "eth_blockNumber", params: [] }), "0xpreferred")
  assert.equal(manager.status().activeHost, "preferred.example")
})
