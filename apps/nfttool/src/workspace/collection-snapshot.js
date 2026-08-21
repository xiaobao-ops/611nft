function versionOf(value) {
  const version = Number(value?.collection_snapshot?.version ?? value?.version ?? -1)
  return Number.isFinite(version) ? version : -1
}

function hasValue(value) {
  if (value === null || value === undefined || value === "") return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

function sameVersionSnapshot(target, snapshot) {
  const current = target?.collection_snapshot
  if (!current) return snapshot
  const merged = { ...current }
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "opensea_verified") {
      merged[key] = Boolean(current[key] || value)
    } else if (!hasValue(current[key]) && hasValue(value)) {
      merged[key] = value
    }
  }
  return merged
}

function acceptedSnapshot(target, snapshot) {
  if (!snapshot) return null
  const currentVersion = versionOf(target)
  const incomingVersion = versionOf(snapshot)
  if (incomingVersion < currentVersion || incomingVersion < 0) return null
  if (incomingVersion > currentVersion) return snapshot
  return sameVersionSnapshot(target, snapshot)
}

export function mergeSnapshotIntoEvent(event, snapshot) {
  const accepted = acceptedSnapshot(event, snapshot)
  if (!accepted) return event
  return {
    ...event,
    collection_snapshot: accepted,
    currentSupply: accepted.current_supply,
    maxSupply: accepted.max_supply,
    pendingCount: accepted.pending_token_count,
    pendingUnknownTxCount: accepted.pending_unknown_tx_count,
    pendingTransactionCount: accepted.pending_transaction_count,
    pendingCoverage: accepted.pending_coverage,
    projectImageUrl: accepted.image_url || "",
    imageSource: accepted.image_source || null,
    website: accepted.website || "",
    twitter: accepted.twitter || "",
    discord_url: accepted.discord_url || "",
    opensea_url: accepted.opensea_verified ? accepted.opensea_url || "" : "",
    openseaVerified: Boolean(accepted.opensea_verified),
    fundingTags: accepted.funding_tags || [],
    platformTags: accepted.platform_tags || [],
    statusTags: accepted.status_tags || [],
    contractCreatedAt: accepted.contract_created_at || null,
    contractCreatedBlock: accepted.contract_created_block || null,
    creatorAddress: accepted.creator_address || "",
    deployerProfile: accepted.deployer_profile || null,
  }
}

export function mergeSnapshotIntoRow(row, snapshot) {
  const accepted = acceptedSnapshot(row, snapshot)
  if (!accepted) return row
  return {
    ...row,
    collection_snapshot: accepted,
    current_supply: accepted.current_supply,
    max_supply: accepted.max_supply,
    pending_count: accepted.pending_token_count,
    pending_unknown_tx_count: accepted.pending_unknown_tx_count,
    pending_transaction_count: accepted.pending_transaction_count,
    pending_coverage: accepted.pending_coverage,
    image_url: accepted.image_url,
    image_source: accepted.image_source,
    website: accepted.website,
    twitter: accepted.twitter,
    discord_url: accepted.discord_url,
    opensea_url: accepted.opensea_verified ? accepted.opensea_url : null,
    opensea_verified: Boolean(accepted.opensea_verified),
    funding_tags: accepted.funding_tags || [],
    platform_tags: accepted.platform_tags || [],
    status_tags: accepted.status_tags || [],
    contract_created_at: accepted.contract_created_at || null,
    contract_created_block: accepted.contract_created_block || null,
    creator_address: accepted.creator_address || "",
    deployer_profile: accepted.deployer_profile || null,
  }
}

export function applyCollectionUpdate(data, update) {
  const address = String(update?.address || "").toLowerCase()
  const snapshot = update?.collection_snapshot
  if (!data || !address || !snapshot) return data
  return {
    ...data,
    events: (data.events || []).map((event) => String(event.address || "").toLowerCase() === address
      ? mergeSnapshotIntoEvent(event, snapshot)
      : event),
    windows: Object.fromEntries(Object.entries(data.windows || {}).map(([key, rows]) => [
      key,
      rows.map((row) => String(row.address || "").toLowerCase() === address
        ? mergeSnapshotIntoRow(row, snapshot)
        : row),
    ])),
  }
}
