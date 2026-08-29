// Collection ("sweep") entries move a wallet's whole spendable balance, which makes them
// the one case where the amount cannot be decided at plan time.
//
// A normal transfer names a fixed amount, so a gas price that drifts between planning and
// broadcasting only changes the fee. A sweep sets value = balance - reserve, leaving nothing
// spare by construction, so the same drift makes `gas * price + value` exceed the balance
// and the node refuses it. Observed on Robinhood Chain: the plan reserved a fee at
// gasPrice 50,960,544 with the default 1.25x cushion, the send needed 68,757,600 — 1.35x —
// and all 12 entries failed with "insufficient funds for gas * price + value", short by
// 0.000000138 ETH each.
//
// Raising the multiplier only moves the threshold; the drift is unbounded and, on a Nitro
// chain, driven by L1 prices nobody here controls. So the value is recomputed against the
// balance and gas price that are true at the moment of sending.

// The amount a sweep should send, given what is true now.
//
// Returns null when the wallet cannot cover its own fee — the entry is then unsendable and
// must be reported rather than attempted, because a sweep of zero is not a transfer.
export function sweepValueWei({ balanceWei, gasLimit, gasPriceWei, keepReserveWei = 0n, multiplierBps = 12_500n }) {
  const balance = BigInt(balanceWei)
  const keep = BigInt(keepReserveWei)
  // The fee is withheld at the multiplier so a further rise between this read and the node's
  // own check still fits. Ceiling division: withholding one wei too few is what fails.
  const fee = (BigInt(gasLimit) * BigInt(gasPriceWei) * BigInt(multiplierBps) + 9_999n) / 10_000n
  const value = balance - keep - fee
  return value > 0n ? value : null
}

// Whether the node will accept it: the real cost uses the actual gas price, not the padded
// reserve, so a correct value leaves the difference behind as change.
export function sweepFits({ balanceWei, valueWei, gasLimit, gasPriceWei }) {
  return BigInt(valueWei) + BigInt(gasLimit) * BigInt(gasPriceWei) <= BigInt(balanceWei)
}
