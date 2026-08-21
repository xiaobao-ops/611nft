import assert from "node:assert/strict"
import test from "node:test"
import { createRpcProfileStore, RPC_PROFILE_DEFINITIONS } from "../server/rpc-profiles.js"

const chains = {
  1: { id: 1, name: "Ethereum", key: "ethereum", rpcUrl: "https://read.example", rpcUrls: ["https://read.example", "https://read-backup.example"] },
  56: { id: 56, name: "BNB Chain", key: "bsc", rpcUrl: "https://bsc-read.example", rpcUrls: ["https://bsc-read.example"] },
  8453: { id: 8453, name: "Base", key: "base", rpcUrl: "https://base-read.example", rpcUrls: ["https://base-read.example"] },
  4663: { id: 4663, name: "Robinhood Chain", key: "robinhood", rpcUrl: "https://robinhood-read.example", rpcUrls: ["https://robinhood-read.example"] },
  42161: { id: 42161, name: "Arbitrum", key: "arbitrum", rpcUrl: "https://arb-read.example", rpcUrls: ["https://arb-read.example"] },
  324: { id: 324, name: "zkSync Era", key: "zks", rpcUrl: "https://zks-read.example", rpcUrls: ["https://zks-read.example"] },
  109: { id: 109, name: "Shibarium", key: "shib", rpcUrl: "https://shib-read.example", rpcUrls: ["https://shib-read.example"] },
}

function fixtureStore(calls, env = {}, responseChain = 1) {
  return createRpcProfileStore({
    chains,
    env: {
      NFT_WRITE_RPC_MAIN_URL: "https://main.example",
      NFT_WRITE_RPC_ETHEREUM_URLS: "https://ethereum-a.example,https://ethereum-b.example",
      NFT_WRITE_RPC_BSC_URL: "https://bsc.example",
      NFT_WRITE_RPC_BASE_URL: "https://base.example",
      NFT_WRITE_RPC_ROBINHOOD_URL: "https://robinhood.example",
      ...env,
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url, method: body.method })
      return {
        ok: true,
        status: 200,
        async json() { return { result: body.method === "eth_chainId" ? `0x${responseChain.toString(16)}` : "0x20" } },
      }
    },
  })
}

test("public write profile definitions contain exactly five final choices", () => {
  assert.deepEqual(RPC_PROFILE_DEFINITIONS.map((profile) => profile.id), ["ethereum", "bsc", "base", "robinhood", "custom"])
})

test("built-in sender profiles stay globally visible with their own chain metadata", () => {
  const store = createRpcProfileStore({ chains, env: {} })
  for (const monitorChainId of [1, 56, 8453, 4663, 42161]) {
    const profiles = store.list(monitorChainId)
    assert.deepEqual(profiles.map((profile) => profile.id), ["ethereum", "bsc", "base", "robinhood", "custom"])
    for (const [chainId, profileId] of [[1, "ethereum"], [56, "bsc"], [8453, "base"], [4663, "robinhood"]]) {
      const profile = profiles.find((row) => row.id === profileId)
      assert.equal(profile.chainId, chainId)
      assert.equal(profile.applicable, true)
      assert.equal(profile.configured, true)
      assert.equal(profile.available, true)
      assert.ok(profile.endpointCount >= 2)
      const resolved = store.resolve(profileId, chainId)
      assert.ok(resolved.urls.length >= 2)
    }
  }
})

test("explicit write profile env pools override built-in endpoints", () => {
  const store = createRpcProfileStore({
    chains,
    env: { NFT_WRITE_RPC_BASE_URLS: "https://custom-a.example,https://custom-a.example,https://custom-b.example" },
  })
  const profile = store.resolve("base", 8453)
  assert.deepEqual(profile.urls, ["https://custom-a.example/", "https://custom-b.example/"])
})

test("HK is a compatibility alias and retired write profiles are rejected", () => {
  const store = fixtureStore([])
  assert.equal(store.resolve("hk", 1).id, "ethereum")
  assert.equal(store.metadata("hk", 1).id, "ethereum")
  assert.equal(store.list(56).find((row) => row.id === "ethereum").applicable, true)
  assert.equal(store.list(4663).find((row) => row.id === "robinhood").available, true)
  assert.throws(() => store.resolve("flashbots", 1), (error) => error.code === "profile_retired")
  assert.equal(store.list(42161).some((row) => row.id === "arbitrum"), false)
  assert.equal(store.list(324).some((row) => row.id === "zks"), false)
  assert.equal(store.list(109).some((row) => row.id === "shib"), false)
})

test("profile test performs only chain id and block number reads", async () => {
  const calls = []
  const store = fixtureStore(calls)
  const result = await store.test("ethereum")
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_blockNumber"])
  assert.equal(result.chainId, 1)
  assert.equal(result.endpointCount, 2)
  assert.equal(calls.every((call) => call.url.includes("ethereum-")), true)
})

test("a built-in sender rejects a conflicting legacy chain hint", () => {
  const store = fixtureStore([])
  assert.throws(() => store.resolve("bsc", 1), (error) => error.code === "profile_chain_mismatch")
  assert.equal(store.resolve("bsc").chainId, 56)
})

test("wrong chain endpoints are rejected without exposing URL credentials", async () => {
  const store = createRpcProfileStore({
    chains: { 1: chains[1] },
    env: { NFT_WRITE_RPC_ETHEREUM_URL: "https://token:secret@wrong.example/private" },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { result: "0x2" } } }),
  })
  await assert.rejects(() => store.verifyChain("ethereum", 1), (error) => {
    assert.equal(error.code, "rpc_chain_verification_failed")
    assert.doesNotMatch(error.message, /secret|wrong\.example|private/)
    return true
  })
})

test("custom endpoints return a short-lived ref and never expose their host", async () => {
  const calls = []
  const store = fixtureStore(calls)
  const testResult = await store.test("custom", 1, { endpoints: ["https://user:secret@personal.example/a", "https://backup.example"] })
  assert.match(testResult.profileRef, /^custom_[a-f0-9]{24}$/)
  assert.equal(testResult.endpoints.every((endpoint) => endpoint.host === ""), true)
  assert.doesNotMatch(JSON.stringify(testResult), /personal\.example|secret/)
  const selected = await store.select("custom", 1, { endpoints: "https://personal.example/a" })
  assert.match(selected.profileRef, /^custom_[a-f0-9]{24}$/)
  assert.equal(selected.host, "")
  assert.equal(selected.available, true)
  assert.equal(selected.configured, true)
  assert.equal(calls.every((call) => ["eth_chainId", "eth_blockNumber"].includes(call.method)), true)
})

test("custom endpoints infer chainId when omitted", async () => {
  const calls = []
  const store = fixtureStore(calls, {}, 8453)
  const result = await store.test("custom", undefined, { endpoints: ["https://personal.example", "https://backup.example"] })
  assert.equal(result.ok, true)
  assert.equal(result.chainId, 8453)
  assert.equal(result.chainName, "Base")
  assert.match(result.profileRef, /^custom_[a-f0-9]{24}$/)
  const selected = await store.select("custom", undefined, { profileRef: result.profileRef })
  assert.equal(selected.chainId, 8453)
  assert.equal(selected.profileRef, result.profileRef)
  assert.equal(calls.every((call) => ["eth_chainId", "eth_blockNumber"].includes(call.method)), true)
})
