import { keccak256 } from "viem"

async function optionalRead(read) {
  try {
    return await read()
  } catch {
    return null
  }
}

export async function reconcileBroadcast({ client, hash, address, nonce }) {
  const receipt = await optionalRead(() => client.getTransactionReceipt({ hash }))
  if (receipt) return { status: "accepted", evidence: "receipt", hash, receipt }

  const transaction = await optionalRead(() => client.getTransaction({ hash }))
  if (transaction) return { status: "accepted", evidence: "transaction", hash, transaction }

  const [latest, pending] = await Promise.all([
    optionalRead(() => client.getTransactionCount({ address, blockTag: "latest" })),
    optionalRead(() => client.getTransactionCount({ address, blockTag: "pending" })),
  ])
  const numeric = [latest, pending]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0)
  const observed = numeric.length ? Math.max(...numeric) : null
  return {
    status: "unknown",
    evidence: observed !== null && observed > Number(nonce) ? "nonce_consumed" : "not_visible",
    hash,
    latest: latest === null ? null : Number(latest),
    pending: pending === null ? null : Number(pending),
  }
}

export async function sendSignedTransaction({
  client,
  serializedTransaction,
  address,
  nonce,
  isUncertain,
}) {
  const txHash = keccak256(serializedTransaction)
  try {
    const returnedHash = await client.sendRawTransaction({ serializedTransaction })
    return { txHash: returnedHash || txHash, reconciled: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/already known|known transaction|transaction already imported/i.test(message)) {
      return { txHash, reconciled: true, reconciliation: { status: "accepted", evidence: "already_known", hash: txHash } }
    }
    if (!isUncertain(error)) throw error
    const reconciliation = await reconcileBroadcast({ client, hash: txHash, address, nonce })
    if (reconciliation.status === "accepted") {
      return { txHash, reconciled: true, reconciliation }
    }
    const unresolved = new Error(`广播结果仍无法确认：${txHash}`, { cause: error })
    unresolved.code = "BROADCAST_UNCERTAIN"
    unresolved.broadcastUncertain = true
    unresolved.txHash = txHash
    unresolved.reconciliation = reconciliation
    throw unresolved
  }
}
