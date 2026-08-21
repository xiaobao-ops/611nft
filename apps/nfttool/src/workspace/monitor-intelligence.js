export const TRENDING_WINDOWS = [60, 300, 600, 1800, 3600, 21600, 43200, 86400]
export const ALERT_PREFERENCES_KEY = "nft-alert-preferences"
export const DEFAULT_ALERT_PREFERENCES = Object.freeze({ sound: true, desktop: false })

function normalizedAddress(value) {
  const address = String(value || "").trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(address) ? address : ""
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function normalizeTrendingSnapshot(payload = {}) {
  const windows = {}
  if (payload.windows && typeof payload.windows === "object" && !Array.isArray(payload.windows)) {
    for (const [window, collections] of Object.entries(payload.windows)) {
      if (Array.isArray(collections)) windows[String(window)] = collections
    }
  }
  if (Array.isArray(payload.collections) && Number.isFinite(Number(payload.window))) {
    windows[String(Number(payload.window))] = payload.collections
  }
  return {
    chainId: Number.isFinite(Number(payload.chainId)) ? Number(payload.chainId) : null,
    snapshotId: String(payload.snapshotId || ""),
    generatedAt: payload.generatedAt || null,
    windows,
  }
}

export function mergeTrendingSnapshots(current = {}, payload = {}) {
  const incoming = normalizeTrendingSnapshot(payload)
  return {
    ...current,
    chainId: incoming.chainId ?? current.chainId ?? null,
    snapshotId: incoming.snapshotId || current.snapshotId || "",
    generatedAt: incoming.generatedAt || current.generatedAt || null,
    windows: { ...(current.windows || {}), ...incoming.windows },
  }
}

function flagsByAddress(flags) {
  return new Map((flags || []).map((flag) => [normalizedAddress(flag?.address), flag]).filter(([address]) => address))
}

export function collectionsWithFlags(collections, flags, { showFlagged = false } = {}) {
  const index = flagsByAddress(flags)
  return (collections || []).map((collection) => ({
    ...collection,
    personalFlag: index.get(normalizedAddress(collection?.address || collection?.contract)) || null,
  })).filter((collection) => showFlagged || !collection.personalFlag)
}

export function deployerRiskProfile(value = {}) {
  const profile = value.deployerProfile
    || value.deployer_profile
    || value.collection_snapshot?.deployer_profile
    || value.collectionSnapshot?.deployerProfile
    || null
  if (!profile || typeof profile !== "object") return null
  const reasons = Array.isArray(profile.risk?.reasons)
    ? profile.risk.reasons.map(String)
    : Array.isArray(profile.reasons) ? profile.reasons.map(String) : []
  return {
    address: normalizedAddress(profile.address),
    walletAgeDays: finiteNumber(profile.walletAgeDays ?? profile.wallet_age_days),
    nftProjectCount: finiteNumber(profile.nftProjectCount ?? profile.nft_project_count),
    deployedContractCount: finiteNumber(profile.deployedContractCount ?? profile.deployed_contract_count),
    risky: Boolean(profile.risk?.risky ?? profile.risky ?? reasons.length),
    reasons,
  }
}

function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function radarDropTiming(drop = {}, nowMs = Date.now()) {
  const startsAt = timestamp(drop.startTime)
  const endsAt = timestamp(drop.endTime)
  if (startsAt === null) return { state: "unscheduled", startsAt, endsAt, remainingMs: null }
  if (endsAt !== null && nowMs > endsAt) return { state: "ended", startsAt, endsAt, remainingMs: endsAt - nowMs }
  if (nowMs >= startsAt) return { state: "live", startsAt, endsAt, remainingMs: endsAt === null ? null : endsAt - nowMs }
  return { state: "upcoming", startsAt, endsAt, remainingMs: startsAt - nowMs }
}

function paidDrop(drop) {
  if (drop.priceWei === null || drop.priceWei === undefined || drop.priceWei === "") return false
  try {
    return BigInt(drop.priceWei) > 0n
  } catch {
    return false
  }
}

function nativeFromWei(value) {
  if (value === null || value === undefined || value === "") return ""
  try {
    const wei = BigInt(value)
    const weiPerNative = 1000000000000000000n
    const whole = wei / weiPerNative
    const fraction = (wei % weiPerNative).toString().padStart(18, "0").replace(/0+$/, "")
    return fraction ? `${whole}.${fraction}` : whole.toString()
  } catch {
    return ""
  }
}

function localDateTime(value) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return ""
  const date = new Date(parsed)
  return new Date(parsed - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

export function buildRadarAdvancedMintSeed(drop = {}) {
  const nftContract = normalizedAddress(drop.contract)
  const contractAddress = normalizedAddress(drop.dropAddress)
  if (!nftContract || !contractAddress) return null
  const publicStage = drop.stageType === "public" && !drop.requiresCredentials
  return {
    contractAddress,
    mode: publicStage ? "method" : "hex",
    methodSignature: publicStage ? "mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity)" : "mint(uint256)",
    parameters: publicStage ? [nftContract, "", "{wallet}", "1"] : ["1"],
    calldata: "0x",
    replaceWallet: false,
    valueEth: nativeFromWei(drop.priceWei),
    scheduleAt: localDateTime(drop.startTime),
    notice: publicStage
      ? "已从 SeaDrop 雷达导入真实 Drop 合约、NFT 合约、价格与开售时间；feeRecipient 保持空白，补入真实地址后再生成 Preview。"
      : "已从 SeaDrop 雷达导入真实 Drop 合约、价格与开售时间；该阶段需要签名或白名单材料，补入完整 calldata 后再生成 Preview。",
  }
}

export function filterRadarDrops(drops, filters = {}, nowMs = Date.now()) {
  const query = String(filters.query || "").trim().toLowerCase()
  return (drops || []).filter((drop) => {
    const timing = radarDropTiming(drop, nowMs)
    const haystack = `${drop.name || ""} ${drop.contract || ""} ${drop.label || ""} ${drop.stageType || ""}`.toLowerCase()
    if (query && !haystack.includes(query)) return false
    if (filters.price === "free" && String(drop.priceWei) !== "0") return false
    if (filters.price === "paid" && !paidDrop(drop)) return false
    if (filters.liveOnly && timing.state !== "live") return false
    if (filters.publicOnly && drop.stageType !== "public") return false
    return true
  })
}

export function formatRadarDateTime(value, locale = "zh-CN") {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(locale) : "尚未公布"
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

function normalizedAlertPreferences(value = {}) {
  return {
    sound: value.sound === undefined ? DEFAULT_ALERT_PREFERENCES.sound : Boolean(value.sound),
    desktop: value.desktop === undefined ? DEFAULT_ALERT_PREFERENCES.desktop : Boolean(value.desktop),
  }
}

export function readAlertPreferences(storage = globalThis.localStorage) {
  try {
    return normalizedAlertPreferences(JSON.parse(storage?.getItem(ALERT_PREFERENCES_KEY) || "{}"))
  } catch {
    return { ...DEFAULT_ALERT_PREFERENCES }
  }
}

export function writeAlertPreferences(storage = globalThis.localStorage, value = {}) {
  const normalized = normalizedAlertPreferences(value)
  try {
    storage?.setItem(ALERT_PREFERENCES_KEY, JSON.stringify(normalized))
  } catch {
    // Preferences remain active for the current session.
  }
  return normalized
}

export function rememberAlertId(currentIds, rawId, limit = 100) {
  const id = String(rawId || "")
  const ids = (currentIds || []).map(String).filter(Boolean)
  if (!id || ids.includes(id)) return { duplicate: Boolean(id && ids.includes(id)), ids }
  return { duplicate: false, ids: [...ids, id].slice(-Math.max(1, Number(limit) || 100)) }
}
