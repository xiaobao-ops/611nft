export function optimisticCollectionDetail(current, collection) {
  const sameCollection = current?.address?.toLowerCase() === collection?.address?.toLowerCase()
  const recentMints = sameCollection && Array.isArray(current?.recent_mints)
    ? current.recent_mints
    : Array.isArray(collection?.recent_mint_preview) ? collection.recent_mint_preview : []

  return {
    ...(sameCollection ? current : {}),
    ...collection,
    recent_mints: recentMints,
  }
}

function sameCollection(left, right) {
  return Boolean(left?.address && right?.address)
    && left.address.toLowerCase() === right.address.toLowerCase()
}

function sameRecentMint(left, right) {
  return Boolean(left?.tx_hash && right?.tx_hash)
    && left.tx_hash.toLowerCase() === right.tx_hash.toLowerCase()
    && String(left.token_id ?? "") === String(right.token_id ?? "")
}

export function collectionDetailFromMintEvent(current, event) {
  if (!sameCollection(current, event)) return current

  const recentMint = {
    timestamp: event.timestamp,
    to_address: event.recipient,
    token_id: event.tokenIds?.[0] ?? null,
    quantity: event.quantity,
    tx_hash: event.txHash,
    mint_price: event.mintPrice,
    mint_value_raw: event.mintValueWei,
    unit_price_raw: event.unitPriceWei,
    gas_used: event.gasUsed,
    gas_fee_wei: event.gasFeeWei,
    gas_fee_native: event.gasFeeNative,
    image_url: event.imageUrl || null,
    token_name: event.tokenName || null,
  }
  const recentMints = event.txHash
    ? [recentMint, ...(current.recent_mints || []).filter((mint) => !sameRecentMint(mint, recentMint))].slice(0, 50)
    : current.recent_mints || []

  return {
    ...current,
    last_mint_time: Math.max(Number(current.last_mint_time || 0), Number(event.timestamp || 0)) || current.last_mint_time,
    recent_mints: recentMints,
    ...(event.current_supply == null ? {} : { current_supply: event.current_supply }),
    ...(event.max_supply == null ? {} : { max_supply: event.max_supply }),
  }
}

export function syncCollectionDetailFromOverview(current, rows) {
  if (!current?.address) return current
  const overview = (rows || []).find((row) => sameCollection(current, row))
  return overview ? optimisticCollectionDetail(current, overview) : current
}
