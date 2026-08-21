import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { createCollectionFlagStore, migrateCollectionFlags } from "../server/collection-flags.js"

const mixed = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
const lower = mixed.toLowerCase()

function fixture() {
  const db = new DatabaseSync(":memory:")
  migrateCollectionFlags(db)
  let now = Date.parse("2026-08-17T00:00:00.000Z")
  return {
    store: createCollectionFlagStore({ db, now: () => now }),
    advance() { now += 1000 },
  }
}

test("collection flags upsert case-insensitively and preserve notes", () => {
  const { store, advance } = fixture()
  const first = store.upsert({ chainId: 1, address: mixed, flag: "scam", note: "个人风险记录" })
  assert.equal(first.address, lower)
  assert.equal(first.flag, "scam")
  advance()
  const second = store.upsert({ chainId: 1, address: lower, flag: "blocked", note: "停止跟单" })
  assert.equal(second.flag, "blocked")
  assert.equal(second.note, "停止跟单")
  assert.equal(store.list({ chainId: 1 }).flags.length, 1)
})

test("collection flags isolate chains and remove exact records", () => {
  const { store } = fixture()
  store.upsert({ chainId: 1, address: mixed, flag: "scam" })
  store.upsert({ chainId: 2, address: mixed, flag: "watch" })
  assert.equal(store.get(1, mixed).flag, "scam")
  assert.equal(store.get(2, mixed).flag, "watch")
  assert.equal(store.remove(1, mixed), true)
  assert.equal(store.remove(1, mixed), false)
  assert.equal(store.get(2, mixed).flag, "watch")
})

test("collection flags validate chain, address, flag and note length", () => {
  const { store } = fixture()
  assert.throws(() => store.upsert({ chainId: 0, address: mixed, flag: "scam" }), /链编号/)
  assert.throws(() => store.upsert({ chainId: 1, address: "0x123", flag: "scam" }), /地址/)
  assert.throws(() => store.upsert({ chainId: 1, address: mixed, flag: "unknown" }), /标记/)
  assert.throws(() => store.upsert({ chainId: 1, address: mixed, flag: "scam", note: "x".repeat(501) }), /备注/)
})
