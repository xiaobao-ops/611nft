import assert from "node:assert/strict"
import test from "node:test"
import { createRpcProfileStore } from "../server/rpc-profiles.js"

const chains = {
  4663: { id: 4663, name: "Robinhood Chain", key: "robinhood", rpcUrl: "https://a.example", rpcUrls: ["https://a.example"] },
}

// A pool whose endpoints can be made to fail and recover, with a clock the test controls.
function pool({ failWhile }) {
  const calls = []
  let clock = 1_000_000
  const store = createRpcProfileStore({
    chains,
    env: {
      NFT_WRITE_RPC_ROBINHOOD_URLS: "https://a.example,https://b.example,https://c.example",
    },
    now: () => clock,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url, method: body.method, at: clock })
      if (failWhile()) throw new Error("HTTP request failed")
      return {
        ok: true,
        status: 200,
        async json() { return { result: body.method === "eth_chainId" ? "0x1237" : "0x20" } },
      }
    },
  })
  return { store, calls, advance: (ms) => { clock += ms }, at: () => clock }
}

test("a pool emptied by a burst of failures recovers once the backoff expires", async () => {
  // The observed failure: 40 concurrent sends drove all three endpoints into backoff, and
  // because only "probing" endpoints were ever re-probed, the pool stayed empty for the
  // rest of the process — the next batch failed 38 of 40 with "没有通过链 ID 校验的
  // 自定义 RPC endpoint", an error about chain IDs that had nothing to do with chain IDs.
  let failing = true
  const { store, advance } = pool({ failWhile: () => failing })

  await assert.rejects(() => store.verifyChain("robinhood", 4663), /没有通过链 ID 校验/)

  // The endpoints are healthy again, but the backoff (1.5s) has not expired yet.
  failing = false
  await assert.rejects(() => store.verifyChain("robinhood", 4663), /没有通过链 ID 校验/)

  // Once it has, the pool must come back on its own.
  advance(1_600)
  const verified = await store.verifyChain("robinhood", 4663)
  assert.equal(verified.endpoints.length, 3, "every endpoint must be usable again")
})

test("an endpoint still inside its backoff window is not retried early", async () => {
  let failing = true
  const { store, calls, advance } = pool({ failWhile: () => failing })
  await assert.rejects(() => store.verifyChain("robinhood", 4663), /没有通过链 ID 校验/)
  const afterFirst = calls.length

  failing = false
  advance(500)
  await assert.rejects(() => store.verifyChain("robinhood", 4663), /没有通过链 ID 校验/)
  assert.equal(calls.length, afterFirst, "no probe may be sent while the penalty stands")

  advance(1_200)
  await store.verifyChain("robinhood", 4663)
  assert.ok(calls.length > afterFirst, "the probe must happen once the penalty expires")
})

test("a healthy pool is not re-probed on every call", async () => {
  const { store, calls } = pool({ failWhile: () => false })
  await store.verifyChain("robinhood", 4663)
  const afterFirst = calls.length
  await store.verifyChain("robinhood", 4663)
  assert.equal(calls.length, afterFirst, "ready endpoints need no further probing")
})

test("one failing endpoint does not take the healthy ones down with it", async () => {
  const calls = []
  let clock = 1_000_000
  const store = createRpcProfileStore({
    chains,
    env: { NFT_WRITE_RPC_ROBINHOOD_URLS: "https://a.example,https://b.example,https://c.example" },
    now: () => clock,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url })
      if (url.includes("b.example")) throw new Error("HTTP request failed")
      return { ok: true, status: 200, async json() { return { result: body.method === "eth_chainId" ? "0x1237" : "0x20" } } }
    },
  })
  const verified = await store.verifyChain("robinhood", 4663)
  assert.equal(verified.endpoints.length, 2)
  assert.ok(verified.endpoints.every((endpoint) => !endpoint.url.includes("b.example")))
})

test("a chain-ID mismatch keeps its long penalty instead of being retried every call", async () => {
  // A mismatch is a misconfigured endpoint, not a transient failure: retrying it as if it
  // might recover would probe a wrong-chain node every 1.5 seconds forever.
  const calls = []
  let clock = 1_000_000
  const store = createRpcProfileStore({
    chains,
    env: { NFT_WRITE_RPC_ROBINHOOD_URLS: "https://wrong.example" },
    now: () => clock,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url })
      return { ok: true, status: 200, async json() { return { result: body.method === "eth_chainId" ? "0x1" : "0x20" } } }
    },
  })
  await assert.rejects(() => store.verifyChain("robinhood", 4663), /没有通过链 ID 校验/)
  const afterFirst = calls.length
  clock += 2_000
  await assert.rejects(() => store.verifyChain("robinhood", 4663), /没有通过链 ID 校验/)
  assert.equal(calls.length, afterFirst, "a wrong-chain endpoint must not be re-probed after 1.5s")
})
