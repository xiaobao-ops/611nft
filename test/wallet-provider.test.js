import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createAwpWalletProvider,
  normalizeWalletGroup,
  readAwpWalletRegistry,
  requireWalletCapability,
  walletProviderSummary,
} from "../server/wallet-provider.js"

const PUBLIC_EIP55_EXAMPLE = "0x52908400098527886E0F7030069857D2E4169EE7"

function runtimePaths(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const walletRoot = join(root, "wallets")
  mkdirSync(walletRoot, { recursive: true })
  return { root, walletRoot, walletsPath: join(walletRoot, "wallets.json") }
}

test("an absent AWP registry is an empty provider, never a local-key fallback", () => {
  const paths = runtimePaths("611nft-awp-empty-")
  const provider = createAwpWalletProvider(paths)
  assert.deepEqual(provider.registry(), {})
  assert.equal(provider.accountForWallet("default"), null)
  assert.deepEqual(provider.summary(), walletProviderSummary())
  assert.deepEqual(provider.summary().management, {
    createWallets: true,
    importPrivateKeys: false,
    exportPrivateKeys: false,
    removeWallets: false,
  })
})

test("AWP registry records are reduced to public address metadata and fixed capabilities", () => {
  const paths = runtimePaths("611nft-awp-registry-")
  writeFileSync(paths.walletsPath, JSON.stringify({
    default: {
      address: PUBLIC_EIP55_EXAMPLE,
      source: "root-env",
      provider: "local",
      capabilities: { sweep: true, signTypedData: true },
      privateKey: "must-not-cross-provider-boundary",
      account: { address: PUBLIC_EIP55_EXAMPLE },
    },
  }))

  const registry = readAwpWalletRegistry(paths.walletsPath)
  assert.equal(registry.default.address, PUBLIC_EIP55_EXAMPLE)
  assert.equal(registry.default.source, "awp")
  assert.equal(registry.default.provider, "awp")
  assert.equal(registry.default.capabilities.sendTransaction, true)
  assert.equal(registry.default.capabilities.sweep, false)
  assert.equal(registry.default.capabilities.signTypedData, false)
  assert.equal(registry.default.capabilities.exportPrivateKey, false)
  assert.equal("privateKey" in registry.default, false)
  assert.equal("account" in registry.default, false)
  assert.doesNotMatch(JSON.stringify(registry), /must-not-cross-provider-boundary/)
})

test("AWP signer adapters fail closed for message, typed-data and exact-envelope signing", async () => {
  const paths = runtimePaths("611nft-awp-signing-")
  writeFileSync(paths.walletsPath, JSON.stringify({ default: { address: PUBLIC_EIP55_EXAMPLE } }))
  const provider = createAwpWalletProvider(paths)
  const wallet = provider.getWallet("default")
  const account = provider.accountForWallet("default")

  assert.doesNotThrow(() => requireWalletCapability(wallet, "sendTransaction"))
  assert.throws(() => requireWalletCapability(wallet, "sweep"), (error) => (
    error.code === "WALLET_CAPABILITY_UNSUPPORTED" && error.provider === "awp"
  ))
  await assert.rejects(() => account.signMessage({ message: "611nft" }), /不支持消息签名.*provider=awp/)
  await assert.rejects(() => account.signTypedData({}), /不支持 EIP-712 typed-data 签名.*provider=awp/)
  await assert.rejects(() => account.signTransaction({}), /signExactEnvelope.*provider=awp/)
})

test("malformed AWP registries and missing CLI commands stop without creating a fallback wallet", async () => {
  const malformed = runtimePaths("611nft-awp-malformed-")
  writeFileSync(malformed.walletsPath, "[]")
  assert.throws(() => readAwpWalletRegistry(malformed.walletsPath), /必须是 profile 对象/)

  const paths = runtimePaths("611nft-awp-missing-cli-")
  writeFileSync(paths.walletsPath, JSON.stringify({ default: { address: PUBLIC_EIP55_EXAMPLE } }))
  const provider = createAwpWalletProvider({ ...paths, command: join(paths.root, "missing-awp-wallet") })
  await assert.rejects(
    () => provider.sendTransaction("default", ["send-tx"], { timeoutMs: 1_000 }),
    /ENOENT|spawn/,
  )
  assert.deepEqual(Object.keys(provider.registry()), ["default"])
})

test("wallet groups keep the same normalized public metadata contract", () => {
  assert.equal(normalizeWalletGroup("  ops\tteam\u0000  "), "ops team")
})
