import assert from "node:assert/strict"
import test from "node:test"
import { mapWithLimit } from "../server/concurrency.js"

// This bounds the broadcast path now, so its guarantees are load-bearing: exceeding the
// limit is what drove a 3-endpoint RPC pool into backoff and stalled a 40-wallet disperse.
test("never exceeds the limit, however many items there are", async () => {
  let inFlight = 0
  let peak = 0
  await mapWithLimit(Array.from({ length: 40 }, (_, index) => index), 8, async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight -= 1
  })
  assert.ok(peak <= 8, `peak ${peak} must not exceed 8`)
  assert.ok(peak > 1, "and it must actually run concurrently")
})

test("results stay in input order regardless of completion order", async () => {
  // Nonces are assigned by position, so a reordered result array would misreport which
  // wallet got which transaction.
  const output = await mapWithLimit([50, 10, 30, 5, 1], 3, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    return `${index}:${delay}`
  })
  assert.deepEqual(output, ["0:50", "1:10", "2:30", "3:5", "4:1"])
})

test("every item is visited exactly once", async () => {
  const seen = []
  await mapWithLimit(Array.from({ length: 25 }, (_, index) => index), 4, async (item) => { seen.push(item) })
  assert.equal(seen.length, 25)
  assert.equal(new Set(seen).size, 25)
})

test("an empty batch starts no workers and returns nothing", async () => {
  let calls = 0
  assert.deepEqual(await mapWithLimit([], 8, async () => { calls += 1 }), [])
  assert.equal(calls, 0)
})

test("a limit above the item count does not over-spawn", async () => {
  let peak = 0
  let inFlight = 0
  await mapWithLimit([1, 2, 3], 99, async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight -= 1
  })
  assert.equal(peak, 3)
})

test("a limit of one is fully sequential", async () => {
  const order = []
  await mapWithLimit([30, 1, 20], 1, async (delay, index) => {
    order.push(`start${index}`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    order.push(`end${index}`)
  })
  assert.deepEqual(order, ["start0", "end0", "start1", "end1", "start2", "end2"])
})

// The chain-specific send limit. This is a mempool property, not a tuning preference: an
// Arbitrum Nitro sequencer rejects any nonce but the account's immediate next one, so 40
// concurrent sends with contiguous nonces 152..191 landed exactly five (152-156) and had
// the other 35 rejected with "nonce too high".
test("Robinhood Chain sends strictly one at a time", async () => {
  const { burstConcurrencyFor } = await import("../server/burst-limit.js")
  assert.equal(burstConcurrencyFor(4663, {}), 1)
})

test("chains whose mempool queues ahead-of-nonce transactions stay concurrent", async () => {
  const { burstConcurrencyFor } = await import("../server/burst-limit.js")
  for (const chainId of [1, 56, 8453, 137, 42161]) {
    assert.ok(burstConcurrencyFor(chainId, {}) > 1, `chain ${chainId} may send concurrently`)
  }
})

test("an explicit override wins, including forcing a serial chain wider", async () => {
  const { burstConcurrencyFor } = await import("../server/burst-limit.js")
  assert.equal(burstConcurrencyFor(4663, { NFT_BURST_CONCURRENCY: "4" }), 4)
  assert.equal(burstConcurrencyFor(1, { NFT_BURST_CONCURRENCY: "1" }), 1)
})

test("a nonsensical override is ignored rather than producing a zero-width pool", async () => {
  const { burstConcurrencyFor } = await import("../server/burst-limit.js")
  // A limit of 0 would start no workers at all and silently send nothing.
  for (const value of ["0", "-3", "abc", ""]) {
    assert.ok(burstConcurrencyFor(4663, { NFT_BURST_CONCURRENCY: value }) >= 1, value)
  }
  assert.equal(burstConcurrencyFor(4663, { NFT_BURST_CONCURRENCY: "0" }), 1)
})
