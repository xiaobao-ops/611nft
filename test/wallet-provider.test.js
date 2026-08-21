import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createLocalWalletProfiles,
  localWalletAccount,
  localWalletRegistry,
  importLocalWalletProfiles,
  mergeWalletRegistries,
  normalizeWalletGroup,
  parseLocalWalletProfiles,
  parseWalletImportText,
  removeLocalWalletProfiles,
  exportLocalWalletProfiles,
} from "../server/wallet-provider.js"

const KEY_ONE = "11".repeat(32)
const KEY_TWO = "22".repeat(32)

test("bare root env keys and legacy markers become stable local wallet profiles", () => {
  const parsed = parseLocalWalletProfiles(`${KEY_ONE}\n# 611nft-profile: ops-007\n${KEY_TWO}\nCHAIN_ID=1\n`)
  assert.deepEqual(parsed.invalidLines, [])
  assert.equal(parsed.profiles.length, 2)
  assert.equal(parsed.profiles[0].id, "default")
  assert.equal(parsed.profiles[1].id, "ops-007")
  assert.equal(parsed.profiles[1].group, "")
  assert.match(parsed.profiles[0].address, /^0x[a-fA-F0-9]{40}$/)
})

test("generated profiles append safely without exposing keys through the registry", () => {
  const root = mkdtempSync(join(tmpdir(), "nfttool-wallets-"))
  const envPath = join(root, ".env")
  writeFileSync(envPath, `${KEY_ONE}\nCHAIN_ID=1\n`, { mode: 0o600 })

  const result = createLocalWalletProfiles({ envPath, prefix: "bt", start: 101, count: 2 })
  assert.equal(result.created.length, 2)
  assert.equal(result.skipped.length, 0)
  const registry = localWalletRegistry(envPath)
  assert.deepEqual(Object.keys(registry), ["default", "bt-101", "bt-102"])
  assert.equal("privateKey" in registry["bt-101"], false)
  assert.equal(localWalletAccount(envPath, "bt-102")?.address, registry["bt-102"].address)
  assert.match(readFileSync(envPath, "utf8"), /# nfttool-profile: bt-101/)
  assert.equal(statSync(envPath).mode & 0o777, 0o600)
})

test("duplicate profile ids and invalid wallet lines fail closed", () => {
  assert.throws(
    () => parseLocalWalletProfiles(`# nfttool-profile: same\n${KEY_ONE}\n# 611nft-profile: same\n${KEY_TWO}`),
    /本地钱包编号重复/,
  )
  const parsed = parseLocalWalletProfiles(`${KEY_ONE}\nthis is not a key`)
  assert.deepEqual(parsed.invalidLines, [2])
})

test("root env signer addresses win over stale external profiles with the same id", () => {
  const merged = mergeWalletRegistries(
    { default: { address: `0x${"33".repeat(20)}`, source: "external" } },
    { default: { address: `0x${"44".repeat(20)}`, source: "root-env" } },
  )
  assert.equal(merged.default.address, `0x${"44".repeat(20)}`)
  assert.equal(merged.default.source, "root-env")
})

test("wallet import requires comma-separated name and supports an optional group", () => {
  const parsed = parseWalletImportText(`alpha,${KEY_ONE}\n中文名称,  测试\t组  ,${KEY_TWO}`)
  assert.deepEqual(parsed.map(({ privateKey, ...row }) => row), [
    { id: "alpha", label: "alpha", group: "" },
    { id: "imported-002", label: "中文名称", group: "测试 组" },
  ])
  assert.throws(() => parseWalletImportText(KEY_ONE), /名称,私钥/)
  assert.throws(() => parseWalletImportText(`,${KEY_ONE}`), /缺少钱包名称/)
})

test("wallet groups strip control characters, trim and cap names at 80 characters", () => {
  assert.equal(normalizeWalletGroup(`  ops\tteam\u0000${"x".repeat(90)}  `), `ops team ${"x".repeat(71)}`)
})

test("new and legacy profile blocks parse optional group metadata", () => {
  const modern = parseWalletImportText(`# nfttool-profile: alpha\n# nfttool-group:  主组  \n${KEY_ONE}`)
  const legacy = parseWalletImportText(`# 611nft-profile: beta\n${KEY_TWO}`)
  assert.deepEqual(modern.map(({ privateKey, ...row }) => row), [{ id: "alpha", label: "alpha", group: "主组" }])
  assert.deepEqual(legacy.map(({ privateKey, ...row }) => row), [{ id: "beta", label: "beta", group: "" }])
})

test("import, explicit export and removal preserve profile ids and non-wallet config", () => {
  const root = mkdtempSync(join(tmpdir(), "nfttool-wallet-import-"))
  const envPath = join(root, ".env")
  writeFileSync(envPath, `CHAIN_ID=1\n`, { mode: 0o600 })
  const created = importLocalWalletProfiles({ envPath, text: `alpha,ops,${KEY_ONE}\nbeta,${KEY_TWO}` })
  assert.deepEqual(created.map(({ id, label, group }) => ({ id, label, group })), [
    { id: "alpha", label: "alpha", group: "ops" },
    { id: "beta", label: "beta", group: "" },
  ])
  const exported = exportLocalWalletProfiles({ envPath, profileIds: ["beta"] })
  assert.match(exported, /nfttool-profile: beta/)
  assert.match(exported, new RegExp(KEY_TWO))
  removeLocalWalletProfiles({ envPath, profileIds: ["alpha"] })
  assert.deepEqual(Object.keys(localWalletRegistry(envPath)), ["beta"])
  assert.match(readFileSync(envPath, "utf8"), /CHAIN_ID=1/)
  assert.equal(statSync(envPath).mode & 0o777, 0o600)
})

test("export merges the latest database group and import restores it", () => {
  const root = mkdtempSync(join(tmpdir(), "nfttool-wallet-roundtrip-"))
  const envPath = join(root, ".env")
  writeFileSync(envPath, "CHAIN_ID=1\n", { mode: 0o600 })
  importLocalWalletProfiles({ envPath, text: `alpha,旧分组,${KEY_ONE}` })

  const exported = exportLocalWalletProfiles({
    envPath,
    profileIds: ["alpha"],
    groupsById: { alpha: "  最新\n分组  " },
  })
  assert.match(exported, /# nfttool-group: 最新 分组/)
  removeLocalWalletProfiles({ envPath, profileIds: ["alpha"] })
  const restored = importLocalWalletProfiles({ envPath, text: exported })
  assert.equal(restored[0].group, "最新 分组")
  assert.equal(parseLocalWalletProfiles(readFileSync(envPath, "utf8")).profiles[0].group, "最新 分组")
})
