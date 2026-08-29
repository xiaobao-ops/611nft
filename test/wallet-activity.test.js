import assert from "node:assert/strict"
import test from "node:test"
import { createWalletActivityMonitor } from "../server/wallet-activity.js"

const ADDRESS_A = "0x1111111111111111111111111111111111111111"
const ADDRESS_B = "0x2222222222222222222222222222222222222222"
const ADDRESS_C = "0x3333333333333333333333333333333333333333"

function hash(value) {
  return `0x${value.toString(16).padStart(64, "0")}`
}

test("wallet activity skips RPC reads when no enabled address is watched", async () => {
  let reads = 0
  const monitor = createWalletActivityMonitor({
    getClient: () => ({ async getBlock() { reads += 1 } }),
    getWatchedAddresses: () => [],
  })

  assert.deepEqual(await monitor.observeHead(1, 10n), [])
  assert.equal(reads, 0)
  assert.equal(monitor.status(1).state, "idle")
  monitor.stop()
})

test("wallet activity emits matching from and to transactions once", async () => {
  const activities = []
  const monitor = createWalletActivityMonitor({
    getClient: () => ({
      async getBlock({ blockNumber, includeTransactions }) {
        assert.equal(blockNumber, 20n)
        assert.equal(includeTransactions, true)
        return {
          number: 20n,
          hash: hash(200),
          timestamp: 1_700_000_000n,
          transactions: [
            { hash: hash(1), from: ADDRESS_A.toUpperCase().replace("0X", "0x"), to: ADDRESS_B, value: 7n },
            { hash: hash(2), from: ADDRESS_C, to: ADDRESS_A, value: 9n },
            { hash: hash(3), from: ADDRESS_B, to: ADDRESS_C, value: 11n },
            hash(4),
          ],
        }
      },
    }),
    getWatchedAddresses: () => [ADDRESS_A],
    onActivity: (activity) => activities.push(activity),
  })

  const first = await monitor.observeHead(1, 20n)
  const repeated = await monitor.observeHead(1, 20n)
  assert.equal(first.length, 2)
  assert.deepEqual(repeated, [])
  assert.deepEqual(activities.map((item) => item.id), [hash(1), hash(2)])
  assert.equal(activities[0].type, "wallet_activity")
  assert.equal(activities[0].valueWei, "7")
  assert.equal(activities[0].blockNumber, "20")
  assert.equal(activities[0].timestamp, 1_700_000_000)
  assert.equal(monitor.status(1).matchedTransactions, 2)
  monitor.stop()
})

test("wallet activity closes small head gaps without duplicate block reads", async () => {
  const blocks = []
  const monitor = createWalletActivityMonitor({
    getClient: () => ({
      async getBlock({ blockNumber }) {
        blocks.push(blockNumber)
        return { number: blockNumber, hash: hash(Number(blockNumber)), timestamp: blockNumber, transactions: [] }
      },
    }),
    getWatchedAddresses: () => [ADDRESS_A],
  })

  await monitor.observeHead(1, 30n)
  await monitor.observeHead(1, 33n)
  assert.deepEqual(blocks, [30n, 31n, 32n, 33n])
  assert.equal(monitor.status(1).lastObservedBlock, "33")
  monitor.stop()
})

test("wallet activity reports sanitized observation failures and can stop", async () => {
  const monitor = createWalletActivityMonitor({
    getClient: () => ({ async getBlock() { throw new Error("RPC unavailable") } }),
    getWatchedAddresses: () => [ADDRESS_A],
  })

  await assert.rejects(monitor.observeHead(1, 40n), /RPC unavailable/)
  assert.equal(monitor.status(1).state, "degraded")
  assert.equal(monitor.status(1).lastError, "RPC unavailable")
  monitor.stop()
  assert.deepEqual(await monitor.observeHead(1, 41n), [])
  assert.equal(monitor.status(1).state, "stopped")
})
