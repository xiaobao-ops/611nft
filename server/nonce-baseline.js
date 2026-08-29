// A writer can briefly report different latest and pending counts. Reusing either a mined
// nonce or one already held by the mempool can replace a live transaction, so the only safe
// baseline is the greater valid count. A suspicious gap is surfaced separately by
// pendingGap; it must be reconciled operationally rather than worked around by nonce reuse.
export function baseNonce({ latest, pending }) {
  const mined = countOf(latest)
  const queued = countOf(pending)
  if (mined === null) {
    if (queued === null) throw new Error("无法读取账户的交易序号")
    return queued
  }
  if (queued === null) return mined
  return Math.max(mined, queued)
}

// Number(null) and Number("") are both 0, which would silently pass an integer check and
// restart the account from nonce 0 — re-sending its entire history. Absent must stay absent.
function countOf(value) {
  if (value === null || value === undefined || value === "") return null
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 ? count : null
}

// How far ahead of the mined count the node claims to be. Surfaced so a stalled sequence
// is reported rather than silently worked around: a persistent gap means an earlier
// transaction is stuck and the operator may need to replace or cancel it.
export function pendingGap({ latest, pending }) {
  const mined = countOf(latest)
  const queued = countOf(pending)
  if (mined === null || queued === null) return 0
  return Math.max(0, queued - mined)
}
