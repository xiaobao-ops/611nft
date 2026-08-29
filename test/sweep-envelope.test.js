import assert from "node:assert/strict"
import test from "node:test"
import {
  prepareSweepEnvelope,
  serializeSweepEnvelope,
  signSweepEnvelope,
  sweepEntryFromEnvelope,
} from "../server/sweep-envelope.js"

const ADDRESS = "0x1111111111111111111111111111111111111111"
const DESTINATION = "0x2222222222222222222222222222222222222222"
const NITRO_BALANCE = 62_019_276_000_000n
const NITRO_TRANSFER_GAS = 21_824n
const NITRO_GAS_PRICE = 68_757_600n
const BUFFERED_GAS = 28_372n
const BUFFERED_GAS_PRICE = 85_947_000n

function client(overrides = {}) {
  return {
    async getBalance() { return NITRO_BALANCE },
    async getTransactionCount({ blockTag }) { return blockTag === "latest" ? 7 : 8 },
    async estimateGas() { return NITRO_TRANSFER_GAS },
    async estimateFeesPerGas() { return { gasPrice: NITRO_GAS_PRICE } },
    ...overrides,
  }
}

test("legacy sweep uses max pending nonce and the buffered Nitro fee envelope", async () => {
  const estimates = []
  const result = await prepareSweepEnvelope({
    client: client({
      async getBalance({ blockTag }) {
        assert.equal(blockTag, "pending")
        return NITRO_BALANCE
      },
      async estimateGas(request) {
        estimates.push(request)
        return NITRO_TRANSFER_GAS
      },
    }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
    multiplierBps: 12_500n,
  })
  assert.equal(result.request.nonce, 8)
  assert.equal(result.latestNonce, 7)
  assert.equal(result.pendingNonce, 8)
  assert.equal(result.pendingGap, 1)
  assert.equal(result.request.gas, BUFFERED_GAS)
  assert.equal(result.request.gasPrice, BUFFERED_GAS_PRICE)
  assert.equal(result.request.value + result.request.gas * result.request.gasPrice, result.balance)
  assert.equal(result.valueWei, result.request.value.toString())
  assert.deepEqual(estimates.map((request) => request.value), [0n, result.request.value])
  assert.ok(estimates.every((request) => request.nonce === 8))
  assert.ok(estimates.every((request) => request.gasPrice === BUFFERED_GAS_PRICE))
  assert.ok(estimates.every((request) => request.blockTag === "pending" && request.prepare === false))
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.request), true)
})

test("the signer receives the exact frozen envelope and logs remain JSON serializable", async () => {
  const envelope = await prepareSweepEnvelope({
    client: client(),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
  })
  let signedRequest = null
  const serializedTransaction = await signSweepEnvelope({
    account: {
      async signTransaction(request) {
        signedRequest = request
        return "0x1234"
      },
    },
    envelope,
  })
  assert.equal(serializedTransaction, "0x1234")
  assert.strictEqual(signedRequest, envelope.request)

  const publicEnvelope = serializeSweepEnvelope(envelope)
  const entry = sweepEntryFromEnvelope({
    walletId: "source-1",
    to: DESTINATION,
    valueWei: "1",
    summary: "stale preview",
    sweep: true,
  }, publicEnvelope, {
    nativeSymbol: "ETH",
    formatAmount: (valueWei) => `amount:${valueWei}`,
  })
  assert.equal(publicEnvelope.request.gas, BUFFERED_GAS.toString())
  assert.equal(publicEnvelope.request.gasPrice, BUFFERED_GAS_PRICE.toString())
  assert.equal(publicEnvelope.request.nonce, 8)
  assert.equal(entry.plannedValueWei, "1")
  assert.equal(entry.valueWei, publicEnvelope.valueWei)
  assert.equal(entry.nonce, 8)
  assert.equal(entry.gas, BUFFERED_GAS.toString())
  assert.equal(entry.summary, `source-1 -> 0x2222...2222 amount:${publicEnvelope.valueWei} ETH`)
  assert.doesNotThrow(() => JSON.stringify({ envelope: publicEnvelope, entry }))
  assert.doesNotMatch(JSON.stringify({ envelope: publicEnvelope, entry }), /privateKey|account/i)
})

test("EIP-1559 sweep pads max fee while preserving a valid priority fee", async () => {
  const result = await prepareSweepEnvelope({
    client: client({
      async estimateFeesPerGas() { return { maxFeePerGas: 100n, maxPriorityFeePerGas: 3n } },
    }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 1,
    multiplierBps: 12_500n,
    keepReserveWei: 1000n,
  })
  assert.equal(result.request.type, "eip1559")
  assert.equal(result.request.maxFeePerGas, 125n)
  assert.equal(result.request.maxPriorityFeePerGas, 3n)
  assert.equal(result.request.value + 1000n + result.request.gas * result.request.maxFeePerGas, result.balance)
})

test("gas estimation failure rejects the sweep instead of using 21000", async () => {
  await assert.rejects(() => prepareSweepEnvelope({
    client: client({ async estimateGas() { throw new Error("execution reverted") } }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
  }), /gas|Gas|估算/)
})

test("a wallet that cannot cover reserve and fee is rejected", async () => {
  await assert.rejects(() => prepareSweepEnvelope({
    client: client({ async getBalance() { return 1n } }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
  }), /余额|balance/i)
})

test("latest wins when a lagging pending replica is behind", async () => {
  const result = await prepareSweepEnvelope({
    client: client({ async getTransactionCount({ blockTag }) { return blockTag === "latest" ? 9 : 8 } }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
  })
  assert.equal(result.request.nonce, 9)
  assert.equal(result.latestNonce, 9)
  assert.equal(result.pendingNonce, 8)
  assert.equal(result.pendingGap, 0)
})

test("a value-dependent Gas estimate that never converges fails closed", async () => {
  let gas = 20_000n
  await assert.rejects(() => prepareSweepEnvelope({
    client: client({
      async estimateGas() {
        gas += 10_000n
        return gas
      },
    }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
  }), /收敛/)
})

test("fee padding rounds upward instead of leaving a one-wei shortfall", async () => {
  const result = await prepareSweepEnvelope({
    client: client({
      async estimateFeesPerGas() { return { gasPrice: 3n } },
      async estimateGas() { return 1n },
    }),
    address: ADDRESS,
    to: DESTINATION,
    chainId: 4663,
    multiplierBps: 12_501n,
    gasLimitMultiplierBps: 10_001n,
  })
  assert.equal(result.request.gasPrice, 4n)
  assert.equal(result.request.gas, 2n)
  assert.equal(result.request.value + result.request.gas * result.request.gasPrice, result.balance)
})
