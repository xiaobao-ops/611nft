import assert from "node:assert/strict"
import test from "node:test"
import { keccak256 } from "viem"
import { reconcileBroadcast, sendSignedTransaction } from "../server/broadcast-reconcile.js"

const SERIALIZED = "0x02f86c0180843b9aca0084773594008252089411111111111111111111111111111111111111110180c001a001a001"
const HASH = keccak256(SERIALIZED)
const ADDRESS = "0x2222222222222222222222222222222222222222"

test("a receipt proves that an uncertain raw broadcast was accepted", async () => {
  const result = await reconcileBroadcast({
    client: {
      async getTransactionReceipt({ hash }) { assert.equal(hash, HASH); return { status: "success" } },
      async getTransaction() { throw new Error("must not be called") },
      async getTransactionCount() { throw new Error("must not be called") },
    },
    hash: HASH,
    address: ADDRESS,
    nonce: 7,
  })
  assert.equal(result.status, "accepted")
  assert.equal(result.evidence, "receipt")
})

test("a transaction lookup proves acceptance before a receipt exists", async () => {
  const result = await reconcileBroadcast({
    client: {
      async getTransactionReceipt() { return null },
      async getTransaction() { return { hash: HASH, nonce: 7 } },
      async getTransactionCount() { throw new Error("must not be called") },
    },
    hash: HASH,
    address: ADDRESS,
    nonce: 7,
  })
  assert.equal(result.status, "accepted")
  assert.equal(result.evidence, "transaction")
})

test("a consumed nonce without the expected hash remains unknown", async () => {
  const result = await reconcileBroadcast({
    client: {
      async getTransactionReceipt() { throw new Error("not found") },
      async getTransaction() { throw new Error("not found") },
      async getTransactionCount({ blockTag }) { return blockTag === "latest" ? 8 : 9 },
    },
    hash: HASH,
    address: ADDRESS,
    nonce: 7,
  })
  assert.equal(result.status, "unknown")
  assert.equal(result.evidence, "nonce_consumed")
  assert.equal(result.latest, 8)
  assert.equal(result.pending, 9)
})

test("absence by hash and nonce is still unknown, never an invitation to resend", async () => {
  const result = await reconcileBroadcast({
    client: {
      async getTransactionReceipt() { return null },
      async getTransaction() { return null },
      async getTransactionCount() { return 7 },
    },
    hash: HASH,
    address: ADDRESS,
    nonce: 7,
  })
  assert.equal(result.status, "unknown")
  assert.equal(result.evidence, "not_visible")
})

test("a timeout is reconciled by deterministic hash without rebroadcasting", async () => {
  let sends = 0
  const result = await sendSignedTransaction({
    client: {
      async sendRawTransaction() { sends += 1; throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }) },
      async getTransactionReceipt() { return null },
      async getTransaction() { return { hash: HASH, nonce: 7 } },
      async getTransactionCount() { return 8 },
    },
    serializedTransaction: SERIALIZED,
    address: ADDRESS,
    nonce: 7,
    isUncertain: () => true,
  })
  assert.equal(sends, 1)
  assert.equal(result.txHash, HASH)
  assert.equal(result.reconciled, true)
})

test("an unresolved timeout carries the hash and blocks the sender", async () => {
  await assert.rejects(() => sendSignedTransaction({
    client: {
      async sendRawTransaction() { throw new Error("timeout") },
      async getTransactionReceipt() { return null },
      async getTransaction() { return null },
      async getTransactionCount() { return 7 },
    },
    serializedTransaction: SERIALIZED,
    address: ADDRESS,
    nonce: 7,
    isUncertain: () => true,
  }), (error) => error.code === "BROADCAST_UNCERTAIN" && error.txHash === HASH && error.reconciliation?.status === "unknown")
})
