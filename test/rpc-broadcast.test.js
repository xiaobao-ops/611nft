import assert from "node:assert/strict"
import test from "node:test"
import { broadcastWithFailover } from "../server/rpc-broadcast.js"

test("broadcast failover changes endpoint only for an explicit connection failure", async () => {
  const calls = []
  const result = await broadcastWithFailover({
    endpoints: [{ id: "first" }, { id: "second" }],
    isConnectionFailure: (error) => error.code === "ECONNREFUSED",
    send: async (endpoint) => {
      calls.push(endpoint.id)
      if (endpoint.id === "first") throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })
      return { txHash: "0xsecond" }
    },
  })
  assert.deepEqual(calls, ["first", "second"])
  assert.equal(result.txHash, "0xsecond")
})

test("broadcast timeout is surfaced as unknown without a second send", async () => {
  const calls = []
  await assert.rejects(() => broadcastWithFailover({
    endpoints: [{ id: "first" }, { id: "second" }],
    isUncertain: (error) => error.code === "BROADCAST_UNCERTAIN",
    isConnectionFailure: () => true,
    send: async (endpoint) => {
      calls.push(endpoint.id)
      throw Object.assign(new Error("confirmation pending"), { code: "BROADCAST_UNCERTAIN" })
    },
  }), (error) => error.code === "BROADCAST_UNCERTAIN")
  assert.deepEqual(calls, ["first"])
})

