import { Activity, Bell, Bot, Check, Pause, Play, Plus, RefreshCcw, ShieldAlert, Trash2, Zap } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { uiDecisionReason, uiError, uiStatus } from "./ui-text.js"
import WalletTableSelector from "./WalletTableSelector.jsx"

const emptyForm = {
  name: "",
  sourceContract: "",
  targetContract: "",
  quantity: "1",
  tokenId: "0",
  concurrency: "5",
  minTriggerQuantity: "1",
  maxTriggerQuantity: "",
  maxMintCostEth: "",
  eventValueMode: "free",
  maxEventValueEth: "",
  maxGasLimit: "",
  parameterCount: "",
  minMaxSupply: "",
  timeStart: "",
  timeEnd: "",
  blockedKeywords: "",
  excludeErc1155: false,
  excludedPlatforms: [],
  confirmedOnly: true,
  notifyOnly: false,
  cooldownSeconds: "60",
  enabled: true,
  oneShot: true,
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败：${path}`)
  return data
}

function short(value) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "任意"
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "从未"
}

function followRunStatus(value) {
  return value === "notified" ? "已通知" : uiStatus(value)
}

function followDecisionReason(value) {
  return value === "notify_only" ? "仅通知，不生成交易" : uiDecisionReason(value)
}

function WalletSelection({ wallets, selectedIds, onChange, chainId, notifyOnly = false }) {
  return <WalletTableSelector wallets={wallets} selectedIds={selectedIds} onChange={onChange} chainId={chainId} title={notifyOnly ? "通知规则钱包（可选）" : "执行钱包"} compact />
}

export default function FollowMintView({ wallets, chain, selectedIds, onSelectedIdsChange }) {
  const [data, setData] = useState({ rules: [], runs: [] })
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [armRuleId, setArmRuleId] = useState("")
  const [armPhrase, setArmPhrase] = useState("")
  const runsByRule = useMemo(() => {
    const map = new Map()
    for (const run of data.runs) {
      if (!map.has(run.ruleId)) map.set(run.ruleId, [])
      map.get(run.ruleId).push(run)
    }
    return map
  }, [data.runs])

  async function load({ quiet = false } = {}) {
    if (!quiet) setBusy(true)
    try {
      const next = await request("/api/follow-mint")
      setData({ rules: next.rules || [], runs: next.runs || [] })
      setError("")
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      if (!quiet) setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load({ quiet: true }), 5000)
    return () => window.clearInterval(timer)
  }, [])

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function togglePlatform(platform) {
    setForm((current) => ({
      ...current,
      excludedPlatforms: current.excludedPlatforms.includes(platform)
        ? current.excludedPlatforms.filter((item) => item !== platform)
        : [...current.excludedPlatforms, platform],
    }))
  }

  async function perform(action, success) {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const result = await action()
      setNotice(success)
      await load({ quiet: true })
      return result
    } catch (actionError) {
      setError(actionError.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function createRule(event) {
    event.preventDefault()
    const result = await perform(() => request("/api/follow-mint/rules", {
      method: "POST",
      body: JSON.stringify({
        ...form,
        chainId: chain?.id,
        walletIds: selectedIds,
      }),
    }), "跟单规则已保存；实时监听使用当前链 RPC。")
    if (result) setForm(emptyForm)
  }

  async function toggleRule(rule) {
    await perform(() => request(`/api/follow-mint/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...rule, enabled: !rule.enabled, mode: rule.mode }),
    }), rule.enabled ? "规则已暂停。" : "规则已开始监听。")
  }

  async function previewRule(rule) {
    const result = await perform(() => request(`/api/follow-mint/rules/${rule.id}/preview`, {
      method: "POST",
      body: "{}",
    }), rule.notifyOnly ? "测试通知已提交。" : "已使用真实钱包、合约字节码、报价、Gas 和余额生成预览。")
    if (result?.run?.status === "failed") setError(result.run.error || "预览失败")
  }

  async function armRule(rule) {
    await perform(() => request(`/api/follow-mint/rules/${rule.id}/arm`, {
      method: "POST",
      body: JSON.stringify({ phrase: armPhrase }),
    }), "规则已在一小时内启用自动广播。")
    setArmPhrase("")
    setArmRuleId("")
  }

  async function disarmRule(rule) {
    await perform(() => request(`/api/follow-mint/rules/${rule.id}/disarm`, {
      method: "POST",
      body: "{}",
    }), "自动广播已关闭，后续命中只生成预览。")
  }

  async function deleteRule(rule) {
    if (!window.confirm(`删除跟单规则“${rule.name}”？`)) return
    await perform(() => request(`/api/follow-mint/rules/${rule.id}`, { method: "DELETE" }), "规则已删除。")
  }

  return (
    <div className="sectionStack followMintWorkspace">
      <div className="sectionHeader">
        <div>
          <h1>跟单 / 自动铸造</h1>
          <p>监听真实铸造日志，命中规则后重新获取项目报价并逐钱包预检。</p>
        </div>
        <button className="btn" type="button" onClick={() => load()} disabled={busy}><RefreshCcw size={15} className={busy ? "spin" : ""} />刷新</button>
      </div>

      <div className="followStatusRail">
        <div><Bot size={17} /><span>监听规则</span><strong>{data.rules.filter((rule) => rule.enabled).length}</strong></div>
        <div><Activity size={17} /><span>命中记录</span><strong>{data.runs.filter((run) => run.status !== "skipped").length}</strong></div>
        <div><Pause size={17} /><span>跳过记录</span><strong>{data.runs.filter((run) => run.status === "skipped").length}</strong></div>
        <div><ShieldAlert size={17} /><span>自动广播</span><strong>{data.rules.filter((rule) => !rule.notifyOnly && rule.mode === "armed" && Date.parse(rule.armedUntil || 0) > Date.now()).length}</strong></div>
      </div>

      {error ? <div className="inlineAlert" role="alert">{uiError(error)}</div> : null}
      {notice ? <div className="setupAppliedNotice" role="status"><Check size={14} />{notice}</div> : null}

      <div className="followLayout">
        <form className="operationForm followRuleForm" onSubmit={createRule}>
          <div className="formTitleRow"><h2>新建跟单规则</h2><span className="pill pending">{form.notifyOnly ? "仅通知" : "默认仅预览"}</span></div>
          <label className="field"><span>规则名称</span><input value={form.name} onChange={(event) => set("name", event.target.value)} placeholder="例如：项目公售跟单" /></label>
          <div className="formGrid two">
            <label className="field"><span>监听合约</span><input value={form.sourceContract} onChange={(event) => set("sourceContract", event.target.value)} placeholder="0x..." spellCheck="false" /></label>
            <label className="field"><span>铸造合约</span><input value={form.targetContract} onChange={(event) => set("targetContract", event.target.value)} placeholder="留空则跟随监听合约" spellCheck="false" /></label>
          </div>
          <div className="formGrid three">
            <label className="field"><span>每钱包数量</span><input type="number" min="1" max="1000" value={form.quantity} onChange={(event) => set("quantity", event.target.value)} /></label>
            <label className="field"><span>代币编号</span><input type="number" min="0" value={form.tokenId} onChange={(event) => set("tokenId", event.target.value)} /></label>
            <label className="field"><span>并发</span><input type="number" min="0" max="32" value={form.concurrency} onChange={(event) => set("concurrency", event.target.value)} /></label>
          </div>
          <div className="formGrid three">
            <label className="field"><span>冷却秒数</span><input type="number" min="5" value={form.cooldownSeconds} onChange={(event) => set("cooldownSeconds", event.target.value)} /></label>
            <label className="field"><span>执行价值上限</span><input value={form.maxMintCostEth} onChange={(event) => set("maxMintCostEth", event.target.value)} placeholder="每钱包，例如 0.05" inputMode="decimal" /></label>
            <label className="field"><span>当前链</span><input value={chain?.name || "—"} readOnly /></label>
          </div>

          <div className="followFilterPanel">
            <div className="formTitleRow"><h3>事件筛选</h3><small>所有启用条件同时满足才生成预览</small></div>
            <div className="formGrid three">
              <label className="field"><span>开始时间</span><input type="time" value={form.timeStart} onChange={(event) => set("timeStart", event.target.value)} /></label>
              <label className="field"><span>结束时间</span><input type="time" value={form.timeEnd} onChange={(event) => set("timeEnd", event.target.value)} /></label>
              <label className="field"><span>交易金额</span><select value={form.eventValueMode} onChange={(event) => set("eventValueMode", event.target.value)}><option value="free">只跟免费</option><option value="any">任意金额</option><option value="max">不超过上限</option></select></label>
            </div>
            {form.eventValueMode === "max" ? <label className="field"><span>事件金额上限（{chain?.nativeSymbol || "—"}）</span><input value={form.maxEventValueEth} onChange={(event) => set("maxEventValueEth", event.target.value)} placeholder="例如 0.02" inputMode="decimal" /></label> : null}
            <div className="formGrid three">
              <label className="field"><span>最大 Gas 上限</span><input value={form.maxGasLimit} onChange={(event) => set("maxGasLimit", event.target.value)} placeholder="空 = 不筛选" inputMode="numeric" /></label>
              <label className="field"><span>调用数据参数字数</span><input value={form.parameterCount} onChange={(event) => set("parameterCount", event.target.value)} placeholder="32 字节字数" inputMode="numeric" /></label>
              <label className="field"><span>最小供应总量</span><input value={form.minMaxSupply} onChange={(event) => set("minMaxSupply", event.target.value)} placeholder="缺失时继续" inputMode="numeric" /></label>
            </div>
            <div className="formGrid two">
              <label className="field"><span>单笔铸造数量范围</span><span className="followRange"><input type="number" min="1" value={form.minTriggerQuantity} onChange={(event) => set("minTriggerQuantity", event.target.value)} /><b>至</b><input type="number" min="1" value={form.maxTriggerQuantity} onChange={(event) => set("maxTriggerQuantity", event.target.value)} placeholder="不限" /></span></label>
              <label className="field"><span>屏蔽关键词</span><input value={form.blockedKeywords} onChange={(event) => set("blockedKeywords", event.target.value)} placeholder="逗号分隔，不区分大小写" /></label>
            </div>
            <div className="followFilterChecks">
              <label className="checkLine"><input type="checkbox" checked={form.confirmedOnly} onChange={(event) => set("confirmedOnly", event.target.checked)} />只跟已确认事件</label>
              <label className="checkLine"><input type="checkbox" checked={form.excludeErc1155} onChange={(event) => set("excludeErc1155", event.target.checked)} />不跟 ERC1155</label>
              {["artblocks", "bueno", "zora"].map((platform) => <label className="checkLine" key={platform}><input type="checkbox" checked={form.excludedPlatforms.includes(platform)} onChange={() => togglePlatform(platform)} />屏蔽 {platform}</label>)}
            </div>
          </div>
          <WalletSelection wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} chainId={chain?.id} notifyOnly={form.notifyOnly} />
          <div className="followChecks">
            <label className="checkLine"><input type="checkbox" checked={form.notifyOnly} onChange={(event) => set("notifyOnly", event.target.checked)} />命中后仅通知，不生成交易</label>
            <label className="checkLine"><input type="checkbox" checked={form.enabled} onChange={(event) => set("enabled", event.target.checked)} />保存后立即监听</label>
            <label className="checkLine"><input type="checkbox" checked={form.oneShot} onChange={(event) => set("oneShot", event.target.checked)} />命中一次后暂停</label>
          </div>
          <button className="btn primary" type="submit" disabled={busy || (!form.notifyOnly && !selectedIds.length)}><Plus size={15} />保存规则</button>
        </form>

        <section className="followRuleList" aria-label="跟单铸造规则">
          {data.rules.map((rule) => {
            const latest = runsByRule.get(rule.id)?.[0]
            const armed = rule.mode === "armed" && Date.parse(rule.armedUntil || 0) > Date.now()
            return (
              <article className="followRule" key={rule.id}>
                <header>
                  <div><span className={`statusDot ${rule.enabled ? "ready" : ""}`} /><div><strong>{rule.name}</strong><small>{rule.chainId} · {short(rule.sourceContract)} → {short(rule.targetContract || rule.sourceContract)}</small></div></div>
                  <span className={`pill ${armed ? "failed" : rule.enabled ? "pending" : ""}`}>{armed ? "自动广播中" : rule.enabled ? rule.notifyOnly ? "仅通知" : "监听中" : "已暂停"}</span>
                </header>
                <div className="followRuleMetrics">
                  <span><small>钱包</small><strong>{rule.walletIds.length}</strong></span>
                  <span><small>数量</small><strong>{rule.quantity}</strong></span>
                  <span><small>触发阈值</small><strong>{rule.minTriggerQuantity}</strong></span>
                  <span><small>上次触发</small><strong>{formatTime(rule.lastTriggeredAt)}</strong></span>
                </div>
                <div className="followRuleFilters">
                  <span>{rule.eventValueMode === "free" ? "免费" : rule.eventValueMode === "max" ? `金额≤${rule.maxEventValueEth}` : "任意金额"}</span>
                  {rule.maxGasLimit ? <span>Gas≤{rule.maxGasLimit}</span> : null}
                  {rule.parameterCount !== null ? <span>参数={rule.parameterCount}</span> : null}
                  {rule.minMaxSupply ? <span>供应量≥{rule.minMaxSupply}</span> : null}
                  {rule.excludeErc1155 ? <span>排除 1155</span> : null}
                  {rule.excludedPlatforms.map((platform) => <span key={platform}>排除 {platform.toUpperCase()}</span>)}
                  {rule.blockedKeywords.length ? <span>关键词 {rule.blockedKeywords.length}</span> : null}
                  {rule.notifyOnly ? <span className="notifyOnly"><Bell size={12} />仅通知</span> : null}
                </div>
                {latest ? <div className={`followLastRun ${latest.status}`}><Activity size={14} /><span>{followRunStatus(latest.status)}</span><code>{latest.jobId ? short(latest.jobId) : latest.error ? uiError(latest.error) : latest.status === "notified" ? "通知已发送" : "准备中"}</code></div> : null}
                <div className="followRuleActions">
                  <button className="btn" type="button" onClick={() => toggleRule(rule)} disabled={busy}>{rule.enabled ? <Pause size={14} /> : <Play size={14} />}{rule.enabled ? "暂停" : "启用"}</button>
                  <button className="btn" type="button" onClick={() => previewRule(rule)} disabled={busy}>{rule.notifyOnly ? <Bell size={14} /> : <Zap size={14} />}{rule.notifyOnly ? "测试通知" : "真实预览"}</button>
                  {!rule.notifyOnly && (armed ? <button className="btn danger" type="button" onClick={() => disarmRule(rule)} disabled={busy}><ShieldAlert size={14} />关闭自动广播</button> : <button className="btn" type="button" onClick={() => setArmRuleId(rule.id)} disabled={busy}><ShieldAlert size={14} />启用自动广播</button>)}
                  <button className="iconAction" type="button" onClick={() => deleteRule(rule)} disabled={busy} aria-label={`删除 ${rule.name}`} title="删除规则"><Trash2 size={15} /></button>
                </div>
                {armRuleId === rule.id && !armed ? (
                  <div className="followArmPanel">
                    <label className="field"><span>输入“自动铸造”，自动广播有效一小时</span><input value={armPhrase} onChange={(event) => setArmPhrase(event.target.value)} placeholder="自动铸造" autoComplete="off" /></label>
                    <button className="btn danger" type="button" onClick={() => armRule(rule)} disabled={busy || armPhrase !== "自动铸造"}>确认启用</button>
                  </div>
                ) : null}
              </article>
            )
          })}
          {!data.rules.length ? <div className="emptyState followEmpty"><Bot size={20} />创建第一条规则后，服务端会直接订阅所选链的真实铸造事件。</div> : null}
        </section>
      </div>

      <section className="operationForm">
        <div className="formTitleRow"><h2>最近监听决策</h2><small>SQLite 持久化，最多显示 200 条</small></div>
        {data.runs.length ? (
          <div className="tableWrap"><table><thead><tr><th>时间</th><th>规则</th><th>状态</th><th>合集 / 事件</th><th>铸造任务</th><th>命中或跳过原因</th></tr></thead><tbody>
            {data.runs.map((run) => <tr key={run.id}><td>{formatTime(run.createdAt)}</td><td>{data.rules.find((rule) => rule.id === run.ruleId)?.name || short(run.ruleId)}</td><td><span className={`pill ${run.status}`}>{followRunStatus(run.status)}</span></td><td><strong>{run.snapshot?.event?.name || "手动预览"}</strong><code className="subCell">{short(run.eventId)}</code></td><td><code>{short(run.jobId)}</code></td><td>{run.error ? uiError(run.error) : followDecisionReason(run.snapshot?.decision?.reason || "matched")}</td></tr>)}
          </tbody></table></div>
        ) : <div className="emptyState"><Activity size={18} />暂无触发记录</div>}
      </section>
    </div>
  )
}
