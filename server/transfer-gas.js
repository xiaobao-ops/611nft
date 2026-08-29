import { mapWithLimit } from "./concurrency.js"

// A native transfer is not a fixed 21000 gas on every chain, and assuming it is silently
// breaks batches.
//
// Robinhood Chain (4663) is Arbitrum Nitro, which folds the L1 calldata cost of a
// transaction into its L2 gas limit. A plain ETH transfer there measures 21824 and drifts
// with Ethereum mainnet gas prices. A hardcoded 21000 is therefore not merely tight, it is
// below the intrinsic minimum: the node rejects the transaction before it reaches the
// mempool, so a 40-wallet disperse fails 40 times with "intrinsic gas too low" and lands
// nothing at all. Worse, the same code worked for months — while the folded L1 cost
// happened to sit under 21000 — which is exactly why this stayed hidden until L1 rose.
//
// So the limit is asked for, per chain, at plan time.
export const FALLBACK_NATIVE_TRANSFER_GAS = 21_000n

// Matches the buffer advanced-mint-service.js already applies to its estimates: the L1
// component of a Nitro estimate moves between planning and broadcasting, and a limit that
// is merely exact at plan time is a limit that is too low a block later.
const GAS_BUFFER_BPS = 13_000n
const BPS_SCALE = 10_000n

// Estimates are latency-bound RPC reads. The ceiling is low on purpose: this shares a read
// pool with everything else on the chain, and driving that pool into backoff turns a gas
// estimate into "All RPC upstreams are backing off", which fails the plan outright.
const ESTIMATE_CONCURRENCY = 4

export function bufferedGas(value) {
  const gas = BigInt(value)
  return ((gas * GAS_BUFFER_BPS) + BPS_SCALE - 1n) / BPS_SCALE
}

// Returns the buffered limit, or null when the chain could not be asked.
//
// null means "let the broadcast layer estimate", never "fall back to 21000": viem and the
// signer both estimate when no gas is supplied, and their estimate is correct for the
// chain, whereas a constant is what caused the failure this module exists to prevent.
export async function estimateTransferGas({ client, from, to, valueWei = "0", data = "0x" }) {
  try {
    const estimate = await client.estimateGas({
      account: from,
      to,
      value: BigInt(valueWei || "0"),
      data: data || "0x",
    })
    return { gas: bufferedGas(estimate), estimated: true }
  } catch (error) {
    return { gas: null, estimated: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// What makes two entries cost the same gas: the same sender, the same recipient code, and
// the same calldata. The recipient's *address* does not matter to the estimate unless it
// runs code, so a batch of plain transfers to 40 externally-owned accounts is one estimate,
// not forty.
//
// This is why grouping is worth the extra read: asking per entry meant 40 estimates for one
// disperse, which is what pushed the shared read pool into backoff and made the whole plan
// fail with "All RPC upstreams are backing off for chain 4663". Contract recipients still
// get their own estimate, so the accuracy that motivated per-entry estimation is kept.
async function shapeOf(client, entry) {
  try {
    const code = await client.getCode({ address: entry.to })
    // Empty code is an EOA; every EOA transfer with the same calldata costs the same.
    const plain = !code || code === "0x"
    return plain ? `eoa:${entry.data || "0x"}` : `code:${entry.to.toLowerCase()}:${entry.data || "0x"}`
  } catch {
    // If the recipient's code cannot be read, treat it as unique rather than assume it is
    // cheap: a wrong shared estimate under-funds it.
    return `unknown:${entry.to.toLowerCase()}:${entry.data || "0x"}`
  }
}

export async function assignTransferGas({ client, entries, addressOf }) {
  const shapes = await mapWithLimit(entries, ESTIMATE_CONCURRENCY, (entry) => shapeOf(client, entry))
  const groups = new Map()
  entries.forEach((entry, index) => {
    const key = `${entry.walletId}|${shapes[index]}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(index)
  })
  const keys = [...groups.keys()]
  const estimates = await mapWithLimit(keys, ESTIMATE_CONCURRENCY, (key) => {
    const entry = entries[groups.get(key)[0]]
    return estimateTransferGas({
      client,
      from: addressOf(entry.walletId),
      to: entry.to,
      valueWei: entry.valueWei,
      data: entry.data,
    })
  })
  const failures = []
  keys.forEach((key, position) => {
    const { gas, estimated, error } = estimates[position]
    for (const index of groups.get(key)) {
      const entry = entries[index]
      // A failed estimate leaves gas unset on purpose; see estimateTransferGas.
      if (estimated) entry.gas = gas.toString()
      else failures.push({ walletId: entry.walletId, to: entry.to, error })
    }
  })
  return failures
}
