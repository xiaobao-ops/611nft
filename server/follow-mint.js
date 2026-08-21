import { getAddress, parseEther } from "viem"

const ARM_PHRASE = "自动铸造"
const DEFAULT_ARM_TTL_MS = 60 * 60 * 1000
const FOLLOW_PLATFORMS = new Set(["artblocks", "bueno", "zora"])

function timestamp() {
  return new Date().toISOString()
}

function asBoolean(value, fallback = false) {
  if (value === undefined) return fallback
  return value === true || value === 1 || value === "1"
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? "").trim()
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是整数`)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必须在 ${min} 到 ${max} 之间`)
  }
  return parsed
}

function optionalAddress(value, label) {
  const text = String(value || "").trim()
  if (!text) return ""
  try {
    return getAddress(text)
  } catch {
    throw new Error(`${label}无效`)
  }
}

function maxMintValue(value) {
  const text = String(value ?? "").trim()
  if (!text) return ""
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("最大铸造金额必须是十进制链币金额")
  parseEther(text)
  return text
}

function optionalInteger(value, label, options = {}) {
  const text = String(value ?? "").trim()
  return text ? integer(text, label, options) : null
}

function timeOfDay(value, label) {
  const text = String(value ?? "").trim()
  if (!text) return ""
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`${label}必须使用 HH:mm 格式`)
  return text
}

function keywords(value) {
  const rows = Array.isArray(value) ? value : String(value || "").split(/[\n,]/)
  const output = [...new Set(rows.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))]
  if (output.length > 50 || output.some((item) => item.length > 80)) throw new Error("屏蔽关键词超过支持上限")
  return output
}

function excludedPlatforms(value) {
  const rows = Array.isArray(value) ? value : []
  const output = [...new Set(rows.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))]
  if (output.some((item) => !FOLLOW_PLATFORMS.has(item))) throw new Error("包含不支持的平台筛选项")
  return output
}

function walletIds(value, { required = true } = {}) {
  const rows = Array.isArray(value) ? value : []
  const normalized = [...new Set(rows.map((item) => String(item || "").trim()).filter(Boolean))]
  if (required && !normalized.length) throw new Error("请至少选择一个钱包")
  if (normalized.length > 200) throw new Error("最多选择 200 个钱包")
  return normalized
}

function hydrateRule(row) {
  if (!row) return null
  const storedProfileId = String(row.rpc_profile_id || "main").trim().toLowerCase() || "main"
  const rpcProfileId = storedProfileId === "hk" ? "ethereum" : storedProfileId
  const profileStatus = ["flashbots", "arbitrum", "zks", "shib"].includes(storedProfileId) ? "profile_retired" : "ready"
  return {
    id: row.id,
    name: row.name,
    chainId: row.chain_id,
    rpcProfileId,
    profileStatus,
    sourceContract: row.source_contract,
    targetContract: row.target_contract,
    walletIds: JSON.parse(row.wallet_ids_json || "[]"),
    quantity: row.quantity,
    tokenId: row.token_id,
    concurrency: row.concurrency,
    minTriggerQuantity: row.min_trigger_quantity,
    maxTriggerQuantity: row.max_trigger_quantity,
    maxMintCostEth: row.max_mint_cost_eth,
    eventValueMode: row.event_value_mode,
    maxEventValueEth: row.max_event_value_eth,
    maxGasLimit: row.max_gas_limit,
    parameterCount: row.parameter_count,
    minMaxSupply: row.min_max_supply,
    timeStart: row.time_start,
    timeEnd: row.time_end,
    blockedKeywords: JSON.parse(row.blocked_keywords_json || "[]"),
    excludeErc1155: Boolean(row.exclude_erc1155),
    excludedPlatforms: JSON.parse(row.excluded_platforms_json || "[]"),
    confirmedOnly: Boolean(row.confirmed_only),
    notifyOnly: Boolean(row.notify_only),
    cooldownSeconds: row.cooldown_seconds,
    enabled: Boolean(row.enabled),
    oneShot: Boolean(row.one_shot),
    mode: row.mode,
    armedUntil: row.armed_until || null,
    lastEventId: row.last_event_id || "",
    lastTriggeredAt: row.last_triggered_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hydrateRun(row) {
  if (!row) return null
  return {
    id: row.id,
    ruleId: row.rule_id,
    eventId: row.event_id,
    status: row.status,
    jobId: row.job_id,
    error: row.error,
    snapshot: JSON.parse(row.snapshot_json || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function migrateFollowMint(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_mint_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      rpc_profile_id TEXT NOT NULL DEFAULT 'main',
      source_contract TEXT NOT NULL DEFAULT '',
      target_contract TEXT NOT NULL DEFAULT '',
      wallet_ids_json TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      concurrency INTEGER NOT NULL,
      min_trigger_quantity INTEGER NOT NULL,
      max_trigger_quantity INTEGER,
      max_mint_cost_eth TEXT NOT NULL DEFAULT '',
      event_value_mode TEXT NOT NULL DEFAULT 'free',
      max_event_value_eth TEXT NOT NULL DEFAULT '',
      max_gas_limit INTEGER,
      parameter_count INTEGER,
      min_max_supply TEXT NOT NULL DEFAULT '',
      time_start TEXT NOT NULL DEFAULT '',
      time_end TEXT NOT NULL DEFAULT '',
      blocked_keywords_json TEXT NOT NULL DEFAULT '[]',
      exclude_erc1155 INTEGER NOT NULL DEFAULT 0,
      excluded_platforms_json TEXT NOT NULL DEFAULT '[]',
      confirmed_only INTEGER NOT NULL DEFAULT 1,
      notify_only INTEGER NOT NULL DEFAULT 0,
      cooldown_seconds INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      one_shot INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'preview',
      armed_until TEXT,
      last_event_id TEXT NOT NULL DEFAULT '',
      last_triggered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follow_mint_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      event_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      job_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_follow_mint_rules_enabled_chain
      ON follow_mint_rules(enabled, chain_id);
    CREATE INDEX IF NOT EXISTS idx_follow_mint_runs_rule
      ON follow_mint_runs(rule_id, created_at DESC);
  `)
  const columns = new Set(db.prepare("PRAGMA table_info(follow_mint_rules)").all().map((column) => column.name))
  const additions = [
    ["rpc_profile_id", "TEXT NOT NULL DEFAULT 'main'"],
    ["max_trigger_quantity", "INTEGER"],
    ["event_value_mode", "TEXT NOT NULL DEFAULT 'free'"],
    ["max_event_value_eth", "TEXT NOT NULL DEFAULT ''"],
    ["max_gas_limit", "INTEGER"],
    ["parameter_count", "INTEGER"],
    ["min_max_supply", "TEXT NOT NULL DEFAULT ''"],
    ["time_start", "TEXT NOT NULL DEFAULT ''"],
    ["time_end", "TEXT NOT NULL DEFAULT ''"],
    ["blocked_keywords_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["exclude_erc1155", "INTEGER NOT NULL DEFAULT 0"],
    ["excluded_platforms_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["confirmed_only", "INTEGER NOT NULL DEFAULT 1"],
    ["notify_only", "INTEGER NOT NULL DEFAULT 0"],
  ]
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE follow_mint_rules ADD COLUMN ${name} ${definition}`)
  }
  db.prepare("UPDATE follow_mint_rules SET rpc_profile_id = 'ethereum' WHERE lower(rpc_profile_id) = 'hk'").run()
}

export function normalizeFollowMintRule(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? "").trim()
  if (!name || name.length > 80) throw new Error("规则名称必须包含 1 到 80 个字符")
  const chainId = integer(input.chainId ?? existing.chainId ?? 1, "链编号", { min: 1, max: 10_000_000 })
  const sourceContract = optionalAddress(input.sourceContract ?? existing.sourceContract, "监听合约")
  const targetContract = optionalAddress(input.targetContract ?? existing.targetContract, "铸造合约")
  if (!sourceContract && !targetContract) throw new Error("请设置监听合约或铸造合约")
  const notifyOnly = asBoolean(input.notifyOnly, Boolean(existing.notifyOnly))
  const ids = walletIds(input.walletIds ?? existing.walletIds, { required: !notifyOnly })
  const eventValueMode = ["free", "any", "max"].includes(input.eventValueMode ?? existing.eventValueMode)
    ? (input.eventValueMode ?? existing.eventValueMode)
    : "free"

  return {
    name,
    chainId,
    rpcProfileId: String(input.rpcProfileId ?? existing.rpcProfileId ?? "main").trim().toLowerCase().replace(/^hk$/, "ethereum") || "main",
    rpcProfileRef: String(input.rpcProfileRef ?? existing.rpcProfileRef ?? "").trim(),
    sourceContract,
    targetContract,
    walletIds: ids,
    quantity: integer(input.quantity ?? existing.quantity ?? 1, "数量", { min: 1, max: 1000 }),
    tokenId: String(integer(input.tokenId ?? existing.tokenId ?? 0, "代币编号", { min: 0 })),
    concurrency: integer(input.concurrency ?? existing.concurrency ?? 5, "并发数", { min: 0, max: 32 }),
    minTriggerQuantity: integer(input.minTriggerQuantity ?? existing.minTriggerQuantity ?? 1, "触发数量", { min: 1, max: 1_000_000 }),
    maxTriggerQuantity: optionalInteger(input.maxTriggerQuantity ?? existing.maxTriggerQuantity, "最大触发数量", { min: 1, max: 1_000_000 }),
    maxMintCostEth: maxMintValue(input.maxMintCostEth ?? existing.maxMintCostEth),
    eventValueMode,
    maxEventValueEth: eventValueMode === "max" ? maxMintValue(input.maxEventValueEth ?? existing.maxEventValueEth) : "",
    maxGasLimit: optionalInteger(input.maxGasLimit ?? existing.maxGasLimit, "最大 Gas 上限", { min: 21_000 }),
    parameterCount: optionalInteger(input.parameterCount ?? existing.parameterCount, "参数数量", { min: 0, max: 1024 }),
    minMaxSupply: String(optionalInteger(input.minMaxSupply ?? existing.minMaxSupply, "最小最大供应量", { min: 1, max: Number.MAX_SAFE_INTEGER }) ?? ""),
    timeStart: timeOfDay(input.timeStart ?? existing.timeStart, "开始时间"),
    timeEnd: timeOfDay(input.timeEnd ?? existing.timeEnd, "结束时间"),
    blockedKeywords: keywords(input.blockedKeywords ?? existing.blockedKeywords),
    excludeErc1155: asBoolean(input.excludeErc1155, Boolean(existing.excludeErc1155)),
    excludedPlatforms: excludedPlatforms(input.excludedPlatforms ?? existing.excludedPlatforms),
    confirmedOnly: asBoolean(input.confirmedOnly, existing.confirmedOnly === undefined ? true : Boolean(existing.confirmedOnly)),
    notifyOnly,
    cooldownSeconds: integer(input.cooldownSeconds ?? existing.cooldownSeconds ?? 60, "冷却秒数", { min: 5, max: 86400 }),
    enabled: asBoolean(input.enabled, Boolean(existing.enabled)),
    oneShot: asBoolean(input.oneShot, existing.oneShot === undefined ? true : Boolean(existing.oneShot)),
  }
}

function eventMinutes(event) {
  const raw = event?.timestamp
  let date
  if (typeof raw === "number" || /^\d+$/.test(String(raw || ""))) {
    const number = Number(raw)
    date = new Date(number < 10_000_000_000 ? number * 1000 : number)
  } else date = raw ? new Date(raw) : new Date()
  if (!Number.isFinite(date.getTime())) date = new Date()
  return date.getHours() * 60 + date.getMinutes()
}

function configuredMinutes(value, fallback) {
  if (!value) return fallback
  const [hour, minute] = value.split(":").map(Number)
  return hour * 60 + minute
}

function inTimeWindow(rule, event) {
  if (!rule.timeStart && !rule.timeEnd) return true
  const current = eventMinutes(event)
  const start = configuredMinutes(rule.timeStart, 0)
  const end = configuredMinutes(rule.timeEnd, 23 * 60 + 59)
  return start <= end ? current >= start && current <= end : current >= start || current <= end
}

function eventInteger(value) {
  const text = String(value ?? "").trim()
  return /^\d+$/.test(text) ? BigInt(text) : null
}

export function evaluateFollowMintEvent(rule, event) {
  if (rule.confirmedOnly && event.confirmed === false) return { match: false, reason: "event_unconfirmed" }
  if (!inTimeWindow(rule, event)) return { match: false, reason: "outside_time_window" }

  const searchable = `${event.name || ""} ${event.symbol || ""}`.toLowerCase()
  const blocked = (rule.blockedKeywords || []).find((keyword) => searchable.includes(String(keyword).toLowerCase()))
  if (blocked) return { match: false, reason: `blocked_keyword:${blocked}` }

  const value = eventInteger(event.mintValueWei ?? event.valueWei)
  if (rule.eventValueMode === "free") {
    if (value === null) return { match: false, reason: "event_value_unavailable" }
    if (value !== 0n) return { match: false, reason: "paid_mint" }
  }
  if (rule.eventValueMode === "max") {
    if (value === null) return { match: false, reason: "event_value_unavailable" }
    if (value > parseEther(rule.maxEventValueEth || "0")) return { match: false, reason: "event_value_above_limit" }
  }

  if (rule.maxGasLimit !== null && rule.maxGasLimit !== undefined) {
    const gasLimit = eventInteger(event.gasLimit)
    if (gasLimit === null) return { match: false, reason: "gas_limit_unavailable" }
    if (gasLimit > BigInt(rule.maxGasLimit)) return { match: false, reason: "gas_limit_above_limit" }
  }
  if (rule.parameterCount !== null && rule.parameterCount !== undefined) {
    if (event.parameterCount === null || event.parameterCount === undefined || event.parameterCount === "") {
      return { match: false, reason: "parameter_count_unavailable" }
    }
    const count = Number(event.parameterCount)
    if (!Number.isSafeInteger(count)) return { match: false, reason: "parameter_count_unavailable" }
    if (count !== Number(rule.parameterCount)) return { match: false, reason: "parameter_count_mismatch" }
  }

  const quantity = Number(event.quantity || 0)
  if (!Number.isFinite(quantity) || quantity < rule.minTriggerQuantity) return { match: false, reason: "mint_quantity_below_limit" }
  if (rule.maxTriggerQuantity !== null && rule.maxTriggerQuantity !== undefined && quantity > rule.maxTriggerQuantity) {
    return { match: false, reason: "mint_quantity_above_limit" }
  }

  const maxSupply = eventInteger(event.maxSupply ?? event.max_supply)
  if (rule.minMaxSupply && maxSupply !== null && maxSupply < BigInt(rule.minMaxSupply)) {
    return { match: false, reason: "max_supply_below_limit" }
  }
  if (rule.excludeErc1155 && String(event.tokenStandard || "").toUpperCase() === "ERC1155") {
    return { match: false, reason: "erc1155_excluded" }
  }
  const platform = String(event.platform || "").toLowerCase()
  if (platform && (rule.excludedPlatforms || []).includes(platform)) {
    return { match: false, reason: `platform_excluded:${platform}` }
  }
  return { match: true, reason: "matched" }
}

export function createFollowMintService({
  db,
  monitor,
  chainIds,
  previewMint,
  sendMint,
  publicJob,
  validateWalletIds = () => {},
  getCollectionFlag = () => null,
  resolveRpcProfile = (profileId) => ({ id: String(profileId || "main") }),
  emitAlert = async () => {},
  createId = () => crypto.randomUUID(),
  armTtlMs = DEFAULT_ARM_TTL_MS,
}) {
  migrateFollowMint(db)
  const activeRules = new Set()
  const customProfileRefs = new Map()
  const unsubscribers = []

  const ruleById = (id) => hydrateRule(db.prepare("SELECT * FROM follow_mint_rules WHERE id = ?").get(id))

  function list() {
    return {
      rules: db.prepare("SELECT * FROM follow_mint_rules ORDER BY created_at DESC").all().map(hydrateRule),
      runs: db.prepare("SELECT * FROM follow_mint_runs ORDER BY id DESC LIMIT 200").all().map(hydrateRun),
    }
  }

  function ensureChain(rule) {
    if (rule.enabled) monitor.ensure(rule.chainId)
  }

  function create(input) {
    const rule = normalizeFollowMintRule(input)
    if (!rule.notifyOnly) validateWalletIds(rule.walletIds)
    if (!chainIds.includes(rule.chainId)) throw new Error("不支持当前链")
    const selectedProfile = resolveRpcProfile(rule.rpcProfileId, rule.chainId, rule.rpcProfileRef)
    rule.rpcProfileId = selectedProfile.id
    rule.rpcProfileRef = selectedProfile.profileRef || (selectedProfile.id === "custom" ? rule.rpcProfileRef : "")
    const id = createId()
    if (rule.rpcProfileId === "custom" && rule.rpcProfileRef) customProfileRefs.set(id, rule.rpcProfileRef)
    const createdAt = timestamp()
    db.prepare(`
      INSERT INTO follow_mint_rules (
        id, name, chain_id, rpc_profile_id, source_contract, target_contract, wallet_ids_json,
        quantity, token_id, concurrency, min_trigger_quantity, max_trigger_quantity,
        max_mint_cost_eth, event_value_mode, max_event_value_eth, max_gas_limit,
        parameter_count, min_max_supply, time_start, time_end, blocked_keywords_json,
        exclude_erc1155, excluded_platforms_json, confirmed_only, notify_only,
        cooldown_seconds, enabled, one_shot, mode, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, 'preview', ?, ?
      )
    `).run(
      id, rule.name, rule.chainId, rule.rpcProfileId, rule.sourceContract, rule.targetContract,
      JSON.stringify(rule.walletIds), rule.quantity, rule.tokenId, rule.concurrency,
      rule.minTriggerQuantity, rule.maxTriggerQuantity, rule.maxMintCostEth,
      rule.eventValueMode, rule.maxEventValueEth, rule.maxGasLimit, rule.parameterCount,
      rule.minMaxSupply, rule.timeStart, rule.timeEnd, JSON.stringify(rule.blockedKeywords),
      Number(rule.excludeErc1155), JSON.stringify(rule.excludedPlatforms), Number(rule.confirmedOnly), Number(rule.notifyOnly), rule.cooldownSeconds,
      Number(rule.enabled), Number(rule.oneShot), createdAt, createdAt,
    )
    const created = ruleById(id)
    ensureChain(created)
    return created
  }

  function update(id, input) {
    const existing = ruleById(id)
    if (!existing) return null
    const rule = normalizeFollowMintRule(input, existing)
    if (!rule.notifyOnly) validateWalletIds(rule.walletIds)
    if (!chainIds.includes(rule.chainId)) throw new Error("不支持当前链")
    if (rule.rpcProfileId === "custom" && !rule.rpcProfileRef) rule.rpcProfileRef = customProfileRefs.get(id) || ""
    const selectedProfile = resolveRpcProfile(rule.rpcProfileId, rule.chainId, rule.rpcProfileRef)
    rule.rpcProfileId = selectedProfile.id
    rule.rpcProfileRef = selectedProfile.profileRef || (selectedProfile.id === "custom" ? rule.rpcProfileRef : "")
    if (rule.rpcProfileId === "custom" && rule.rpcProfileRef) customProfileRefs.set(id, rule.rpcProfileRef)
    else customProfileRefs.delete(id)
    const mode = input.mode === "preview" ? "preview" : existing.mode
    const armedUntil = mode === "preview" ? null : existing.armedUntil
    db.prepare(`
      UPDATE follow_mint_rules SET
        name = ?, chain_id = ?, rpc_profile_id = ?, source_contract = ?, target_contract = ?, wallet_ids_json = ?,
        quantity = ?, token_id = ?, concurrency = ?, min_trigger_quantity = ?, max_trigger_quantity = ?,
        max_mint_cost_eth = ?, event_value_mode = ?, max_event_value_eth = ?, max_gas_limit = ?,
        parameter_count = ?, min_max_supply = ?, time_start = ?, time_end = ?, blocked_keywords_json = ?,
        exclude_erc1155 = ?, excluded_platforms_json = ?, confirmed_only = ?, notify_only = ?,
        cooldown_seconds = ?, enabled = ?, one_shot = ?,
        mode = ?, armed_until = ?, updated_at = ?
      WHERE id = ?
    `).run(
      rule.name, rule.chainId, rule.rpcProfileId, rule.sourceContract, rule.targetContract,
      JSON.stringify(rule.walletIds), rule.quantity, rule.tokenId, rule.concurrency,
      rule.minTriggerQuantity, rule.maxTriggerQuantity, rule.maxMintCostEth,
      rule.eventValueMode, rule.maxEventValueEth, rule.maxGasLimit, rule.parameterCount,
      rule.minMaxSupply, rule.timeStart, rule.timeEnd, JSON.stringify(rule.blockedKeywords),
      Number(rule.excludeErc1155), JSON.stringify(rule.excludedPlatforms), Number(rule.confirmedOnly), Number(rule.notifyOnly), rule.cooldownSeconds,
      Number(rule.enabled), Number(rule.oneShot), mode, armedUntil, timestamp(), id,
    )
    const updated = ruleById(id)
    ensureChain(updated)
    return updated
  }

  function remove(id) {
    const existing = ruleById(id)
    if (!existing) return false
    db.prepare("DELETE FROM follow_mint_rules WHERE id = ?").run(id)
    customProfileRefs.delete(id)
    return true
  }

  function arm(id, phrase) {
    if (String(phrase || "").trim() !== ARM_PHRASE) throw new Error(`请输入“${ARM_PHRASE}”以启用自动广播`)
    const existing = ruleById(id)
    if (!existing) return null
    const armedUntil = new Date(Date.now() + armTtlMs).toISOString()
    db.prepare("UPDATE follow_mint_rules SET mode = 'armed', armed_until = ?, updated_at = ? WHERE id = ?")
      .run(armedUntil, timestamp(), id)
    return ruleById(id)
  }

  function disarm(id) {
    const existing = ruleById(id)
    if (!existing) return null
    db.prepare("UPDATE follow_mint_rules SET mode = 'preview', armed_until = NULL, updated_at = ? WHERE id = ?")
      .run(timestamp(), id)
    return ruleById(id)
  }

  function insertRun(rule, event) {
    const createdAt = timestamp()
    const result = db.prepare(`
      INSERT INTO follow_mint_runs (rule_id, event_id, status, created_at, updated_at)
      VALUES (?, ?, 'preparing', ?, ?)
    `).run(rule.id, event?.id || "", createdAt, createdAt)
    return Number(result.lastInsertRowid)
  }

  function updateRun(id, values) {
    const current = hydrateRun(db.prepare("SELECT * FROM follow_mint_runs WHERE id = ?").get(id))
    if (!current) return null
    const snapshot = values.snapshot === undefined ? current.snapshot : values.snapshot
    db.prepare(`
      UPDATE follow_mint_runs SET status = ?, job_id = ?, error = ?, snapshot_json = ?, updated_at = ? WHERE id = ?
    `).run(
      values.status || current.status,
      values.jobId ?? current.jobId,
      values.error ?? current.error,
      JSON.stringify(snapshot || {}),
      timestamp(),
      id,
    )
    return hydrateRun(db.prepare("SELECT * FROM follow_mint_runs WHERE id = ?").get(id))
  }

  function eventHandled(rule, event) {
    if (!event?.id) return false
    return Boolean(db.prepare("SELECT 1 FROM follow_mint_runs WHERE rule_id = ? AND event_id = ? LIMIT 1").get(rule.id, event.id))
  }

  function recordSkipped(rule, event, reason) {
    if (eventHandled(rule, event)) return null
    const id = insertRun(rule, event)
    return updateRun(id, {
      status: "skipped",
      error: reason,
      snapshot: { event, decision: { matched: false, reason } },
    })
  }

  function mintBody(rule, event) {
    return {
      chainId: rule.chainId,
      walletIds: rule.walletIds,
      contractAddress: rule.targetContract || event?.address || rule.sourceContract,
      quantity: rule.quantity,
      tokenId: rule.tokenId,
      concurrency: rule.concurrency,
      maxMintCostEth: rule.maxMintCostEth,
      rpcProfileId: rule.rpcProfileId,
      rpcProfileRef: customProfileRefs.get(rule.id) || "",
    }
  }

  async function run(rule, event = null, { allowBroadcast = false } = {}) {
    if (activeRules.has(rule.id)) return null
    activeRules.add(rule.id)
    const runId = insertRun(rule, event)
    try {
      if (rule.profileStatus === "profile_retired") {
        updateRun(runId, { status: "profile_retired", error: "写入 RPC profile 已退役，请重新预览并选择新的 profile" })
        return hydrateRun(db.prepare("SELECT * FROM follow_mint_runs WHERE id = ?").get(runId))
      }
      if (rule.notifyOnly) {
        const snapshot = { event: event || null, decision: { matched: true, reason: "notify_only" } }
        await emitAlert({
          type: "follow_mint",
          chainId: rule.chainId,
          ruleId: rule.id,
          ruleName: rule.name,
          title: rule.name,
          message: event ? `${event.name || event.address} 命中跟单通知规则` : "跟单通知规则测试",
          subject: event ? { address: event.address, eventId: event.id } : null,
          sourceEvent: event || null,
        })
        updateRun(runId, { status: "notified", snapshot })
        if (event) {
          db.prepare("UPDATE follow_mint_rules SET last_event_id = ?, last_triggered_at = ?, enabled = ?, updated_at = ? WHERE id = ?")
            .run(event.id, timestamp(), Number(rule.oneShot ? false : rule.enabled), timestamp(), rule.id)
        }
        return hydrateRun(db.prepare("SELECT * FROM follow_mint_runs WHERE id = ?").get(runId))
      }
      const job = await previewMint(mintBody(rule, event))
      const snapshot = { event: event || null, decision: { matched: true, reason: "matched" }, job: publicJob(job) }
      const armed = allowBroadcast
        && rule.mode === "armed"
        && rule.armedUntil
        && Date.parse(rule.armedUntil) > Date.now()

      updateRun(runId, {
        status: armed ? "broadcasting" : "previewed",
        jobId: job.id,
        snapshot,
      })
      if (event) {
        db.prepare("UPDATE follow_mint_rules SET last_event_id = ?, last_triggered_at = ?, enabled = ?, updated_at = ? WHERE id = ?")
          .run(event.id, timestamp(), Number(rule.oneShot ? false : rule.enabled), timestamp(), rule.id)
      }

      if (allowBroadcast && rule.mode === "armed" && !armed) disarm(rule.id)
      if (armed) {
        await sendMint(job)
        updateRun(runId, { status: job.status, jobId: job.id, snapshot: { event: event || null, decision: { matched: true, reason: "matched" }, job: publicJob(job) } })
      }
      return hydrateRun(db.prepare("SELECT * FROM follow_mint_runs WHERE id = ?").get(runId))
    } catch (error) {
      return updateRun(runId, { status: "failed", error: error instanceof Error ? error.message : String(error) })
    } finally {
      activeRules.delete(rule.id)
    }
  }

  async function handleEvent(event) {
    if (event?.type !== "mint" || !event.id || !event.address) return
    const candidates = db.prepare("SELECT * FROM follow_mint_rules WHERE enabled = 1 AND chain_id = ?")
      .all(Number(event.chainId)).map(hydrateRule)
    for (const rule of candidates) {
      if (rule.sourceContract && rule.sourceContract.toLowerCase() !== String(event.address).toLowerCase()) continue
      if (eventHandled(rule, event)) continue
      const localFlag = getCollectionFlag(Number(event.chainId), event.address)
      if (localFlag && ["scam", "blocked"].includes(localFlag.flag)) {
        recordSkipped(rule, event, `collection_flagged:${localFlag.flag}`)
        continue
      }
      const decision = evaluateFollowMintEvent(rule, event)
      if (!decision.match) {
        recordSkipped(rule, event, decision.reason)
        continue
      }
      if (rule.lastEventId === event.id) {
        recordSkipped(rule, event, "duplicate_event")
        continue
      }
      if (rule.lastTriggeredAt && Date.now() - Date.parse(rule.lastTriggeredAt) < rule.cooldownSeconds * 1000) {
        recordSkipped(rule, event, "cooldown_active")
        continue
      }
      if (activeRules.has(rule.id)) {
        recordSkipped(rule, event, "rule_already_running")
        continue
      }
      void run(rule, event, { allowBroadcast: true })
    }
  }

  async function preview(id) {
    const rule = ruleById(id)
    if (!rule) return null
    return run(rule, null, { allowBroadcast: false })
  }

  function start() {
    for (const chainId of chainIds) {
      unsubscribers.push(monitor.subscribe(chainId, (event) => void handleEvent(event)))
    }
    for (const rule of list().rules) ensureChain(rule)
  }

  function stop() {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  }

  return { list, create, update, remove, arm, disarm, preview, handleEvent, start, stop, ruleById }
}

export { ARM_PHRASE }
