import assert from "node:assert/strict"
import test from "node:test"
import {
  assignTransferGas,
  bufferedGas,
  estimateTransferGas,
  FALLBACK_NATIVE_TRANSFER_GAS,
} from "../server/transfer-gas.js"

// The number Robinhood Chain (Arbitrum Nitro, chainId 4663) actually reported for a plain
// ETH transfer when a 40-wallet disperse failed 40 times: 21824 > 21000, so every entry was
// rejected with "intrinsic gas too low" before it reached the mempool.
const NITRO_TRANSFER_GAS = 21_824n
const SENDER = `0x${"66".repeat(20)}`
const RECIPIENT = `0x${"52".repeat(20)}`

function clientReturning(gas) {
  return { async estimateGas() { return gas } }
}

function clientRejecting(message) {
  return { async estimateGas() { throw new Error(message) } }
}

test("a Nitro chain's transfer limit exceeds 21000, so the old constant was below the minimum", async () => {
  // This is the regression itself. Had the plan asked the chain instead of assuming, the
  // limit would have cleared the intrinsic minimum by a wide margin.
  const { gas, estimated } = await estimateTransferGas({
    client: clientReturning(NITRO_TRANSFER_GAS),
    from: SENDER,
    to: RECIPIENT,
    valueWei: "100000000000000",
  })
  assert.equal(estimated, true)
  assert.ok(gas > FALLBACK_NATIVE_TRANSFER_GAS, `${gas} must exceed the old hardcoded 21000`)
  assert.ok(gas > NITRO_TRANSFER_GAS, "the estimate must be buffered, not used raw")
})

test("the buffer is 30% and always rounds up, never down to a limit that just barely failed", () => {
  assert.equal(bufferedGas(21_824n), 28_372n)
  assert.equal(bufferedGas(21_000n), 27_300n)
  // Rounding down at any point would reintroduce a limit that is exact-at-best.
  assert.equal(bufferedGas(1n), 2n)
  assert.equal(bufferedGas(3n), 4n)
})

test("the estimate is passed the real value and calldata, so a contract recipient is measured correctly", async () => {
  const seen = []
  const client = { async estimateGas(args) { seen.push(args); return 55_000n } }
  await estimateTransferGas({ client, from: SENDER, to: RECIPIENT, valueWei: "12345", data: "0xabcd" })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { account: SENDER, to: RECIPIENT, value: 12_345n, data: "0xabcd" })
})

test("a missing value or calldata is normalized rather than passed through as undefined", async () => {
  const seen = []
  const client = { async estimateGas(args) { seen.push(args); return 21_000n } }
  await estimateTransferGas({ client, from: SENDER, to: RECIPIENT })
  assert.equal(seen[0].value, 0n)
  assert.equal(seen[0].data, "0x")
})

test("a failed estimate yields no limit at all, so the broadcast layer estimates instead", async () => {
  // Returning 21000 as a fallback here would recreate the exact failure: on the chain where
  // estimation is flaky, 21000 is also the number that gets rejected. Absent gas makes
  // viem and the signer estimate at send time, which is correct for the chain.
  const { gas, estimated, error } = await estimateTransferGas({
    client: clientRejecting("execution reverted"),
    from: SENDER,
    to: RECIPIENT,
  })
  assert.equal(gas, null)
  assert.equal(estimated, false)
  assert.match(error, /execution reverted/)
})

test("every disperse entry gets its own measured limit, above the old constant", async () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    walletId: "rh1",
    to: `0x${String(index).padStart(40, "0")}`,
    valueWei: "100000000000000",
    data: "0x",
  }))
  const warnings = await assignTransferGas({
    client: clientReturning(NITRO_TRANSFER_GAS),
    entries,
    addressOf: () => SENDER,
  })
  assert.deepEqual(warnings, [])
  assert.equal(entries.length, 40)
  // The original symptom was 40 of 40 failing. Every entry must now carry a limit that
  // clears the intrinsic minimum.
  assert.ok(entries.every((entry) => BigInt(entry.gas) > NITRO_TRANSFER_GAS), "all 40 entries need a buffered limit")
  assert.ok(entries.every((entry) => BigInt(entry.gas) > FALLBACK_NATIVE_TRANSFER_GAS))
})

test("a contract recipient is not given the cheaper limit measured for an EOA", async () => {
  // One sample reused across the batch would under-fund exactly the entry that needs most.
  const eoa = `0x${"aa".repeat(20)}`
  const contract = `0x${"bb".repeat(20)}`
  const client = {
    async estimateGas({ to }) { return to === contract ? 90_000n : 21_824n },
  }
  const entries = [
    { walletId: "w1", to: eoa, valueWei: "1", data: "0x" },
    { walletId: "w1", to: contract, valueWei: "1", data: "0x" },
  ]
  await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.equal(entries[0].gas, bufferedGas(21_824n).toString())
  assert.equal(entries[1].gas, bufferedGas(90_000n).toString())
  assert.ok(BigInt(entries[1].gas) > BigInt(entries[0].gas))
})

test("one unestimable entry is reported without stripping the limits off the others", async () => {
  const bad = `0x${"cc".repeat(20)}`
  const client = {
    async estimateGas({ to }) {
      if (to === bad) throw new Error("intrinsic gas too low")
      return 21_824n
    },
  }
  const entries = [
    { walletId: "w1", to: RECIPIENT, valueWei: "1", data: "0x" },
    { walletId: "w2", to: bad, valueWei: "1", data: "0x" },
    { walletId: "w3", to: RECIPIENT, valueWei: "1", data: "0x" },
  ]
  const warnings = await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].walletId, "w2")
  assert.match(warnings[0].error, /intrinsic gas too low/)
  // The failure must stay local: the other two keep their measured limits, and the failed
  // one carries no gas so the broadcast layer estimates it.
  assert.equal(entries[0].gas, bufferedGas(21_824n).toString())
  assert.equal(entries[2].gas, bufferedGas(21_824n).toString())
  assert.equal(entries[1].gas, undefined)
})

test("an entry that already carries a limit is re-measured, not trusted", async () => {
  // A plan replayed from a stale confirmation could carry the old 21000. Nothing should
  // preserve it.
  const entries = [{ walletId: "w1", to: RECIPIENT, valueWei: "1", data: "0x", gas: "21000" }]
  await assignTransferGas({ client: clientReturning(NITRO_TRANSFER_GAS), entries, addressOf: () => SENDER })
  assert.notEqual(entries[0].gas, "21000")
  assert.ok(BigInt(entries[0].gas) > FALLBACK_NATIVE_TRANSFER_GAS)
})

test("an empty batch asks the chain nothing", async () => {
  let calls = 0
  const client = { async estimateGas() { calls += 1; return 21_000n } }
  assert.deepEqual(await assignTransferGas({ client, entries: [], addressOf: () => SENDER }), [])
  assert.equal(calls, 0)
})

test("the sender address for each estimate comes from that entry's own wallet", async () => {
  // Collection estimates from many different senders; using one address for all of them
  // would measure the wrong account's transfer.
  const seen = []
  const client = { async estimateGas({ account }) { seen.push(account); return 21_000n } }
  const addresses = { w1: `0x${"11".repeat(20)}`, w2: `0x${"22".repeat(20)}` }
  await assignTransferGas({
    client,
    entries: [{ walletId: "w1", to: RECIPIENT }, { walletId: "w2", to: RECIPIENT }],
    addressOf: (walletId) => addresses[walletId],
  })
  assert.deepEqual(seen.sort(), [addresses.w1, addresses.w2].sort())
})

// A client that can report recipient code, so entries can be grouped by what they cost.
function shapedClient({ contracts = [], onEstimate } = {}) {
  const code = new Set(contracts.map((address) => address.toLowerCase()))
  let estimates = 0
  return {
    client: {
      async getCode({ address }) { return code.has(address.toLowerCase()) ? "0x60006000" : "0x" },
      async estimateGas(args) {
        estimates += 1
        onEstimate?.(args)
        return code.has(String(args.to).toLowerCase()) ? 90_000n : NITRO_TRANSFER_GAS
      },
    },
    estimateCount: () => estimates,
  }
}

test("40 plain transfers cost one estimate, not forty", async () => {
  // Asking per entry is what pushed the shared read pool into backoff: the plan then failed
  // outright with "All RPC upstreams are backing off for chain 4663".
  const entries = Array.from({ length: 40 }, (_, index) => ({
    walletId: "rh1",
    to: `0x${String(index + 1).padStart(40, "0")}`,
    valueWei: "100000000000000",
    data: "0x",
  }))
  const { client, estimateCount } = shapedClient()
  const warnings = await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.deepEqual(warnings, [])
  assert.equal(estimateCount(), 1, "identical EOA transfers share one estimate")
  assert.ok(entries.every((entry) => BigInt(entry.gas) > FALLBACK_NATIVE_TRANSFER_GAS))
  assert.equal(new Set(entries.map((entry) => entry.gas)).size, 1)
})

test("a contract recipient still gets its own estimate, not the EOA one", async () => {
  // The accuracy that motivated per-entry estimation must survive the grouping.
  const contract = `0x${"bb".repeat(20)}`
  const entries = [
    { walletId: "w1", to: `0x${"aa".repeat(20)}`, valueWei: "1", data: "0x" },
    { walletId: "w1", to: contract, valueWei: "1", data: "0x" },
    { walletId: "w1", to: `0x${"cc".repeat(20)}`, valueWei: "1", data: "0x" },
  ]
  const { client, estimateCount } = shapedClient({ contracts: [contract] })
  await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.equal(estimateCount(), 2, "one for the EOAs, one for the contract")
  assert.equal(entries[0].gas, entries[2].gas)
  assert.ok(BigInt(entries[1].gas) > BigInt(entries[0].gas))
})

test("entries from different senders are never merged", async () => {
  // Gas can differ by sender, so grouping must key on the wallet too.
  const seen = []
  const addresses = { w1: `0x${"11".repeat(20)}`, w2: `0x${"22".repeat(20)}` }
  const { client, estimateCount } = shapedClient({ onEstimate: (args) => seen.push(args.account) })
  const entries = [
    { walletId: "w1", to: RECIPIENT, valueWei: "1", data: "0x" },
    { walletId: "w2", to: RECIPIENT, valueWei: "1", data: "0x" },
  ]
  await assignTransferGas({ client, entries, addressOf: (id) => addresses[id] })
  assert.equal(estimateCount(), 2)
  assert.deepEqual(seen.sort(), [addresses.w1, addresses.w2].sort())
})

test("entries with different calldata are not merged", async () => {
  const { client, estimateCount } = shapedClient()
  const entries = [
    { walletId: "w1", to: RECIPIENT, valueWei: "1", data: "0x" },
    { walletId: "w1", to: RECIPIENT, valueWei: "1", data: "0xdeadbeef" },
  ]
  await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.equal(estimateCount(), 2)
})

test("a shared estimate that fails is reported for every entry that needed it", async () => {
  const client = {
    async getCode() { return "0x" },
    async estimateGas() { throw new Error("All RPC upstreams are backing off for chain 4663") },
  }
  const entries = Array.from({ length: 3 }, (_, index) => ({
    walletId: "w1",
    to: `0x${String(index + 1).padStart(40, "0")}`,
    valueWei: "1",
    data: "0x",
  }))
  const warnings = await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.equal(warnings.length, 3, "no entry may be left silently unmeasured")
  assert.ok(entries.every((entry) => entry.gas === undefined))
  assert.match(warnings[0].error, /backing off/)
})

test("an unreadable recipient falls back to its own estimate rather than a shared one", async () => {
  // If getCode fails we cannot know the recipient is cheap; assuming it is under-funds it.
  let estimates = 0
  const client = {
    async getCode() { throw new Error("upstream error") },
    async estimateGas() { estimates += 1; return NITRO_TRANSFER_GAS },
  }
  const entries = [
    { walletId: "w1", to: `0x${"aa".repeat(20)}`, valueWei: "1", data: "0x" },
    { walletId: "w1", to: `0x${"bb".repeat(20)}`, valueWei: "1", data: "0x" },
  ]
  await assignTransferGas({ client, entries, addressOf: () => SENDER })
  assert.equal(estimates, 2, "each unknown recipient is measured separately")
})
