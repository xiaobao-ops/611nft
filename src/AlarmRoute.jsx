import {
  Bell,
  Edit3,
  RefreshCcw,
  ShieldAlert,
  Trash2,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { requestJson } from "./api.js"
import { readStoredChainId, resolveSupportedChainId, saveStoredChainId } from "./chain-preference.js"
import {
  readAlertPreferences,
  rememberAlertId,
  TRENDING_WINDOWS,
  writeAlertPreferences,
} from "./monitor-intelligence.js"
import { uiError } from "./ui-text.js"
import "./utility-routes.css"

const WINDOW_LABELS = {
  60: "1 分钟",
  300: "5 分钟",
  600: "10 分钟",
  1800: "30 分钟",
  3600: "1 小时",
  21600: "6 小时",
  43200: "12 小时",
  86400: "24 小时",
}

const EMPTY_ALERT_DRAFT = Object.freeze({
  type: "trending",
  name: "",
  window: "60",
  threshold: "10",
  address: "",
  leadMinutes: "10",
  cooldownSeconds: "60",
  enabled: true,
})

function emptyDraft() {
  return { ...EMPTY_ALERT_DRAFT }
}

function alertDraft(rule) {
  if (!rule) return emptyDraft()
  return {
    type: rule.type,
    name: rule.name || "",
    window: String(rule.params?.window ?? 60),
    threshold: String(rule.params?.threshold ?? 10),
    address: rule.params?.address || "",
    leadMinutes: String(rule.params?.leadMinutes ?? 10),
    cooldownSeconds: String(rule.cooldownSeconds ?? 60),
    enabled: Boolean(rule.enabled),
  }
}

function alertInput(draft) {
  const address = draft.address.trim()
  const params = draft.type === "trending"
    ? { window: Number(draft.window), threshold: Number(draft.threshold) }
    : draft.type === "seadrop_start"
      ? { leadMinutes: Number(draft.leadMinutes), ...(address ? { address } : {}) }
      : { address }
  return {
    type: draft.type,
    name: draft.name.trim(),
    enabled: draft.enabled,
    cooldownSeconds: Number(draft.cooldownSeconds),
    params,
  }
}

function alertTypeLabel(value) {
  return {
    trending: "趋势阈值",
    contract_mint: "合约开铸",
    seadrop_start: "SeaDrop 开售",
    wallet_activity: "钱包活动",
  }[value] || "报警规则"
}

function shortAddress(value) {
  const text = String(value || "")
  return text.length > 13 ? `${text.slice(0, 7)}...${text.slice(-5)}` : text || "—"
}

function alertRuleSummary(rule) {
  if (rule.type === "trending") {
    return `${WINDOW_LABELS[rule.params?.window] || `${rule.params?.window || "—"} 秒`} >= ${rule.params?.threshold ?? "—"}`
  }
  if (rule.type === "seadrop_start") {
    return `提前 ${rule.params?.leadMinutes ?? 0} 分钟${rule.params?.address ? ` · ${shortAddress(rule.params.address)}` : ""}`
  }
  return shortAddress(rule.params?.address)
}

function alertTitle(value) {
  return String(value?.title || value?.ruleName || "NFT TOOL 监控报警").slice(0, 120)
}

function displayError(error) {
  return uiError(error?.message || error) || "请求失败，请检查本地服务状态。"
}

function Toggle({ checked, children, onChange, disabled = false }) {
  return (
    <label className="utilityToggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

export default function AlarmRoute() {
  const [chains, setChains] = useState([])
  const [chainId, setChainId] = useState(readStoredChainId)
  const [alerts, setAlerts] = useState({ rules: [], notifier: null, loading: true, error: "" })
  const [history, setHistory] = useState([])
  const [preferences, setPreferences] = useState(readAlertPreferences)
  const [draft, setDraft] = useState(emptyDraft)
  const [editingId, setEditingId] = useState("")
  const [streamState, setStreamState] = useState("connecting")
  const alertRequestId = useRef(0)
  const chainIdRef = useRef(chainId)
  const preferenceRef = useRef(preferences)
  const seenAlertIds = useRef([])
  const audioContext = useRef(null)
  chainIdRef.current = chainId
  preferenceRef.current = preferences

  const setDraftValue = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

  const playTone = useCallback(async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    const context = audioContext.current || new AudioContextClass()
    audioContext.current = context
    if (context.state === "suspended") await context.resume()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = "sine"
    oscillator.frequency.setValueAtTime(740, context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(1040, context.currentTime + 0.12)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.21)
  }, [])

  const publishAlert = useCallback((value) => {
    if (value?.chainId && Number(value.chainId) !== Number(chainIdRef.current)) return false
    const id = String(value?.id || `${value?.ruleId || "alert"}:${value?.triggeredAt || Date.now()}`)
    const remembered = rememberAlertId(seenAlertIds.current, id)
    if (remembered.duplicate) return false
    seenAlertIds.current = remembered.ids
    const alert = { ...value, id, title: alertTitle(value) }
    setHistory((current) => [alert, ...current.filter((item) => item.id !== id)].slice(0, 30))
    if (preferenceRef.current.sound) void playTone().catch(() => {})
    if (preferenceRef.current.desktop && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(alert.title, {
          body: String(alert.message || "检测到新的监控事件"),
          tag: id,
        })
      } catch {
        // The in-app history remains the source of truth when native notifications fail.
      }
    }
    return true
  }, [playTone])

  const loadAlerts = useCallback(async ({ quiet = false, signal } = {}) => {
    const requestId = ++alertRequestId.current
    if (!quiet) setAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await requestJson(`/api/alerts?chainId=${Number(chainId)}`, { signal })
      if (requestId !== alertRequestId.current) return null
      setAlerts({
        rules: Array.isArray(data.rules) ? data.rules : [],
        notifier: data.notifier || null,
        loading: false,
        error: "",
      })
      return data
    } catch (error) {
      if (error.name === "AbortError" || requestId !== alertRequestId.current) return null
      setAlerts((current) => ({ ...current, loading: false, error: displayError(error) }))
      return null
    }
  }, [chainId])

  useEffect(() => {
    const controller = new AbortController()
    void requestJson("/api/chains", { signal: controller.signal }).then((data) => {
      const nextChains = Array.isArray(data.chains) ? data.chains : []
      setChains(nextChains)
      setChainId((current) => resolveSupportedChainId(current, nextChains))
    }).catch((error) => {
      if (error.name !== "AbortError") {
        setAlerts((current) => ({ ...current, loading: false, error: displayError(error) }))
      }
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    saveStoredChainId(chainId)
    seenAlertIds.current = []
    setHistory([])
    const controller = new AbortController()
    void loadAlerts({ signal: controller.signal })
    return () => controller.abort()
  }, [chainId, loadAlerts])

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setStreamState("unsupported")
      return undefined
    }
    setStreamState("connecting")
    const events = new EventSource(`/api/mint-monitor/stream?chainId=${Number(chainId)}`)
    events.onopen = () => setStreamState("connected")
    events.onmessage = (message) => {
      try {
        const value = JSON.parse(message.data)
        if (value.type === "monitor_alert") publishAlert(value)
      } catch {
        // A malformed event must not terminate the remaining stream.
      }
    }
    events.onerror = () => setStreamState("offline")
    return () => events.close()
  }, [chainId, publishAlert])

  useEffect(() => () => {
    void audioContext.current?.close?.().catch(() => {})
  }, [])

  async function changePreference(key, enabled) {
    let accepted = Boolean(enabled)
    if (key === "desktop" && accepted) {
      accepted = typeof Notification !== "undefined" && await Notification.requestPermission() === "granted"
      if (!accepted) {
        setAlerts((current) => ({ ...current, error: "浏览器未授予桌面通知权限" }))
      }
    }
    const next = writeAlertPreferences(window.localStorage, { ...preferenceRef.current, [key]: accepted })
    preferenceRef.current = next
    setPreferences(next)
    if (key === "sound" && accepted) void playTone().catch(() => {})
  }

  async function createRule(input) {
    const operationChainId = Number(chainId)
    setAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await requestJson("/api/alerts", {
        method: "POST",
        body: JSON.stringify({ ...input, chainId: operationChainId }),
      })
      if (chainIdRef.current !== operationChainId) return null
      setAlerts((current) => ({ ...current, rules: [data.rule, ...current.rules], loading: false }))
      return data.rule
    } catch (error) {
      setAlerts((current) => ({ ...current, loading: false, error: displayError(error) }))
      return null
    }
  }

  async function updateRule(id, input) {
    const operationChainId = Number(chainId)
    setAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await requestJson(`/api/alerts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      })
      if (chainIdRef.current !== operationChainId) return null
      setAlerts((current) => ({
        ...current,
        rules: current.rules.map((rule) => rule.id === id ? data.rule : rule),
        loading: false,
      }))
      return data.rule
    } catch (error) {
      setAlerts((current) => ({ ...current, loading: false, error: displayError(error) }))
      return null
    }
  }

  async function deleteRule(id) {
    const operationChainId = Number(chainId)
    setAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      await requestJson(`/api/alerts/${encodeURIComponent(id)}`, { method: "DELETE" })
      if (chainIdRef.current !== operationChainId) return
      setAlerts((current) => ({
        ...current,
        rules: current.rules.filter((rule) => rule.id !== id),
        loading: false,
      }))
    } catch (error) {
      setAlerts((current) => ({ ...current, loading: false, error: displayError(error) }))
    }
  }

  async function testAlert() {
    const operationChainId = Number(chainId)
    setAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await requestJson("/api/alerts/test", {
        method: "POST",
        body: JSON.stringify({
          chainId: operationChainId,
          title: "NFT TOOL 测试报警",
          message: "浏览器与通知通道测试",
        }),
      })
      if (chainIdRef.current !== operationChainId) return
      publishAlert(data.alert)
      setAlerts((current) => ({ ...current, loading: false }))
    } catch (error) {
      setAlerts((current) => ({ ...current, loading: false, error: displayError(error) }))
    }
  }

  async function submitRule(event) {
    event.preventDefault()
    const input = alertInput(draft)
    const rule = editingId ? await updateRule(editingId, input) : await createRule(input)
    if (!rule) return
    setEditingId("")
    setDraft(emptyDraft())
  }

  function editRule(rule) {
    setEditingId(rule.id)
    setDraft(alertDraft(rule))
  }

  const chain = chains.find((item) => Number(item.id) === Number(chainId))
  const enabledCount = alerts.rules.filter((rule) => rule.enabled).length
  const streamConnected = streamState === "connected"

  return (
    <section className="utilityRoute" aria-label="报警监控">
      <div className="utilityToolbar">
        <div className="utilityToolbarCopy">
          <strong>报警规则</strong>
          <span>按所选链管理趋势、合约、SeaDrop 与钱包活动通知</span>
        </div>
        <div className="utilityToolbarActions">
          <label className="utilitySelect">
            <span>监控链</span>
            <select value={chainId} disabled={!chains.length || alerts.loading} onChange={(event) => setChainId(Number(event.target.value))}>
              {chains.length ? chains.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value={chainId}>链 {chainId}</option>}
            </select>
          </label>
          <span className={streamConnected ? "streamBadge connected" : "streamBadge"} title={`实时通道：${streamState}`}>
            {streamConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
            {streamConnected ? "实时已连接" : streamState === "connecting" ? "正在连接" : "实时已断开"}
          </span>
          <button className="utilityButton" type="button" disabled={alerts.loading} onClick={() => void loadAlerts()}>
            <RefreshCcw className={alerts.loading ? "spin" : ""} size={15} />刷新
          </button>
        </div>
      </div>

      <div className="alarmPreferences">
        <div className="alarmPreferenceTitle">
          <Bell size={17} />
          <span><strong>浏览器报警</strong><small>{typeof Notification === "undefined" ? "桌面通知未支持" : `桌面权限：${Notification.permission}`}</small></span>
        </div>
        <Toggle checked={preferences.sound} disabled={alerts.loading} onChange={(value) => void changePreference("sound", value)}>
          {preferences.sound ? <Volume2 size={14} /> : <VolumeX size={14} />}声音
        </Toggle>
        <Toggle checked={preferences.desktop} disabled={alerts.loading} onChange={(value) => void changePreference("desktop", value)}>
          桌面通知
        </Toggle>
        <span className={alerts.notifier?.enabled ? "notifierBadge active" : "notifierBadge"}>Telegram {alerts.notifier?.enabled ? "已配置" : "未配置"}</span>
        <button className="utilityButton" type="button" disabled={alerts.loading} onClick={() => void testAlert()}><Bell size={14} />测试通道</button>
        <span className="alarmChainSummary">{chain?.name || `链 ${chainId}`} · {enabledCount}/{alerts.rules.length} 条规则启用</span>
      </div>

      {alerts.error ? <div className="utilityError" role="alert"><ShieldAlert size={16} />{alerts.error}</div> : null}

      <div className="alarmLayout">
        <form className="alarmRuleForm" onSubmit={(event) => void submitRule(event)}>
          <header>
            <strong>{editingId ? "编辑报警规则" : "新建报警规则"}</strong>
            {editingId ? <button type="button" onClick={() => { setEditingId(""); setDraft(emptyDraft()) }}>结束编辑</button> : null}
          </header>
          <label><span>类型</span><select value={draft.type} onChange={(event) => setDraftValue("type", event.target.value)}><option value="trending">趋势阈值</option><option value="contract_mint">合约开铸</option><option value="seadrop_start">SeaDrop 开售</option><option value="wallet_activity">钱包活动</option></select></label>
          <label><span>名称</span><input value={draft.name} maxLength="120" onChange={(event) => setDraftValue("name", event.target.value)} placeholder={alertTypeLabel(draft.type)} /></label>
          {draft.type === "trending" ? <div className="alarmFieldPair"><label><span>窗口</span><select value={draft.window} onChange={(event) => setDraftValue("window", event.target.value)}>{TRENDING_WINDOWS.map((seconds) => <option value={seconds} key={seconds}>{WINDOW_LABELS[seconds]}</option>)}</select></label><label><span>铸造阈值</span><input type="number" min="1" max="1000000" required value={draft.threshold} onChange={(event) => setDraftValue("threshold", event.target.value)} /></label></div> : null}
          {["contract_mint", "wallet_activity", "seadrop_start"].includes(draft.type) ? <label><span>{draft.type === "wallet_activity" ? "钱包地址" : "合约地址"}{draft.type === "seadrop_start" ? "（可选）" : ""}</span><input value={draft.address} required={draft.type !== "seadrop_start"} pattern="0x[a-fA-F0-9]{40}" onChange={(event) => setDraftValue("address", event.target.value)} placeholder="0x..." spellCheck="false" /></label> : null}
          {draft.type === "seadrop_start" ? <label><span>提前分钟</span><input type="number" min="0" max="10080" required value={draft.leadMinutes} onChange={(event) => setDraftValue("leadMinutes", event.target.value)} /></label> : null}
          <div className="alarmFieldPair"><label><span>冷却秒数</span><input type="number" min="0" max="604800" required value={draft.cooldownSeconds} onChange={(event) => setDraftValue("cooldownSeconds", event.target.value)} /></label><Toggle checked={draft.enabled} disabled={alerts.loading} onChange={(value) => setDraftValue("enabled", value)}>立即启用</Toggle></div>
          <button className="utilityPrimaryButton" type="submit" disabled={alerts.loading}><Bell size={15} />{editingId ? "保存修改" : "创建规则"}</button>
        </form>

        <section className="alarmRuleList" aria-label="报警规则列表">
          <header><strong>现有规则</strong><span>{enabledCount}/{alerts.rules.length} 启用</span></header>
          <div className="alarmRuleRows" aria-live="polite">
            {alerts.rules.map((rule) => (
              <article className="alarmRuleRow" key={rule.id}>
                <span className={rule.enabled ? "alarmRuleStatus active" : "alarmRuleStatus"} aria-label={rule.enabled ? "已启用" : "已暂停"} />
                <span className="alarmRuleIdentity"><strong>{rule.name}</strong><small>{alertTypeLabel(rule.type)} · {alertRuleSummary(rule)}</small></span>
                <span className="alarmCooldown"><small>冷却</small><strong>{rule.cooldownSeconds}s</strong></span>
                <span className="alarmRuleActions">
                  <button type="button" disabled={alerts.loading} onClick={() => void updateRule(rule.id, { enabled: !rule.enabled })}>{rule.enabled ? "暂停" : "启用"}</button>
                  <button className="iconButton" type="button" disabled={alerts.loading} onClick={() => editRule(rule)} aria-label={`编辑 ${rule.name}`} title="编辑"><Edit3 size={14} /></button>
                  <button className="iconButton danger" type="button" disabled={alerts.loading} onClick={() => { if (window.confirm(`删除报警规则“${rule.name}”？`)) void deleteRule(rule.id) }} aria-label={`删除 ${rule.name}`} title="删除"><Trash2 size={14} /></button>
                </span>
              </article>
            ))}
            {!alerts.rules.length ? <div className="utilityEmpty"><Bell size={20} /><strong>{alerts.loading ? "正在读取报警规则" : "暂无报警规则"}</strong></div> : null}
          </div>
        </section>
      </div>

      <section className="alarmHistory" aria-label="最近报警">
        <header><strong>最近报警</strong><span>{history.length}</span></header>
        <div aria-live="polite">
          {history.map((alert) => <article key={alert.id}><Bell size={14} /><span><strong>{alert.title}</strong><small>{alert.message || "检测到新的监控事件"}</small></span><time>{alert.triggeredAt && Number.isFinite(Date.parse(alert.triggeredAt)) ? new Date(alert.triggeredAt).toLocaleTimeString("zh-CN") : "刚刚"}</time></article>)}
          {!history.length ? <div className="utilityEmpty compact">当前会话暂无报警</div> : null}
        </div>
      </section>
    </section>
  )
}
