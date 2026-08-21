export const OVERVIEW_WINDOWS = Object.freeze([60, 300, 1800, 3600])
export const TRENDING_WINDOWS = Object.freeze([60, 300, 600, 1800, 3600, 21600, 43200, 86400])
export const OVERVIEW_WINDOW_LABELS = Object.freeze({ 60: "1m", 300: "5m", 1800: "30m", 3600: "1h" })
export const TRENDING_WINDOW_LABELS = Object.freeze({
  60: "1m",
  300: "5m",
  600: "10m",
  1800: "30m",
  3600: "1h",
  21600: "6h",
  43200: "12h",
  86400: "24h",
})

export const DEFAULT_FILTERS = Object.freeze({
  keyword: "",
  blockedKeywords: "",
  blockedPlatforms: "",
  hideFree: false,
  hidePaid: false,
  hideAirdrop: false,
  hideErc1155: false,
  hideHighGas: false,
  hideUnknownSupply: false,
  pendingOnly: false,
  showFlagged: false,
})

export const DEFAULT_RADAR_FILTERS = Object.freeze({
  price: "all",
  publicOnly: false,
  liveOnly: false,
})

export function normalizeVisibleCount(value) {
  if (Array.isArray(value)) return value.length
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

export const ALERT_PREFERENCES_KEY = "nft-alert-preferences"
export const DEFAULT_ALERT_PREFERENCES = Object.freeze({ sound: true, desktop: false })

function hasValue(value) {
  if (value === null || value === undefined || value === "") return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

function snapshotVersion(value) {
  const version = Number(value?.collection_snapshot?.version ?? value?.version ?? -1)
  return Number.isFinite(version) ? version : -1
}

function normalizedAddress(value) {
  const address = String(value || "").trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(address) ? address : ""
}

function sameVersionSnapshot(target, snapshot) {
  const current = target?.collection_snapshot
  if (!current) return snapshot
  const merged = { ...current }
  for (const [key, value] of Object.entries(snapshot || {})) {
    if (key === "opensea_verified") merged[key] = Boolean(current[key] || value)
    else if (!hasValue(current[key]) && hasValue(value)) merged[key] = value
  }
  return merged
}

function acceptedSnapshot(target, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null
  const currentVersion = snapshotVersion(target)
  const incomingVersion = snapshotVersion(snapshot)
  if (incomingVersion < currentVersion || incomingVersion < 0) return null
  return incomingVersion > currentVersion ? snapshot : sameVersionSnapshot(target, snapshot)
}

function snapshotFields(snapshot) {
  return {
    currentSupply: snapshot.current_supply,
    maxSupply: snapshot.max_supply,
    pendingCount: snapshot.pending_token_count,
    pendingUnknownTxCount: snapshot.pending_unknown_tx_count,
    pendingTransactionCount: snapshot.pending_transaction_count,
    pendingCoverage: snapshot.pending_coverage,
    projectImageUrl: snapshot.image_url,
    imageSource: snapshot.image_source,
    website: snapshot.website,
    twitter: snapshot.twitter,
    discord_url: snapshot.discord_url,
    opensea_url: snapshot.opensea_verified ? snapshot.opensea_url : "",
    openseaVerified: Boolean(snapshot.opensea_verified),
    fundingTags: snapshot.funding_tags || [],
    platformTags: snapshot.platform_tags || [],
    statusTags: snapshot.status_tags || [],
    contractCreatedAt: snapshot.contract_created_at,
    contractCreatedBlock: snapshot.contract_created_block,
    creatorAddress: snapshot.creator_address,
    deployerProfile: snapshot.deployer_profile || null,
    floorPriceEth: snapshot.floor_price_eth,
    maxPerWallet: snapshot.max_per_wallet,
  }
}

export function mergeSnapshotIntoEvent(event, snapshot) {
  const accepted = acceptedSnapshot(event, snapshot)
  if (!accepted) return event
  const fields = snapshotFields(accepted)
  const merged = { ...event, collection_snapshot: accepted }
  for (const [key, value] of Object.entries(fields)) {
    if (hasValue(value) || key === "openseaVerified") merged[key] = value
  }
  return merged
}

export function mergeSnapshotIntoRow(row, snapshot) {
  const accepted = acceptedSnapshot(row, snapshot)
  if (!accepted) return row
  return {
    ...row,
    collection_snapshot: accepted,
    current_supply: accepted.current_supply ?? row.current_supply,
    max_supply: accepted.max_supply ?? row.max_supply,
    pending_count: accepted.pending_token_count ?? row.pending_count,
    pending_unknown_tx_count: accepted.pending_unknown_tx_count ?? row.pending_unknown_tx_count,
    pending_transaction_count: accepted.pending_transaction_count ?? row.pending_transaction_count,
    pending_coverage: accepted.pending_coverage ?? row.pending_coverage,
    image_url: accepted.image_url ?? row.image_url,
    image_source: accepted.image_source ?? row.image_source,
    website: accepted.website ?? row.website,
    twitter: accepted.twitter ?? row.twitter,
    discord_url: accepted.discord_url ?? row.discord_url,
    opensea_url: accepted.opensea_verified ? accepted.opensea_url ?? row.opensea_url : "",
    opensea_verified: Boolean(accepted.opensea_verified ?? row.opensea_verified),
    funding_tags: accepted.funding_tags ?? row.funding_tags ?? [],
    platform_tags: accepted.platform_tags ?? row.platform_tags ?? [],
    status_tags: accepted.status_tags ?? row.status_tags ?? [],
    contract_created_at: accepted.contract_created_at ?? row.contract_created_at,
    contract_created_block: accepted.contract_created_block ?? row.contract_created_block,
    creator_address: accepted.creator_address ?? row.creator_address,
    deployer_profile: accepted.deployer_profile ?? row.deployer_profile,
    floor_price_eth: accepted.floor_price_eth ?? row.floor_price_eth,
    max_per_wallet: accepted.max_per_wallet ?? row.max_per_wallet,
  }
}

export function applyCollectionUpdate(data, update) {
  const address = normalizedAddress(update?.address)
  const snapshot = update?.collection_snapshot
  if (!data || !address || !snapshot) return data
  return {
    ...data,
    events: (data.events || []).map((event) => normalizedAddress(event.address) === address ? mergeSnapshotIntoEvent(event, snapshot) : event),
    windows: Object.fromEntries(Object.entries(data.windows || {}).map(([window, rows]) => [
      window,
      (rows || []).map((row) => normalizedAddress(row.address) === address ? mergeSnapshotIntoRow(row, snapshot) : row),
    ])),
  }
}

export function finite(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function integer(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback
  const number = finite(value)
  return number === null ? String(value) : new Intl.NumberFormat("zh-CN").format(number)
}

export function short(value, head = 7, tail = 5) {
  const text = String(value || "")
  return text.length > head + tail + 3 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text || "—"
}

export function normalizeUrl(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  try {
    const url = new URL(/^https?:\/\//i.test(raw) || /^\/{2}/.test(raw) ? raw : `https://${raw}`)
    return ["http:", "https:"].includes(url.protocol) ? url.href : ""
  } catch {
    return ""
  }
}

export function eventTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed)
}

export function eventKey(event) {
  return String(event?.batchId || event?.id || `${event?.txHash || ""}:${event?.address || ""}`)
}

export function eventTags(event = {}) {
  const values = [
    ...(event.fundingTags || event.funding_tags || []).map((label) => ({ label, type: "funding" })),
    ...(event.platformTags || event.platform_tags || []).map((label) => ({ label, type: "platform" })),
    ...(event.statusTags || event.status_tags || []).map((label) => ({ label, type: "status" })),
  ]
  if (event.platform && !values.some((item) => String(item.label).toLowerCase() === String(event.platform).toLowerCase())) {
    values.push({ label: event.platform, type: "platform" })
  }
  return values.filter((item, index) => values.findIndex((candidate) => candidate.label === item.label) === index)
}

export function normalizeOverviewEvent(row = {}, windowSeconds = 1800) {
  const preview = row.recent_mint_preview?.[0] || {}
  const value = {
    ...row,
    id: `overview:${row.address}:${windowSeconds}`,
    chainId: row.chainId,
    address: row.address,
    name: row.name,
    tokenName: row.name,
    symbol: row.symbol,
    txHash: preview.tx_hash || row.tx_hash || "",
    blockNumber: preview.block_number || row.contract_created_block || "",
    contractCreatedAt: row.contract_created_at,
    contractCreatedBlock: row.contract_created_block,
    mintPrice: preview.mint_price || row.mint_price,
    mintValueWei: preview.mint_value_raw ?? row.mint_price_raw,
    isFree: (preview.mint_value_raw ?? row.mint_price_raw) === "0",
    isAirdrop: Boolean(row.is_airdrop),
    quantity: preview.quantity || "1",
    currentSupply: row.current_supply,
    maxSupply: row.max_supply,
    pendingCount: row.pending_count,
    pendingUnknownTxCount: row.pending_unknown_tx_count,
    pendingTransactionCount: row.pending_transaction_count,
    pendingCoverage: row.pending_coverage,
    tokenStandard: row.token_standard,
    methodName: preview.method_name || row.method_name,
    selector: preview.selector || row.selector,
    gasLimit: preview.gas_limit || row.gas_limit,
    gasUsed: preview.gas_used,
    gasFeeNative: preview.gas_fee_native,
    projectImageUrl: row.image_url,
    imageFallbackUrl: row.image_fallback_url,
    website: row.website,
    twitter: row.twitter,
    openseaUrl: row.opensea_verified ? row.opensea_url : "",
    openseaVerified: Boolean(row.opensea_verified),
    fundingTags: row.funding_tags,
    platformTags: row.platform_tags,
    statusTags: row.status_tags,
    deployerProfile: row.deployer_profile,
    creatorAddress: row.creator_address,
    floorPriceEth: row.floor_price_eth,
    maxPerWallet: row.max_per_wallet,
    nativeSymbol: row.native_symbol,
  }
  return row.collection_snapshot ? mergeSnapshotIntoEvent(value, row.collection_snapshot) : value
}

export function normalizeTrendingEvent(row = {}, chainId) {
  const latest = row.latestEvent || {}
  const value = {
    ...latest,
    ...row,
    id: latest.id || `trending:${row.address}`,
    chainId: row.chainId || chainId,
    address: row.address,
    tokenName: row.name || latest.tokenName,
    projectImageUrl: row.imageUrl || latest.projectImageUrl,
    currentSupply: row.collection_snapshot?.current_supply ?? latest.currentSupply,
    maxSupply: row.collection_snapshot?.max_supply ?? latest.maxSupply,
    mintPrice: row.mintPrice ?? latest.mintPrice,
    deployerProfile: row.deployerProfile || row.deployer_profile || row.collection_snapshot?.deployer_profile || latest.deployerProfile,
    personalFlag: row.personalFlag || null,
  }
  return row.collection_snapshot ? mergeSnapshotIntoEvent(value, row.collection_snapshot) : value
}

export function normalizeRadarEvent(drop = {}, chain = {}) {
  return {
    id: `radar:${drop.id || `${drop.contract}:${drop.stageKey}`}`,
    radarDrop: true,
    chainId: chain.id,
    address: drop.contract,
    mintTarget: drop.dropAddress || drop.contract,
    name: drop.name || "SeaDrop 阶段",
    tokenName: drop.name || "SeaDrop 阶段",
    tokenStandard: "SeaDrop",
    projectImageUrl: drop.image || "",
    maxPerWallet: drop.maxPerWallet,
    mintPrice: drop.priceWei === null || drop.priceWei === undefined ? "—" : `${nativeFromWei(drop.priceWei)} ${chain.nativeSymbol || ""}`.trim(),
    mintValueWei: drop.priceWei,
    isFree: String(drop.priceWei) === "0",
    requiresCredentials: Boolean(drop.requiresCredentials),
    stageType: drop.stageType,
    startTime: drop.startTime,
    radarDropData: drop,
    personalFlag: drop.personalFlag || null,
  }
}

export function collectionsWithFlags(rows, flags, { showFlagged = false } = {}) {
  const index = new Map((flags || []).map((flag) => [normalizedAddress(flag?.address), flag]).filter(([address]) => address))
  return (rows || []).map((row) => ({
    ...row,
    personalFlag: index.get(normalizedAddress(row?.address || row?.contract)) || row.personalFlag || null,
  })).filter((row) => showFlagged || !row.personalFlag)
}

export function mergeCollectionDetailIntoEvent(event = {}, collection = null) {
  if (!collection || normalizedAddress(collection.address) !== normalizedAddress(event.address)) return event
  const merged = {
    ...event,
    name: collection.name || event.name,
    tokenName: collection.name || event.tokenName,
    symbol: collection.symbol || event.symbol,
    tokenStandard: collection.token_standard || event.tokenStandard,
    currentSupply: collection.current_supply ?? event.currentSupply,
    maxSupply: collection.max_supply ?? event.maxSupply,
    maxPerWallet: collection.max_per_wallet ?? event.maxPerWallet,
    mintPrice: collection.mint_price ?? event.mintPrice,
    mintValueWei: collection.mint_price_raw ?? event.mintValueWei,
    isFree: collection.mint_price_raw === "0" ? true : event.isFree,
    isAirdrop: collection.is_airdrop ?? event.isAirdrop,
    pendingCount: collection.pending_count ?? event.pendingCount,
    pendingUnknownTxCount: collection.pending_unknown_tx_count ?? event.pendingUnknownTxCount,
    pendingTransactionCount: collection.pending_transaction_count ?? event.pendingTransactionCount,
    pendingCoverage: collection.pending_coverage || event.pendingCoverage,
    projectImageUrl: collection.image_url || event.projectImageUrl,
    imageFallbackUrl: collection.image_fallback_url || event.imageFallbackUrl,
    website: collection.website || event.website,
    twitter: collection.twitter || event.twitter,
    discord_url: collection.discord_url || event.discord_url,
    openseaUrl: collection.opensea_verified ? collection.opensea_url || event.openseaUrl : "",
    openseaVerified: Boolean(collection.opensea_verified),
    fundingTags: collection.funding_tags || event.fundingTags || [],
    platformTags: collection.platform_tags || event.platformTags || [],
    statusTags: collection.status_tags || event.statusTags || [],
    contractCreatedAt: collection.contract_created_at || event.contractCreatedAt,
    contractCreatedBlock: collection.contract_created_block || event.contractCreatedBlock,
    creatorAddress: collection.creator_address || event.creatorAddress,
    deployerProfile: collection.deployer_profile || event.deployerProfile,
    floorPriceEth: collection.floor_price_eth ?? event.floorPriceEth,
    uniqueMinters: collection.unique_minters ?? event.uniqueMinters,
    uniqueMintersStatus: collection.unique_minters_status || event.uniqueMintersStatus,
    recentMints: collection.recent_mints || event.recentMints || [],
  }
  return collection.collection_snapshot ? mergeSnapshotIntoEvent(merged, collection.collection_snapshot) : merged
}

export function enrichRealtimeEvents(events, overview = null) {
  const rows = Object.values(overview?.windows || {}).flat()
  const metadata = new Map(rows.map((row) => [normalizedAddress(row?.address), row]).filter(([address]) => address))
  return (events || []).map((event) => {
    const row = metadata.get(normalizedAddress(event?.address))
    if (!row) return event
    const preview = (row.recent_mint_preview || []).find((item) => item.tx_hash === event.txHash) || {}
    const merged = {
      ...event,
      name: event.name && !/^ERC\d+\b/i.test(event.name) ? event.name : row.name || event.name,
      tokenName: event.tokenName || row.name || "",
      projectImageUrl: row.image_url || event.projectImageUrl || "",
      imageFallbackUrl: row.image_fallback_url || event.imageFallbackUrl || preview.image_url || "",
      website: row.website || event.website || "",
      twitter: row.twitter || event.twitter || "",
      openseaUrl: row.opensea_verified ? row.opensea_url || "" : "",
      openseaVerified: Boolean(row.opensea_verified),
      discord_url: row.discord_url || event.discord_url || "",
      blockNumber: event.blockNumber || preview.block_number || row.contract_created_block || "",
      contractCreatedAt: event.contractCreatedAt || row.contract_created_at || null,
      contractCreatedBlock: event.contractCreatedBlock || row.contract_created_block || null,
      currentSupply: row.current_supply ?? event.currentSupply,
      maxSupply: row.max_supply ?? event.maxSupply,
      pendingCount: row.pending_count ?? event.pendingCount,
      pendingUnknownTxCount: row.pending_unknown_tx_count ?? event.pendingUnknownTxCount ?? 0,
      pendingTransactionCount: row.pending_transaction_count ?? event.pendingTransactionCount ?? null,
      pendingCoverage: row.pending_coverage || event.pendingCoverage || "unavailable",
      fundingTags: row.funding_tags || event.fundingTags || [],
      platformTags: row.platform_tags || event.platformTags || [],
      statusTags: row.status_tags || event.statusTags || [],
      deployerProfile: row.deployer_profile || event.deployerProfile || null,
    }
    return row.collection_snapshot ? mergeSnapshotIntoEvent(merged, row.collection_snapshot) : merged
  })
}

export function stableRealtimeOrder(events, frozenKeys = null) {
  const rows = [...(events || [])]
  if (!Array.isArray(frozenKeys) || frozenKeys.length === 0) return rows
  const byKey = new Map(rows.map((event) => [eventKey(event), event]))
  const frozen = frozenKeys.map((key) => byKey.get(String(key))).filter(Boolean)
  const known = new Set(frozen.map(eventKey))
  return [...frozen, ...rows.filter((event) => !known.has(eventKey(event)))]
}

export function eventMatches(event = {}, filters = DEFAULT_FILTERS) {
  const search = String(filters.keyword || "").trim().toLowerCase()
  const haystack = `${event.name || ""} ${event.tokenName || ""} ${event.symbol || ""} ${event.address || ""} ${event.methodName || event.selector || ""}`.toLowerCase()
  if (search && !haystack.includes(search)) return false
  const blockedWords = String(filters.blockedKeywords || "").split(/[,，\n]/).map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (blockedWords.some((word) => haystack.includes(word))) return false
  const platforms = eventTags(event).filter((tag) => tag.type === "platform").map((tag) => String(tag.label).toLowerCase())
  const blockedPlatforms = String(filters.blockedPlatforms || "").split(/[,，\n]/).map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (blockedPlatforms.some((value) => platforms.some((platform) => platform.includes(value)))) return false
  if (filters.hideFree && event.isFree) return false
  if (filters.hidePaid && !event.isFree && event.mintValueWei !== null && event.mintValueWei !== undefined) return false
  if (filters.hideAirdrop && event.isAirdrop) return false
  if (filters.hideErc1155 && String(event.tokenStandard || "").toUpperCase() === "ERC1155") return false
  if (filters.hideHighGas && Number(event.gasLimit || 0) > 200000) return false
  if (filters.hideUnknownSupply && (event.maxSupply === null || event.maxSupply === undefined || event.maxSupply === "") ) return false
  if (filters.pendingOnly && !(Number(event.pendingCount) > 0 || Number(event.pendingUnknownTxCount) > 0)) return false
  return true
}

export function radarTiming(drop = {}, nowMs = Date.now()) {
  const startsAt = Date.parse(drop.startTime || "")
  const endsAt = Date.parse(drop.endTime || "")
  if (!Number.isFinite(startsAt)) return { state: "unscheduled", startsAt: null, endsAt: Number.isFinite(endsAt) ? endsAt : null, remainingMs: null }
  if (Number.isFinite(endsAt) && nowMs > endsAt) return { state: "ended", startsAt, endsAt, remainingMs: endsAt - nowMs }
  if (nowMs >= startsAt) return { state: "live", startsAt, endsAt: Number.isFinite(endsAt) ? endsAt : null, remainingMs: Number.isFinite(endsAt) ? endsAt - nowMs : null }
  return { state: "upcoming", startsAt, endsAt: Number.isFinite(endsAt) ? endsAt : null, remainingMs: startsAt - nowMs }
}

function paidDrop(drop) {
  try { return BigInt(drop.priceWei) > 0n } catch { return false }
}

export function filterRadarDrops(drops, filters = DEFAULT_RADAR_FILTERS, nowMs = Date.now()) {
  const query = String(filters.query || "").trim().toLowerCase()
  return (drops || []).filter((drop) => {
    const timing = radarTiming(drop, nowMs)
    const haystack = `${drop.name || ""} ${drop.contract || ""} ${drop.label || ""} ${drop.stageType || ""}`.toLowerCase()
    if (query && !haystack.includes(query)) return false
    if (filters.price === "free" && String(drop.priceWei) !== "0") return false
    if (filters.price === "paid" && !paidDrop(drop)) return false
    if (filters.liveOnly && timing.state !== "live") return false
    if (filters.publicOnly && drop.stageType !== "public") return false
    return true
  })
}

export function formatRadarDateTime(value) {
  const parsed = Date.parse(value || "")
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN") : "尚未公布"
}

export function formatRadarCountdown(value) {
  const totalSeconds = Math.max(0, Math.ceil(Number(value || 0) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days) return `${days}天${String(hours).padStart(2, "0")}时`
  if (hours) return `${hours}时${String(minutes).padStart(2, "0")}分`
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`
}

function nativeFromWei(value) {
  try {
    const wei = BigInt(value || 0)
    const base = 1000000000000000000n
    const whole = wei / base
    const fraction = (wei % base).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "")
    return fraction ? `${whole}.${fraction}` : whole.toString()
  } catch {
    return "—"
  }
}

function normalizeRateSample(sample) {
  const value = typeof sample === "object" && sample !== null ? sample.count ?? sample.mintRate ?? sample.rate ?? sample.value : sample
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function createRealtimeState() {
  return { events: [], mintRate: null, rateSamples: [], latencyMs: null, source: "", replayResetVersion: 0, status: null }
}

function capped(events, limit = 250) { return events.slice(0, Math.max(1, Number(limit) || 250)) }

function upsertMint(events, value, limit) {
  const batch = events.find((event) => (event.eventIds || []).includes(value.id))
  if (batch) {
    if (batch.latestEventId && batch.latestEventId !== value.id) return events
    return events.map((event) => event === batch ? { ...event, ...value, id: event.id, eventIds: event.eventIds, batchId: event.batchId, count: event.count, tokenIdRange: event.tokenIdRange, latestEventId: event.latestEventId } : event)
  }
  const key = eventKey(value)
  return capped([value, ...events.filter((event) => eventKey(event) !== key)], limit)
}

function applyBatch(events, value, limit) {
  const batchId = String(value.batchId || value.id || "")
  const ids = new Set((value.eventIds || []).map(String))
  const batch = { ...value, id: batchId, batchId, eventIds: [...ids], latestEventId: value.latestEventId || [...ids].at(-1) || value.id }
  return capped([batch, ...events.filter((event) => eventKey(event) !== batchId && !ids.has(String(event.id || "")) && !(event.eventIds || []).some((id) => ids.has(String(id))))], limit)
}

function applyUpdate(events, value) {
  return events.map((event) => event.id === value.id || event.latestEventId === value.id ? { ...event, ...value, id: event.id, batchId: event.batchId, eventIds: event.eventIds, count: event.count, tokenIdRange: event.tokenIdRange, latestEventId: event.latestEventId } : event)
}

function applyDiscard(events, value) {
  const ids = new Set((value.eventIds || value.ids || []).map(String))
  const batchId = String(value.batchId || "")
  return events.filter((event) => eventKey(event) !== batchId && !ids.has(String(event.id || "")) && !(event.eventIds || []).some((id) => ids.has(String(id))))
}

function mergeBackfill(events, value) {
  const address = normalizedAddress(value.address)
  return events.map((event) => normalizedAddress(event.address) === address ? { ...event, ...value, uniqueMinters: value.unique_minters, uniqueMintersStatus: value.unique_minters_status, uniqueMintersError: value.unique_minters_error } : event)
}

export function reduceRealtimeState(state, value, { limit = 250 } = {}) {
  const current = state || createRealtimeState()
  if (!value || typeof value !== "object") return current
  if (value.type === "heartbeat") {
    const incoming = Array.isArray(value.mintRateSamples) ? value.mintRateSamples : value.rateSamples
    const samples = incoming?.map(normalizeRateSample).filter((sample) => sample !== null).slice(-60) || current.rateSamples
    const rawLatency = value.latencyMs ?? value.monitorStatus?.latencyMs
    const latency = Number(rawLatency)
    return { ...current, mintRate: Number.isFinite(Number(value.mintRate)) ? Number(value.mintRate) : current.mintRate, rateSamples: samples, latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : current.latencyMs, source: String(value.source || value.monitorStatus?.source || current.source || ""), status: value.monitorStatus || current.status }
  }
  if (value.type === "replay_reset") return { ...current, events: [], replayResetVersion: current.replayResetVersion + 1 }
  if (value.type === "mint") return { ...current, events: upsertMint(current.events, value, limit) }
  if (value.type === "mint_batch") return { ...current, events: applyBatch(current.events, value, limit) }
  if (value.type === "mint_update") return { ...current, events: applyUpdate(current.events, value) }
  if (value.type === "discard") return { ...current, events: applyDiscard(current.events, value) }
  if (["collection_patch", "collection_update"].includes(value.type)) {
    return { ...current, events: current.events.map((event) => normalizedAddress(event.address) === normalizedAddress(value.address) ? mergeSnapshotIntoEvent(event, value.collection_snapshot) : event) }
  }
  if (value.type === "minter_backfill_update") return { ...current, events: mergeBackfill(current.events, value) }
  if (value.type === "monitor_status") return { ...current, status: value, source: String(value.source || current.source || "") }
  return current
}

export function replaceRealtimeOverview(state, overviewEvents, { limit = 250 } = {}) {
  const current = state || createRealtimeState()
  const batchMembers = new Set(current.events.flatMap((event) => event.eventIds || []).map(String))
  const byKey = new Map()
  for (const event of overviewEvents || []) {
    if (!event || batchMembers.has(String(event.id || ""))) continue
    byKey.set(eventKey(event), event)
  }
  for (const event of current.events) {
    const key = eventKey(event)
    const snapshot = byKey.get(key)
    if (!snapshot) byKey.set(key, event)
    else if (eventTimestamp(event.lastTimestamp || event.timestamp) > eventTimestamp(snapshot.lastTimestamp || snapshot.timestamp)) byKey.set(key, { ...snapshot, ...event })
    else byKey.set(key, { ...event, ...snapshot })
  }
  return { ...current, events: capped([...byKey.values()].sort((left, right) => eventTimestamp(right.lastTimestamp || right.timestamp) - eventTimestamp(left.lastTimestamp || left.timestamp)), limit) }
}

export function imageSources(value) {
  const sources = []
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return
    sources.push(entry.projectImageUrl, entry.image_url, entry.imageUrl, entry.image, entry.image_fallback_url, entry.imageFallbackUrl, entry.collection_snapshot?.image_url)
    if (Array.isArray(entry.events)) entry.events.forEach(visit)
    if (entry.windows && typeof entry.windows === "object") Object.values(entry.windows).flat().forEach(visit)
    if (Array.isArray(entry.drops)) entry.drops.forEach(visit)
  }
  visit(value)
  return [...new Set(sources.map((source) => String(source || "").trim()).filter(Boolean))]
}

export function alertDraftFromRule(rule = null) {
  if (!rule) return {
    type: "trending",
    name: "",
    window: "60",
    threshold: "10",
    address: "",
    leadMinutes: "10",
    cooldownSeconds: "60",
    enabled: true,
  }
  return {
    type: String(rule.type || "trending"),
    name: String(rule.name || ""),
    window: String(rule.params?.window ?? 60),
    threshold: String(rule.params?.threshold ?? 10),
    address: String(rule.params?.address || ""),
    leadMinutes: String(rule.params?.leadMinutes ?? 10),
    cooldownSeconds: String(rule.cooldownSeconds ?? 60),
    enabled: Boolean(rule.enabled),
  }
}

export function buildAlertPayload(draft = {}, chainId) {
  const type = String(draft.type || "trending")
  const address = String(draft.address || "").trim()
  const params = type === "trending"
    ? { window: Number(draft.window), threshold: Number(draft.threshold) }
    : type === "seadrop_start"
      ? { leadMinutes: Number(draft.leadMinutes), ...(address ? { address } : {}) }
      : { address }
  return {
    type,
    chainId: Number(chainId),
    name: String(draft.name || "").trim(),
    enabled: draft.enabled === undefined ? true : Boolean(draft.enabled),
    cooldownSeconds: Number(draft.cooldownSeconds),
    params,
  }
}

export function readAlertPreferences(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(ALERT_PREFERENCES_KEY) || "{}")
    return { sound: parsed.sound === undefined ? true : Boolean(parsed.sound), desktop: parsed.desktop === undefined ? false : Boolean(parsed.desktop) }
  } catch {
    return { ...DEFAULT_ALERT_PREFERENCES }
  }
}

export function writeAlertPreferences(storage = globalThis.localStorage, value = {}) {
  const result = { sound: value.sound === undefined ? true : Boolean(value.sound), desktop: value.desktop === undefined ? false : Boolean(value.desktop) }
  try { storage?.setItem(ALERT_PREFERENCES_KEY, JSON.stringify(result)) } catch { /* session preference remains active */ }
  return result
}

export function rememberAlertId(currentIds, rawId, limit = 100) {
  const id = String(rawId || "")
  const ids = (currentIds || []).map(String).filter(Boolean)
  if (!id || ids.includes(id)) return { duplicate: Boolean(id && ids.includes(id)), ids }
  return { duplicate: false, ids: [...ids, id].slice(-Math.max(1, Number(limit) || 100)) }
}
