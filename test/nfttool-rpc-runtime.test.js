import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) || null },
  setItem(key, value) { this.values.set(key, String(value)) },
  removeItem(key) { this.values.delete(key) },
}

const { networkBar, syncWriteChain, writeChainId, writeProfileId, writeProfileRef } = await import("../apps/nfttool/runtime/core.js")

const state = {
  chainId: 1,
  chains: [{ id: 1, name: "Ethereum", nativeSymbol: "ETH" }],
  wallets: [],
  writeProfileId: "ethereum",
  writeProfileRef: "",
  customRpcEndpoints: "",
  rpcProfiles: [
    { id: "ethereum", label: "Ethereum", chainId: 1, available: true },
    { id: "bsc", label: "BSC", chainId: 56, available: true },
    { id: "base", label: "Base", chainId: 8453, available: true },
    { id: "robinhood", label: "Robinhood", chainId: 4663, available: true },
    { id: "custom", label: "自定义", chainId: null, available: true },
  ],
  rpcReadByChain: { "1": { state: "ready", activeHost: "public.example" } },
}

test("transaction network bar exposes exactly five final write profile labels", () => {
  const html = networkBar({ state, includeAsset: false })
  assert.doesNotMatch(html, /Network|class="chain-select"/)
  for (const label of ["Ethereum", "BSC", "Base", "Robinhood", "自定义"]) assert.match(html, new RegExp(label))
  for (const retired of ["HK", "Flashbots", "Arbitrum", "ZKS", "Shib"]) assert.doesNotMatch(html, new RegExp(retired))
  assert.equal((html.match(/class="rpc-profile-radio"/g) || []).length, 5)
  assert.match(html, /value="ethereum"[^>]+checked/)
  assert.match(html, /rpc-profile-test/)
  assert.doesNotMatch(html, new RegExp(["rpc", "profile", "status"].join("-")))
  assert.doesNotMatch(html, /Ethereum[^<]*未配置/)
  assert.doesNotMatch(html, /仅 .* 链|未配置|is-disabled|disabled/)
  assert.equal(writeProfileId(state), "ethereum")
  const switched = { ...state, writeProfileId: "bsc", transactionChainId: 56 }
  assert.equal(writeChainId(switched), 56)
  assert.equal(switched.chainId, 1)
})

test("runtime sections contain no Network selector argument or DOM", () => {
  const files = [
    "advanced-mint.js",
    "follow-mint.js",
    "mint-action-panel.js",
    "mint-monitor.js",
    "nft-management.js",
    "transfer-pages.js",
    "wallet-manager.js",
  ]
  for (const file of files) {
    const source = readFileSync(new URL(`../apps/nfttool/runtime/${file}`, import.meta.url), "utf8")
    const calls = source.match(/networkBar\(\{[^)]*\}\)/g) || []
    if (file === "mint-monitor.js") {
      assert.equal(calls.length, 0, "Live Mint should not render the removed top Network/account block")
    } else {
      assert.ok(calls.length, `${file} should use networkBar`)
    }
    for (const call of calls) assert.doesNotMatch(call, /includeChain|chain-select|Network/, `${file} must use sender profile only`)
    assert.doesNotMatch(source, /class="chain-select"|<span>Network<\/span>/)
  }
})

test("custom profile renders an endpoint editor without exposing it in read-only mode", () => {
  const customState = { ...state, writeProfileId: "custom", customRpcEndpoints: "https://personal.example\nhttps://backup.example" }
  const html = networkBar({ state: customState, includeAsset: false })
  assert.match(html, /custom-rpc-input/)
  assert.match(html, /personal\.example/)
  assert.equal(writeProfileId(customState), "custom")
  assert.equal(writeProfileRef(customState), "")
  const readOnly = networkBar({ state: customState, includeAsset: false, mode: "readOnly" })
  assert.doesNotMatch(readOnly, /公共 RPC 自动轮询|未探测|public\.example|ethereum-rpc\.publicnode\.com|rpc-readonly-status|data-rpc-readonly/)
  assert.doesNotMatch(readOnly, /rpc-profile-radio|custom-rpc-input|发送节点/)
})

test("Live Mint profile changes follow the selected sender chain", () => {
  const switched = { chainId: 1, transactionChainId: 1 }
  assert.equal(syncWriteChain(switched, 56), 56)
  assert.equal(switched.chainId, 56)
  assert.equal(switched.transactionChainId, 56)
  const core = readFileSync(new URL("../apps/nfttool/runtime/core.js", import.meta.url), "utf8")
  assert.doesNotMatch(core, /routeName\s*!==\s*['"]mint['"]\s*\)/)
  assert.match(core, /syncWriteChain\(runtimeState, resolvedChainId\)/)
  assert.match(core, /syncWriteChain\(runtimeState, result\.test\.chainId\)/)
})

test("profile switching is serialized so a second click cannot split UI and chain state", () => {
  const html = networkBar({ state: { ...state, rpcProfileSwitching: true }, includeAsset: false })
  assert.equal((html.match(/class="rpc-profile-radio"/g) || []).length, 5)
  assert.equal((html.match(/class="rpc-profile-radio"[^>]*disabled/g) || []).length, 5)
  const core = readFileSync(new URL("../apps/nfttool/runtime/core.js", import.meta.url), "utf8")
  assert.match(core, /rpcProfileSwitching/)
  assert.match(core, /if \(runtimeState\.rpcProfileSwitching \|\| runtimeState\.rpcProfileTesting\)/)
})
