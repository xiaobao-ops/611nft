// When a batch of transfers hits an error partway through, whether the rest may still be
// sent depends entirely on whether the failed entry consumed a nonce.
//
// Entries in a batch share one sender and one auto-incrementing nonce, so:
//   - a definite rejection (revert, insufficient funds, RPC refusal) never reached the
//     mempool, consumed no nonce, and leaves the remaining entries unaffected;
//   - an uncertain broadcast (timeout, aborted request) may or may not have landed. The
//     nonce state is unknown, so sending the next entry risks either replacing a live
//     transaction or leaving a gap that stalls the queue.
//
// Treating both as fatal is what silently reduced a 10-wallet disperse to a single
// executed transfer, with the eight untouched entries missing from the report entirely.

export function abortsRemaining({ mode, uncertain }) {
  return mode === "sequential" && Boolean(uncertain)
}

// Entries the run never reached must still be reported. Silence reads as "nothing else
// was meant to happen", which is exactly the wrong conclusion after an abort.
export function skippedEntries(entries, attemptedCount, reason) {
  return entries.slice(attemptedCount).map((entry) => ({
    ...entry,
    ok: false,
    status: "skipped",
    skipped: true,
    error: reason,
  }))
}

export const ABORT_REASON = "前一笔广播结果待确认，为避免 nonce 冲突已停止发送后续交易；确认该笔状态后可重新发起剩余部分"

// Nonces must be assigned from a single read, never left to the node per transaction.
//
// Asking for the pending nonce before each send looks reasonable but races: the previous
// transaction has not propagated yet, so every other request comes back with a stale
// value, the duplicate is rejected, and a disperse fails in a perfect alternating
// pattern — 6 of 11 succeeded, and they were exactly the odd-numbered wallets.
//
// Entries are grouped by sender because each wallet has its own nonce sequence.
export function assignNonces(entries, baseNonceByWallet) {
  const used = new Map()
  for (const entry of entries) {
    if (entry.nonce !== undefined && entry.nonce !== null && entry.nonce !== "") continue
    const base = baseNonceByWallet.get(entry.walletId)
    if (base === undefined) continue
    const offset = used.get(entry.walletId) || 0
    entry.nonce = Number(base) + offset
    used.set(entry.walletId, offset + 1)
  }
  return entries
}

export function sendersOf(entries) {
  return [...new Set(entries.map((entry) => entry.walletId))]
}
