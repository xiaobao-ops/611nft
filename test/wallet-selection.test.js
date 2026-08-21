import assert from "node:assert/strict"
import test from "node:test"
import {
  SELECTED_WALLETS_KEY,
  groupWallets,
  normalizeWalletGroup,
  readStoredWalletIds,
  reconcileWalletIds,
  toggleWalletGroup,
  walletGroupSelection,
  writeStoredWalletIds,
} from "../src/wallet-selection.js"

const wallets = [
  { id: "a", group: " 主组\n" },
  { id: "b", group: "主组" },
  { id: "c", group: "备用" },
  { id: "d", group: "" },
  { id: "e", group: " \t " },
  { id: "a", group: "重复记录" },
]

test("wallet groups normalize, sort and expose ungrouped wallets", () => {
  assert.deepEqual(groupWallets(wallets), [
    { key: "备用", label: "备用", walletIds: ["c"] },
    { key: "主组", label: "主组", walletIds: ["a", "b"] },
    { key: "", label: "未分组", walletIds: ["d", "e"] },
  ])
  assert.equal(normalizeWalletGroup(`  alpha\n${"x".repeat(90)}\u0000  `), `alpha ${"x".repeat(74)}`)
})

test("wallet groups exclude blocked wallets and ignore duplicate ids", () => {
  assert.deepEqual(groupWallets(wallets, { excludedIds: ["b", "d", "d"] }), [
    { key: "备用", label: "备用", walletIds: ["c"] },
    { key: "主组", label: "主组", walletIds: ["a"] },
    { key: "", label: "未分组", walletIds: ["e"] },
  ])
})

test("group toggles overlay other groups and report partial selection", () => {
  const selected = toggleWalletGroup(["c", "c", "a"], ["a", "b", "b"])
  assert.deepEqual(selected, ["c", "a", "b"])
  assert.deepEqual(walletGroupSelection(selected, ["a", "b"]), {
    selectedCount: 2,
    total: 2,
    complete: true,
    partial: false,
  })
  assert.deepEqual(toggleWalletGroup(selected, ["a", "b"]), ["c"])
  assert.equal(walletGroupSelection(["a"], ["a", "b"]).partial, true)
})

test("stored selection shares one key and prunes deleted wallet ids", () => {
  const values = new Map([[SELECTED_WALLETS_KEY, JSON.stringify(["a", "missing", "a", 7])]])
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.deepEqual(readStoredWalletIds(storage), ["a", "missing", "7"])
  const valid = reconcileWalletIds(readStoredWalletIds(storage), [{ id: "a" }, { id: "7" }])
  assert.deepEqual(writeStoredWalletIds(valid, storage), ["a", "7"])
  assert.equal(values.get(SELECTED_WALLETS_KEY), '["a","7"]')
})
