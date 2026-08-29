import assert from "node:assert/strict"
import test from "node:test"
import { sweepFits, sweepValueWei } from "../server/sweep-amount.js"

// The numbers from the failure, taken from the node's own rejection:
// "insufficient funds for gas * price + value: have 62019276000000 want 62157329916000".
const BALANCE = 62_019_276_000_000n
const GAS = 27_300n
const PLAN_PRICE = 50_960_544n   // what getGasPrice returned when the preview was built
const SEND_PRICE = 68_757_600n   // what the node actually required a minute later

test("a value computed at plan time no longer fits once the gas price rises", () => {
  // This is the bug: the preview's value was balance - (plan price x gas x 1.25), which
  // leaves nothing spare, so a 1.35x rise put the total over the balance.
  const planned = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: PLAN_PRICE })
  assert.equal(sweepFits({ balanceWei: BALANCE, valueWei: planned, gasLimit: GAS, gasPriceWei: PLAN_PRICE }), true)
  assert.equal(
    sweepFits({ balanceWei: BALANCE, valueWei: planned, gasLimit: GAS, gasPriceWei: SEND_PRICE }),
    false,
    "the planned value is exactly what the node refused",
  )
})

test("recomputing at the send price makes it fit", () => {
  const value = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE })
  assert.ok(value > 0n)
  assert.equal(sweepFits({ balanceWei: BALANCE, valueWei: value, gasLimit: GAS, gasPriceWei: SEND_PRICE }), true)
})

test("the cushion absorbs a further rise between the read and the node's own check", () => {
  // Recomputing alone is not enough: the price can move again in the moments after. The
  // 1.25x default has to leave real headroom, not just cover the price it just read.
  const value = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE })
  const risen = SEND_PRICE * 12n / 10n
  assert.equal(sweepFits({ balanceWei: BALANCE, valueWei: value, gasLimit: GAS, gasPriceWei: risen }), true)
})

test("a rise beyond the cushion is refused rather than sent and rejected", () => {
  const value = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE })
  const spike = SEND_PRICE * 2n
  assert.equal(sweepFits({ balanceWei: BALANCE, valueWei: value, gasLimit: GAS, gasPriceWei: spike }), false)
})

test("the fee is rounded up, because withholding one wei too few is what fails", () => {
  // An exact-division cushion would truncate and leave the value one wei too high.
  const value = sweepValueWei({ balanceWei: 1_000_000n, gasLimit: 3n, gasPriceWei: 7n, multiplierBps: 12_501n })
  const fee = 1_000_000n - value
  assert.ok(fee * 10_000n >= 3n * 7n * 12_501n, "the withheld fee must cover the ceiling, not the floor")
})

test("an explicit keep-reserve is withheld on top of the fee", () => {
  const keep = 1_000_000_000n
  const withKeep = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE, keepReserveWei: keep })
  const without = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE })
  assert.equal(without - withKeep, keep)
})

test("a wallet that cannot cover its own fee yields null, not a zero-value transfer", () => {
  // Sweeping zero is not a transfer; the entry has to be reported as unsendable.
  assert.equal(sweepValueWei({ balanceWei: 1n, gasLimit: GAS, gasPriceWei: SEND_PRICE }), null)
  assert.equal(sweepValueWei({ balanceWei: 0n, gasLimit: GAS, gasPriceWei: SEND_PRICE }), null)
})

test("a balance exactly equal to the fee yields null rather than zero", () => {
  const fee = (GAS * SEND_PRICE * 12_500n + 9_999n) / 10_000n
  assert.equal(sweepValueWei({ balanceWei: fee, gasLimit: GAS, gasPriceWei: SEND_PRICE }), null)
  assert.ok(sweepValueWei({ balanceWei: fee + 1n, gasLimit: GAS, gasPriceWei: SEND_PRICE }) > 0n)
})

test("a keep-reserve larger than the balance yields null", () => {
  assert.equal(sweepValueWei({ balanceWei: 1000n, gasLimit: 1n, gasPriceWei: 1n, keepReserveWei: 5000n }), null)
})

test("string inputs from a serialized plan are accepted", () => {
  // Entries round-trip through JSON in params_json, so every number arrives as a string.
  const value = sweepValueWei({
    balanceWei: String(BALANCE),
    gasLimit: "27300",
    gasPriceWei: String(SEND_PRICE),
    keepReserveWei: "0",
    multiplierBps: "12500",
  })
  assert.equal(value, sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE }))
})

test("a multiplier of exactly 1x still fits at the price it was computed for", () => {
  const value = sweepValueWei({ balanceWei: BALANCE, gasLimit: GAS, gasPriceWei: SEND_PRICE, multiplierBps: 10_000n })
  assert.equal(sweepFits({ balanceWei: BALANCE, valueWei: value, gasLimit: GAS, gasPriceWei: SEND_PRICE }), true)
  // But it leaves no headroom at all, which is why the default is higher.
  assert.equal(sweepFits({ balanceWei: BALANCE, valueWei: value, gasLimit: GAS, gasPriceWei: SEND_PRICE + 1n }), false)
})
