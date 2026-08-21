import assert from "node:assert/strict"
import test from "node:test"
import { resolveLaunchpad } from "../server/launchpad.js"

const CONTRACT = "0x00000000000000000000000000000000000000A1"

test("launchpad resolver verifies a page contract against current-chain bytecode", async () => {
  const result = await resolveLaunchpad({
    url: "https://magiceden.io/launchpad/eth/demo",
    chainId: 1,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => `<html><head><title>Demo Drop | Magic Eden</title></head><body><script>{"contractAddress":"${CONTRACT}","methodSignature":"mint(uint256)"}</script></body></html>`,
    }),
    hasContractCode: async (address) => address.toLowerCase() === CONTRACT.toLowerCase(),
  })
  assert.equal(result.provider, "Magic Eden")
  assert.equal(result.name, "Demo Drop")
  assert.equal(result.contractAddress, CONTRACT.toLowerCase())
  assert.equal(result.methodSignature, "mint(uint256)")
  assert.ok(result.evidence.includes("contract_field"))
})

test("launchpad resolver rejects non-marketplace URLs before fetching", async () => {
  let fetched = false
  await assert.rejects(() => resolveLaunchpad({
    url: "https://example.com/drop",
    chainId: 1,
    fetchImpl: async () => { fetched = true },
    hasContractCode: async () => true,
  }), /OpenSea 或 Magic Eden/)
  assert.equal(fetched, false)
})

