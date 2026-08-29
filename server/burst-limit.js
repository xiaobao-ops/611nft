// How many sends of one batch may be in flight at once, per chain.
//
// This is a property of the chain's mempool, not a tuning knob. A go-ethereum node queues a
// transaction whose nonce is ahead of the account's next one and releases it when the gap
// fills, so concurrent sends are fine there. An Arbitrum Nitro sequencer does not queue: it
// rejects anything but the immediate next nonce outright with "nonce too high".
//
// Measured on Robinhood Chain (4663, Nitro): of 40 concurrent sends carrying contiguous
// nonces 152..191, exactly the first five landed — 152, 153, 154, 155, 156 — and all 35
// behind them were rejected. Not a load problem; the sequencer will not hold nonce 157 while
// 156 is still in flight. That chain must therefore send strictly one at a time.
const BY_CHAIN = { 4663: 1 }
const DEFAULT = 8

export function burstConcurrencyFor(chainId, env = process.env) {
  const override = Number(env.NFT_BURST_CONCURRENCY)
  // A zero or negative override would start no workers and silently send nothing.
  if (Number.isInteger(override) && override > 0) return override
  return BY_CHAIN[Number(chainId)] ?? DEFAULT
}
