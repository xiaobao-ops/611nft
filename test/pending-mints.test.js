import assert from "node:assert/strict"
import test from "node:test"
import { encodeFunctionData } from "viem"
import {
  aggregatePendingMints,
  collectPendingTransactions,
  normalizePendingTransaction,
} from "../server/pending-mints.js"

const collection = "0x1111111111111111111111111111111111111111"
const router = "0x2222222222222222222222222222222222222222"

function hash(byte) {
  return `0x${byte.repeat(64)}`
}

function word(value) {
  const raw = String(value).startsWith("0x") ? String(value).slice(2) : BigInt(value).toString(16)
  return raw.padStart(64, "0")
}

function seaDropInput(quantity) {
  return `0x161ac21f${word(collection)}${word(router)}${word(router)}${word(quantity)}`
}

test("pending Mint aggregation sums token quantities and preserves unknown transactions", () => {
  const directInput = encodeFunctionData({
    abi: [{ type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] }],
    functionName: "mint",
    args: [3n],
  })
  const transactions = [
    normalizePendingTransaction({ hash: hash("1"), to: router, input: seaDropInput(5) }, "pending_block", 0),
    normalizePendingTransaction({ hash: hash("2"), to: collection, input: directInput }, "pending_block", 1),
    normalizePendingTransaction({ hash: hash("3"), to: collection, input: "0xabcdef12" }, "pending_block", 2),
  ]
  const result = aggregatePendingMints(transactions, new Set([collection]))
  assert.deepEqual(result.get(collection), {
    tokenCount: "8",
    unknownTxCount: 1,
    transactionCount: 3,
  })
})

test("pending sources merge by transaction hash and report observed coverage", async () => {
  const first = { hash: hash("a"), to: collection, input: seaDropInput(2) }
  const second = { hash: hash("b"), to: collection, input: seaDropInput(4) }
  const third = { hash: hash("c"), to: collection, input: seaDropInput(6) }
  const client = {
    async getBlock() { return { transactions: [first] } },
    async request() { return [first, second] },
  }
  const result = await collectPendingTransactions({
    client,
    blockscoutBase: "https://explorer.test",
    fetchImpl: async () => ({ ok: true, async json() { return { items: [second, third], next_page_params: null } } }),
  })
  assert.equal(result.coverage, "observed")
  assert.equal(result.transactions.length, 3)
  assert.deepEqual(result.sources.map((source) => [source.name, source.ok, source.count]), [
    ["pending_block", true, 1],
    ["rpc_pending", true, 2],
    ["blockscout", true, 2],
  ])
  assert.ok(result.sources.every((source) => source.lastSuccessAt))
})

test("hashless pending transactions deduplicate by stable transaction fields", async () => {
  const pending = {
    to: collection,
    from: router,
    nonce: "7",
    input: seaDropInput(2),
  }
  const client = {
    async getBlock() { return { transactions: [pending] } },
    async request() { return [{ ...pending }] },
  }
  const result = await collectPendingTransactions({ client })
  assert.equal(result.transactions.length, 1)
})

test("pending source failures remain unavailable instead of becoming zero", async () => {
  const result = await collectPendingTransactions({
    client: { async getBlock() { throw new Error("method unavailable") } },
  })
  assert.equal(result.coverage, "unavailable")
  assert.equal(result.transactions.length, 0)
  assert.equal(result.sources[0].ok, false)
})
