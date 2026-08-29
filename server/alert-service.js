import { randomUUID } from "node:crypto"

const ALERT_TYPES = new Set(["trending", "contract_mint", "seadrop_start", "wallet_activity"])
const TRENDING_WINDOWS = new Set([60, 300, 600, 1800, 3600, 21600, 43200, 86400])

function timestamp(value) {
  return new Date(value).toISOString()
}

function bool(value, fallback = true) {
  if (value === undefined || value === null) return fallback
  return value === true || value === 1 || value === "1" || value === "true"
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER, label = "数值" } = {}) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}无效`)
  return parsed
}

function address(value, { optional = false } = {}) {
  const normalized = String(value || "").trim().toLowerCase()
  if (optional && !normalized) return ""
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new Error("地址无效")
  return normalized
}

function normalizeParams(type, value = {}) {
  const params = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  if (type === "trending") {
    const window = integer(params.window ?? 60, { min: 1, max: 86400, label: "热度窗口" })
    if (!TRENDING_WINDOWS.has(window)) throw new Error("热度窗口无效")
    return { window, threshold: integer(params.threshold ?? 1, { min: 1, max: 1_000_000, label: "报警阈值" }) }
  }
  if (type === "contract_mint") return { address: address(params.address) }
  if (type === "seadrop_start") {
    return {
      leadMinutes: integer(params.leadMinutes ?? 10, { min: 0, max: 10080, label: "提前分钟数" }),
      ...(params.address ? { address: address(params.address) } : {}),
    }
  }
  if (type === "wallet_activity") return { address: address(params.address) }
  throw new Error("报警类型无效")
}

export function normalizeAlertRule(input = {}, existing = {}) {
  const type = String(input.type ?? existing.type ?? "").trim()
  if (!ALERT_TYPES.has(type)) throw new Error("报警类型无效")
  const chainId = integer(input.chainId ?? existing.chainId, { min: 1, label: "链编号" })
  const name = String(input.name ?? existing.name ?? "").trim().slice(0, 120)
  return {
    type,
    chainId,
    name: name || ({
      trending: "热度阈值",
      contract_mint: "关注合集开始铸造",
      seadrop_start: "SeaDrop 即将开售",
      wallet_activity: "关注钱包活动",
    })[type],
    params: normalizeParams(type, input.params ?? existing.params),
    enabled: bool(input.enabled, existing.enabled ?? true),
    cooldownSeconds: integer(input.cooldownSeconds ?? existing.cooldownSeconds ?? 0, { min: 0, max: 604800, label: "冷却时间" }),
  }
}

export function toMonitorAlertEvent(alert = {}, { createId = randomUUID, now = Date.now } = {}) {
  const alertType = String(alert.alertType || alert.type || "").trim()
  return {
    ...alert,
    id: alert.id || String(createId()),
    type: "monitor_alert",
    alertType,
    triggeredAt: alert.triggeredAt || timestamp(now()),
  }
}

export function migrateAlertRules(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cooldown_seconds INTEGER NOT NULL DEFAULT 0,
      last_trigger_key TEXT NOT NULL DEFAULT '',
      last_triggered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled_chain
      ON alert_rules(enabled, chain_id, type);
    CREATE TABLE IF NOT EXISTS alert_deliveries (
      rule_id TEXT NOT NULL,
      trigger_key TEXT NOT NULL,
      alert_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, trigger_key),
      FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
    );
  `)
}

function hydrate(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    chainId: Number(row.chain_id),
    name: row.name,
    params: JSON.parse(row.params_json || "{}"),
    enabled: Boolean(row.enabled),
    cooldownSeconds: Number(row.cooldown_seconds || 0),
    lastTriggerKey: row.last_trigger_key || "",
    lastTriggeredAt: row.last_triggered_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function eventKey(event, fallback) {
  return String(event?.id || event?.txHash || event?.snapshotId || fallback || "")
}

function candidatesFor(rule, event, nowMs) {
  if (rule.type === "trending" && event.type === "trending_snapshot") {
    if (Number(event.window) !== rule.params.window) return []
    return (event.collections || []).filter((item) => Number(item.mintCount || 0) >= rule.params.threshold).map((item) => ({
      key: `${eventKey(event, nowMs)}:${String(item.address || "").toLowerCase()}`,
      subject: item,
      metrics: { window: rule.params.window, threshold: rule.params.threshold, mintCount: Number(item.mintCount || 0) },
      message: `${item.name || item.address || "合集"} 在 ${rule.params.window} 秒内铸造 ${Number(item.mintCount || 0)} 个`,
    }))
  }
  if (rule.type === "contract_mint" && (event.type === "mint" || event.type === "mint_batch")) {
    if (String(event.address || "").toLowerCase() !== rule.params.address) return []
    return [{
      key: eventKey(event, `${event.address}:${event.timestamp || nowMs}`),
      subject: { address: event.address, name: event.name || event.tokenName || "" },
      metrics: { quantity: Number(event.count || event.quantity || 1) },
      message: `${event.name || event.tokenName || event.address} 已开始铸造`,
    }]
  }
  if (rule.type === "seadrop_start" && event.type === "seadrop_radar") {
    const leadMs = rule.params.leadMinutes * 60_000
    return (event.drops || []).filter((drop) => {
      if (rule.params.address && String(drop.contract || "").toLowerCase() !== rule.params.address) return false
      const startsAt = Date.parse(drop.startTime)
      return Number.isFinite(startsAt) && startsAt >= nowMs && startsAt - nowMs <= leadMs
    }).map((drop) => ({
      key: `${eventKey(event, nowMs)}:${drop.id || `${drop.contract}:${drop.startTime}`}`,
      subject: drop,
      metrics: { leadMinutes: Math.max(0, Math.ceil((Date.parse(drop.startTime) - nowMs) / 60_000)) },
      message: `${drop.name || drop.contract || "SeaDrop"} 将于 ${drop.startTime} 开售`,
    }))
  }
  if (rule.type === "wallet_activity" && event.type === "wallet_activity") {
    const observed = [event.address, event.from, event.to].map((item) => String(item || "").toLowerCase())
    if (!observed.includes(rule.params.address)) return []
    return [{
      key: eventKey(event, `${rule.params.address}:${event.timestamp || nowMs}`),
      subject: { address: rule.params.address, txHash: event.txHash || "" },
      metrics: {},
      message: `关注钱包 ${rule.params.address} 出现新活动`,
    }]
  }
  return []
}

export function createAlertService({ db, createId = randomUUID, now = Date.now, notify = null } = {}) {
  if (!db) throw new Error("报警服务需要数据库")
  migrateAlertRules(db)
  const listeners = new Set()
  const byId = (id) => hydrate(db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(String(id)))

  function list({ chainId } = {}) {
    const rows = chainId === undefined
      ? db.prepare("SELECT * FROM alert_rules ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM alert_rules WHERE chain_id = ? ORDER BY created_at DESC").all(Number(chainId))
    return { rules: rows.map(hydrate) }
  }

  function create(input) {
    const rule = normalizeAlertRule(input)
    const id = String(createId())
    const createdAt = timestamp(now())
    db.prepare(`
      INSERT INTO alert_rules (id, type, chain_id, name, params_json, enabled, cooldown_seconds, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, rule.type, rule.chainId, rule.name, JSON.stringify(rule.params), Number(rule.enabled), rule.cooldownSeconds, createdAt, createdAt)
    return byId(id)
  }

  function update(id, input) {
    const existing = byId(id)
    if (!existing) return null
    const rule = normalizeAlertRule(input, existing)
    db.prepare(`
      UPDATE alert_rules SET type = ?, chain_id = ?, name = ?, params_json = ?, enabled = ?, cooldown_seconds = ?, updated_at = ?
      WHERE id = ?
    `).run(rule.type, rule.chainId, rule.name, JSON.stringify(rule.params), Number(rule.enabled), rule.cooldownSeconds, timestamp(now()), existing.id)
    return byId(existing.id)
  }

  function remove(id) {
    return db.prepare("DELETE FROM alert_rules WHERE id = ?").run(String(id)).changes > 0
  }

  function publish(alert) {
    for (const listener of listeners) listener(alert)
    if (typeof notify === "function") Promise.resolve(notify(alert)).catch(() => {})
  }

  function evaluate(event) {
    const chainId = Number(event?.chainId)
    if (!Number.isInteger(chainId)) return []
    const nowMs = Number(now())
    const rules = db.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND chain_id = ? AND type = ?")
      .all(chainId, event.type === "mint_batch" ? "contract_mint" : ({
        trending_snapshot: "trending",
        mint: "contract_mint",
        seadrop_radar: "seadrop_start",
        wallet_activity: "wallet_activity",
      })[event.type] || "")
      .map(hydrate)
    const alerts = []
    for (const rule of rules) {
      if (rule.lastTriggeredAt && rule.cooldownSeconds > 0 && nowMs - Date.parse(rule.lastTriggeredAt) < rule.cooldownSeconds * 1000) continue
      for (const candidate of candidatesFor(rule, event, nowMs)) {
        const alert = {
          id: String(createId()),
          type: rule.type,
          ruleId: rule.id,
          ruleName: rule.name,
          chainId,
          triggeredAt: timestamp(nowMs),
          title: rule.name,
          message: candidate.message,
          subject: candidate.subject,
          metrics: candidate.metrics,
          sourceEventId: eventKey(event, candidate.key),
        }
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO alert_deliveries (rule_id, trigger_key, alert_json, created_at)
          VALUES (?, ?, ?, ?)
        `).run(rule.id, candidate.key, JSON.stringify(alert), alert.triggeredAt)
        if (!inserted.changes) continue
        db.prepare("UPDATE alert_rules SET last_trigger_key = ?, last_triggered_at = ?, updated_at = ? WHERE id = ?")
          .run(candidate.key, alert.triggeredAt, alert.triggeredAt, rule.id)
        alerts.push(alert)
        publish(alert)
      }
    }
    return alerts
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { list, create, update, remove, evaluate, subscribe, byId }
}
