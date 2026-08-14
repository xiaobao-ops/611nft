import assert from "node:assert/strict"
import test from "node:test"
import {
  chainStorageKey,
  parseStoredChainId,
  readStoredChainId,
  resolveSupportedChainId,
  saveStoredChainId,
} from "../src/chain-preference.js"

const chains = [{ id: 1 }, { id: 4663 }, { id: 8453 }]

test("stored supported chain survives a page reload", () => {
  const values = new Map([[chainStorageKey, "4663"]])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }

  const restored = readStoredChainId(storage)
  assert.equal(resolveSupportedChainId(restored, chains), 4663)
  saveStoredChainId(8453, storage)
  assert.equal(readStoredChainId(storage), 8453)
})

test("invalid or removed chain preferences fall back safely", () => {
  assert.equal(parseStoredChainId("not-a-chain"), 1)
  assert.equal(parseStoredChainId("-1"), 1)
  assert.equal(resolveSupportedChainId(999999, chains), 1)
  assert.equal(resolveSupportedChainId(999999, [{ id: 10 }, { id: 137 }]), 10)
})

test("unavailable browser storage does not break startup", () => {
  const blockedStorage = {
    getItem() { throw new Error("blocked") },
    setItem() { throw new Error("blocked") },
  }
  assert.equal(readStoredChainId(blockedStorage), 1)
  assert.doesNotThrow(() => saveStoredChainId(4663, blockedStorage))
})
