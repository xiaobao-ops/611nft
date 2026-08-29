const HEX_TX = /^0x[0-9a-f]{64}$/i
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/i

function text(value) {
  return value === null || value === undefined ? "" : String(value)
}

function numberText(value) {
  if (value === null || value === undefined || value === "") return null
  try { return BigInt(value).toString() } catch { return String(value) }
}

export function canonicalChainId(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function canonicalAddress(value) {
  const normalized = text(value).toLowerCase()
  return HEX_ADDRESS.test(normalized) ? normalized : ""
}

export function canonicalTxHash(value) {
  const normalized = text(value).toLowerCase()
  return HEX_TX.test(normalized) ? normalized : ""
}

export function canonicalDedupeKey(event = {}) {
  const chainId = canonicalChainId(event.chainId ?? event.chain_id) || 0
  const txHash = canonicalTxHash(event.txHash ?? event.tx_hash) || text(event.txHash ?? event.tx_hash).toLowerCase()
  const contract = canonicalAddress(event.contract ?? event.address) || text(event.contract ?? event.address).toLowerCase()
  const logIndex = numberText(event.logIndex ?? event.log_index)
  if (logIndex !== null && logIndex !== "") return `${chainId}:${txHash}:${contract}:${logIndex}`
  return `${chainId}:${txHash}:${contract}`
}

export function canonicalEventId(event = {}) {
  if (text(event.eventId ?? event.event_id)) return text(event.eventId ?? event.event_id)
  const txHash = canonicalTxHash(event.txHash ?? event.tx_hash)
  const contract = canonicalAddress(event.contract ?? event.address)
  return txHash && contract ? canonicalDedupeKey(event) : text(event.id) || canonicalDedupeKey(event)
}

export function eventQuantity(event = {}) {
  try {
    const value = BigInt(event.quantity ?? event.mint_total ?? event.mintTotal ?? 0)
    return value >= 0n ? value : 0n
  } catch {
    return 0n
  }
}

export function eventSortKey(event = {}) {
  return {
    blockNumber: numberText(event.blockNumber ?? event.block_number) || "-1",
    transactionIndex: numberText(event.transactionIndex ?? event.transaction_index) || "-1",
    logIndex: numberText(event.logIndex ?? event.log_index) || "-1",
    txHash: canonicalTxHash(event.txHash ?? event.tx_hash) || text(event.txHash ?? event.tx_hash).toLowerCase(),
  }
}

export function compareMintEvents(left = {}, right = {}) {
  const quantityDelta = eventQuantity(right) - eventQuantity(left)
  if (quantityDelta !== 0n) return quantityDelta > 0n ? 1 : -1
  const a = eventSortKey(left)
  const b = eventSortKey(right)
  try {
    const block = BigInt(b.blockNumber) - BigInt(a.blockNumber)
    if (block !== 0n) return block > 0n ? 1 : -1
    const transaction = BigInt(b.transactionIndex) - BigInt(a.transactionIndex)
    if (transaction !== 0n) return transaction > 0n ? 1 : -1
    const log = BigInt(b.logIndex) - BigInt(a.logIndex)
    if (log !== 0n) return log > 0n ? 1 : -1
  } catch {
    // Malformed ordering fields fall through to the deterministic string key.
  }
  return a.txHash.localeCompare(b.txHash)
}

export function normalizeMintEvent(event = {}, defaults = {}) {
  const chainId = canonicalChainId(event.chainId ?? event.chain_id ?? defaults.chainId)
  const contract = canonicalAddress(event.contract ?? event.address)
  const txHash = canonicalTxHash(event.txHash ?? event.tx_hash)
  const dedupeKey = canonicalDedupeKey({ ...event, chainId, contract, txHash })
  const eventId = canonicalEventId({ ...event, chainId, contract, txHash }) || dedupeKey
  const status = ["pending", "confirmed", "discarded"].includes(event.status) ? event.status : defaults.status || "confirmed"
  const source = event.source || defaults.source || "rpc"
  const quantity = event.quantity ?? event.mint_total ?? event.mintTotal ?? null
  return {
    ...event,
    chainId,
    eventId,
    id: event.id || eventId,
    dedupeKey,
    status,
    source,
    txHash: txHash || event.txHash || event.tx_hash || "",
    contract: contract || event.contract || event.address || "",
    address: event.address || contract || event.contract || "",
    sender: event.sender || event.minter || event.from || "",
    recipient: event.recipient || event.to || "",
    blockNumber: event.blockNumber ?? event.block_number ?? null,
    blockTime: event.blockTime ?? event.block_time ?? event.timestamp ?? null,
    logIndex: event.logIndex ?? event.log_index ?? null,
    quantity,
    tokenIds: Array.isArray(event.tokenIds) ? event.tokenIds.map(String) : [],
    mintPriceWei: event.mintPriceWei ?? event.mint_price_wei ?? event.unitPriceWei ?? null,
    gasPrice: event.gasPrice ?? event.gas_price ?? event.effectiveGasPriceWei ?? null,
    gasLimit: event.gasLimit ?? event.gas_limit ?? null,
    valueWei: event.valueWei ?? event.value_wei ?? event.mintValueWei ?? null,
    methodName: event.methodName ?? event.method_name ?? "",
    selector: event.selector || "",
    tokenStandard: event.tokenStandard ?? event.token_standard ?? "",
    collectionSnapshot: event.collectionSnapshot ?? event.collection_snapshot ?? null,
    observedAt: event.observedAt ?? event.observed_at ?? new Date().toISOString(),
  }
}
