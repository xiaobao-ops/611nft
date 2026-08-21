import { Activity, Check, Clock, FileJson, Gauge, ListChecks, Play, RefreshCcw, ShieldAlert, Square, Wallet, Zap } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { uiError, uiLogLevel, uiStatus } from "./ui-text.js"
import WalletTableSelector from "./WalletTableSelector.jsx"

const emptyForm = {
  contractAddress: "",
  mode: "method",
  methodSignature: "mint(uint256)",
  parameters: ["1"],
  calldata: "0x",
  replaceWallet: false,
  valueEth: "0",
  rounds: "1",
  frequencyMs: "400",
  executionMode: "sequential",
  waitMode: "confirmed",
  scheduleAt: "",
  preflight: true,
  allowGasFailure: false,
  autoGas: true,
  gasLimit: "120000",
  autoFee: true,
  eip1559: true,
  gasPriceGwei: "",
  maxFeeGwei: "",
  priorityFeeGwei: "",
  prefetchNonce: true,
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${path}`)
  return data
}

function short(value) {
  return value ? `${value.slice(0, 8)}...${value.slice(-6)}` : "—"
}

function methodParameterTypes(signature) {
  const source = String(signature || "").replace(/^\s*function\s+/, "")
  const start = source.indexOf("(")
  if (start < 1) return []
  let depth = 0
  let end = -1
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1
    if (source[index] === ")") depth -= 1
    if (depth === 0) {
      end = index
      break
    }
  }
  if (end < 0) return []
  const body = source.slice(start + 1, end).trim()
  if (!body) return []
  const values = []
  let current = ""
  depth = 0
  for (const char of body) {
    if (char === "(" || char === "[") depth += 1
    if (char === ")" || char === "]") depth -= 1
    if (char === "," && depth === 0) {
      values.push(current.trim())
      current = ""
    } else current += char
  }
  values.push(current.trim())
  return values
}

function weiToEth(value) {
  try {
    const wei = BigInt(value || 0)
    const weiPerNative = 1000000000000000000n
    const whole = wei / weiPerNative
    const fraction = (wei % weiPerNative).toString().padStart(18, "0").replace(/0+$/, "")
    return fraction ? `${whole}.${fraction}` : whole.toString()
  } catch {
    return "0"
  }
}

function Segmented({ value, options, onChange, label }) {
  return <div className="advancedSegmented" aria-label={label}>{options.map((option) => <button key={option.value} type="button" className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
}

function Stat({ icon: Icon, label, value }) {
  return <div><Icon size={15} /><span>{label}</span><strong>{value}</strong></div>
}

export default function AdvancedMintView({ chain, wallets, selectedIds, onSelectedIdsChange, initialTransaction, initialContract = "", initialSeed = null, compact = false, embedded = false }) {
  const [form, setForm] = useState(emptyForm)
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [logTab, setLogTab] = useState("info")
  const parameterTypes = useMemo(() => methodParameterTypes(form.methodSignature), [form.methodSignature])
  const active = job && (["scheduled", "running", "stopping", "confirmation_pending"].includes(job.status) || (job.status === "partial" && job.summary?.pending))

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  useEffect(() => {
    setForm((current) => {
      if (current.parameters.length === parameterTypes.length) return current
      return { ...current, parameters: parameterTypes.map((_, index) => current.parameters[index] ?? "") }
    })
  }, [parameterTypes.length])

  useEffect(() => {
    if (!initialTransaction?.to || !initialTransaction?.data) return
    setForm((current) => ({
      ...current,
      contractAddress: initialTransaction.to,
      mode: "hex",
      calldata: initialTransaction.data,
      valueEth: weiToEth(initialTransaction.valueWei),
    }))
    setNotice("已导入解析交易的调用目标、calldata 与交易金额。")
  }, [initialTransaction?.to, initialTransaction?.data, initialTransaction?.valueWei])

  useEffect(() => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(initialContract)) return
    setForm((current) => current.contractAddress === initialContract ? current : { ...current, contractAddress: initialContract })
    setNotice("已从实时铸造载入合约地址；请填写真实方法或 calldata。")
  }, [initialContract])

  useEffect(() => {
    if (!initialSeed?.contractAddress) return
    const { notice: seedNotice, ...seed } = initialSeed
    setForm((current) => ({ ...current, ...seed }))
    setJob(null)
    setError("")
    setNotice(seedNotice || "已导入高级铸造参数；请核对后生成 Preview。")
  }, [initialSeed])

  useEffect(() => {
    if (!active || !job?.id) return undefined
    let alive = true
    const refresh = async () => {
      try {
        const data = await request(`/api/advanced-mint/jobs/${job.id}`)
        if (alive) setJob((current) => ({ ...data.job, confirmation: current?.confirmation }))
      } catch (refreshError) {
        if (alive) setError(refreshError.message)
      }
    }
    const timer = window.setInterval(() => void refresh(), 2000)
    void refresh()
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active, job?.id])

  async function perform(action, success = "") {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const value = await action()
      if (value?.job) setJob((current) => ({ ...value.job, confirmation: value.job.confirmation || current?.confirmation }))
      if (success) setNotice(success)
      return value
    } catch (actionError) {
      setError(actionError.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function preview(event) {
    event.preventDefault()
    await perform(() => request("/api/advanced-mint/preview", {
      method: "POST",
      body: JSON.stringify({ ...form, chainId: chain?.id, walletIds: selectedIds }),
    }), "预览已固定 calldata、Gas、费用与交易序号；尚未广播。")
  }

  async function send() {
    if (!job?.confirmation || !window.confirm(`确认执行 ${job.summary.plannedTransactions} 笔高级铸造计划？`)) return
    await perform(() => request("/api/advanced-mint/send", {
      method: "POST",
      body: JSON.stringify({
        jobId: job.id,
        previewId: job.confirmation.previewId,
        confirmationToken: job.confirmation.confirmationToken,
      }),
    }), job.scheduleAt ? "任务已进入定时队列。" : "任务已开始执行。")
  }

  async function stop() {
    await perform(() => request(`/api/advanced-mint/jobs/${job.id}/stop`, { method: "POST", body: "{}" }), "停止请求已记录。")
  }

  async function replace(walletId, kind) {
    const label = kind === "cancel" ? "取消" : "加速"
    if (!window.confirm(`${label}钱包 ${walletId} 当前待确认交易？替换费用至少提升 1.2 倍。`)) return
    await perform(() => request(`/api/advanced-mint/jobs/${job.id}/${kind}`, {
      method: "POST",
      body: JSON.stringify({ walletId, multiplier: 1.2 }),
    }), `${label}替换交易已提交。`)
  }

  const latestByWallet = useMemo(() => {
    const values = new Map()
    for (const result of job?.results || []) values.set(result.walletId, result)
    return values
  }, [job?.results])
  const summary = job?.summary || { wallets: 0, eligibleWallets: 0, plannedTransactions: 0, attempted: 0, pending: 0, confirmed: 0, failed: 0 }
  const resultRows = [...(job?.results || []), ...(job?.replacements || [])]
  const sentRows = (job?.results || []).filter((result) => result.txHash && result.status !== "failed")
  const pendingWalletId = (job?.results || []).find((result) => result.status === "confirmation_pending")?.walletId || ""
  const sentValueWei = sentRows.reduce((sum, result) => sum + BigInt(result.valueWei || 0), 0n)
  const averageValueWei = sentRows.length ? sentValueWei / BigInt(sentRows.length) : 0n
  const filteredResults = resultRows.filter((result) => {
    if (logTab === "pending") return ["running", "confirmation_pending", "replaced"].includes(result.status)
    if (logTab === "success") return result.status === "confirmed"
    if (logTab === "failed") return result.status === "failed"
    return false
  })

  return (
    <div className={`sectionStack advancedMintWorkspace${compact ? " compact" : ""}`}>
      {!embedded ? <div className="sectionHeader">
        <div><h1>{compact ? "机器人 / 铸造" : "ABI / Hex 高级铸造"}</h1><p>逐钱包替换地址、固定 Gas、费用与交易序号，并按时间、轮次和间隔执行真实交易计划。</p></div>
        <span className="monitorSource live"><Zap size={14} />{chain?.name || "当前链"}</span>
      </div> : null}

      {error ? <div className="inlineAlert" role="alert">{uiError(error)}</div> : null}
      {notice ? <div className="setupAppliedNotice" role="status"><Check size={14} />{notice}</div> : null}

      <form className="advancedMintLayout" onSubmit={preview}>
        <section className="operationForm advancedTransactionPanel">
          <div className="formTitleRow"><h2>交易编码</h2><Segmented label="编码模式" value={form.mode} onChange={(value) => set("mode", value)} options={[{ value: "method", label: "ABI 方法" }, { value: "hex", label: "十六进制" }]} /></div>
          <WalletTableSelector wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} chainId={chain?.id} title="账户" compact />
          <label className="field"><span>铸造合约</span><input value={form.contractAddress} onChange={(event) => set("contractAddress", event.target.value)} placeholder="0x..." spellCheck="false" /></label>
          {form.mode === "method" ? (
            <>
              <label className="field"><span>方法签名</span><input value={form.methodSignature} onChange={(event) => set("methodSignature", event.target.value)} placeholder="mint(address,uint256)" spellCheck="false" /></label>
              <div className="advancedPlaceholderHint" role="note">
                <span>地址参数占位符</span><code>&amp;</code><span>或</span><code>{"{wallet}"}</code>
                <small>预览时会按每个执行钱包替换为 32 字节地址。</small>
              </div>
              <div className="advancedParameters">
                {parameterTypes.map((type, index) => <label className="field" key={`${type}-${index}`}><span>参数 {index + 1} · {type}</span><input value={form.parameters[index] || ""} onChange={(event) => set("parameters", form.parameters.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} placeholder={type.includes("address") ? "& 或 {wallet}" : "参数值"} spellCheck="false" /></label>)}
                {!parameterTypes.length ? <div className="miniEmpty">当前方法没有参数，或签名尚未完整。</div> : null}
              </div>
            </>
          ) : (
            <>
              <label className="field"><span>Calldata</span><textarea className="advancedCalldata" value={form.calldata} onChange={(event) => set("calldata", event.target.value)} spellCheck="false" /></label>
              <label className="checkLine"><input type="checkbox" checked={form.replaceWallet} onChange={(event) => set("replaceWallet", event.target.checked)} />发送时替换地址（参数中的 &amp; / {"{wallet}"}）</label>
            </>
          )}
          <label className="checkLine"><input type="checkbox" checked={form.valueEth === "0"} onChange={(event) => set("valueEth", event.target.checked ? "0" : "")} />免费铸造（交易金额 = 0）</label>
          <label className="field"><span>每笔金额（{chain?.nativeSymbol || "—"}）</span><input value={form.valueEth} onChange={(event) => set("valueEth", event.target.value)} inputMode="decimal" disabled={form.valueEth === "0"} placeholder="输入付费铸造的单笔金额" /></label>
        </section>

        <section className="operationForm advancedControlPanel">
          <div className="formTitleRow"><h2>执行参数</h2><span className={`pill ${job?.status || "pending"}`}>{job ? uiStatus(job.status) : "未预览"}</span></div>
          <div className="formGrid three">
            <label className="field"><span>轮次</span><input type="number" min="1" max="100000" value={form.rounds} onChange={(event) => set("rounds", event.target.value)} /></label>
            <label className="field"><span>限制频率（毫秒）</span><input type="number" min="50" value={form.frequencyMs} onChange={(event) => set("frequencyMs", event.target.value)} /></label>
            <label className="field"><span>定时执行</span><input type="datetime-local" value={form.scheduleAt} onChange={(event) => set("scheduleAt", event.target.value)} /></label>
          </div>
          <div className="advancedControlRow"><span>发送顺序</span><Segmented label="发送顺序" value={form.executionMode} onChange={(value) => set("executionMode", value)} options={[{ value: "sequential", label: "顺序" }, { value: "burst", label: "并发" }]} /></div>
          <div className="advancedControlRow"><span>确认模式</span><Segmented label="确认模式" value={form.waitMode} onChange={(value) => setForm((current) => ({ ...current, waitMode: value, ...(value === "zero-block" ? { autoGas: false } : {}) }))} options={[{ value: "confirmed", label: "等待确认" }, { value: "zero-block", label: "0 块" }]} /></div>

          <div className="advancedGasGrid">
            <div>
              <label className="checkLine"><input type="checkbox" checked={form.autoGas} onChange={(event) => set("autoGas", event.target.checked)} disabled={form.waitMode === "zero-block"} />自动 Gas 上限（估算值 × 1.3）</label>
              <label className="field"><span>Gas 上限</span><input value={form.gasLimit} onChange={(event) => set("gasLimit", event.target.value)} inputMode="numeric" disabled={form.autoGas} placeholder={form.autoGas ? "预览时自动估算" : "输入最大 Gas"} /></label>
              <label className="checkLine"><input type="checkbox" checked={form.allowGasFailure} onChange={(event) => set("allowGasFailure", event.target.checked)} />Gas 估算失败时保留该钱包</label>
            </div>
            <div>
              <label className="checkLine"><input type="checkbox" checked={form.autoFee} onChange={(event) => set("autoFee", event.target.checked)} />自动读取实时费用</label>
              <label className="checkLine"><input type="checkbox" checked={form.eip1559} onChange={(event) => set("eip1559", event.target.checked)} />EIP-1559</label>
              <div className="advancedFeeFields">
                <div className="formGrid two">
                  <label className="field"><span>最高费（Gwei）</span><input value={form.maxFeeGwei} onChange={(event) => set("maxFeeGwei", event.target.value)} disabled={form.autoFee || !form.eip1559} placeholder={form.autoFee ? "预览时自动读取" : form.eip1559 ? "输入最高费" : "需启用 EIP-1559"} /></label>
                  <label className="field"><span>优先费（Gwei）</span><input value={form.priorityFeeGwei} onChange={(event) => set("priorityFeeGwei", event.target.value)} disabled={form.autoFee || !form.eip1559} placeholder={form.autoFee ? "预览时自动读取" : form.eip1559 ? "输入优先费" : "需启用 EIP-1559"} /></label>
                </div>
                <small className="advancedFeeHint">{form.autoFee ? "预览时自动读取实时费用，并在逐钱包计划中固定。" : !form.eip1559 ? "启用 EIP-1559 后可编辑最高费与优先费。" : "手动费用会随预览固定到每个钱包。"}</small>
              </div>
              {!form.autoFee && !form.eip1559 ? <label className="field"><span>Gas 单价（Gwei）</span><input value={form.gasPriceGwei} onChange={(event) => set("gasPriceGwei", event.target.value)} /></label> : null}
            </div>
          </div>
          <div className="advancedChecks">
            <label className="checkLine"><input type="checkbox" checked={form.preflight} onChange={(event) => set("preflight", event.target.checked)} />发送前 eth_call</label>
            <label className="checkLine"><input type="checkbox" checked={form.prefetchNonce} onChange={(event) => set("prefetchNonce", event.target.checked)} />预览时预取待处理交易序号</label>
          </div>
          {form.waitMode === "zero-block" ? <div className="advancedWarning"><ShieldAlert size={15} /><span>0 块模式不等待回执，必须手动填写 Gas 上限；执行期间不要用相同钱包发送其他交易。</span></div> : null}
          <div className="advancedActions">
            <button className="btn" type="submit" disabled={busy || active || !selectedIds.length}><ListChecks size={15} />生成预览</button>
            <button className="btn primary" type="button" onClick={send} disabled={busy || job?.status !== "previewed"}><Play size={15} />执行计划</button>
            <button className="btn danger" type="button" onClick={stop} disabled={busy || !["scheduled", "running", "stopping"].includes(job?.status)}><Square size={14} />停止</button>
            <button className="btn" type="button" onClick={() => replace(pendingWalletId, "accelerate")} disabled={busy || !pendingWalletId}><Zap size={14} />加速</button>
            <button className="btn" type="button" onClick={() => replace(pendingWalletId, "cancel")} disabled={busy || !pendingWalletId}><Square size={14} />取消订单</button>
          </div>
        </section>
      </form>

      <div className="advancedStats">
        <Stat icon={Check} label="成功交易" value={summary.confirmed} />
        <Stat icon={Gauge} label="失败交易" value={summary.failed} />
        <Stat icon={Activity} label="计划交易" value={summary.plannedTransactions} />
        <Stat icon={Wallet} label={`已发送金额（${job?.chain?.nativeSymbol || chain?.nativeSymbol || "链币"}）`} value={weiToEth(sentValueWei)} />
        <Stat icon={Clock} label="平均金额" value={weiToEth(averageValueWei)} />
      </div>

      {job ? (
        <>
          <section className="operationForm advancedPlan">
            <div className="formTitleRow"><h2>逐钱包计划与结果</h2><small>{job.scheduleAt ? new Date(job.scheduleAt).toLocaleString() : "立即执行"}</small></div>
            <div className="tableWrap"><table><thead><tr><th>状态</th><th>钱包 / 交易序号</th><th>方法 / 选择器</th><th>Gas / 最大费用</th><th>金额 / 总需求</th><th>交易 / 操作</th></tr></thead><tbody>
              {job.wallets.map((wallet) => {
                const result = latestByWallet.get(wallet.walletId)
                const status = result?.status || wallet.preflightStatus
                return <tr key={wallet.walletId}><td><span className={`pill ${status}`}>{uiStatus(status)}</span>{wallet.error ? <small className="advancedRowError">{uiError(wallet.error)}</small> : null}</td><td><strong>{wallet.walletId}</strong><code className="subCell">{short(wallet.address)} · {result?.nonce ?? wallet.nonce ?? "自动"}</code></td><td><strong>{wallet.method}</strong><code className="subCell">{wallet.selector} · {wallet.calldataBytes} 字节</code></td><td><strong>{wallet.gas || "签名器"}</strong><code className="subCell">{wallet.maxFeePerGas || wallet.gasPrice || "自动"} wei</code></td><td><strong>{wallet.valueWei} wei</strong><code className="subCell">{wallet.estimatedTotalWei || "—"} 总计</code></td><td>{result?.txHash ? <code title={result.txHash}>{short(result.txHash)}</code> : <span className="muted">尚未发送</span>}{result?.status === "confirmation_pending" ? <div className="advancedReplaceActions"><button type="button" onClick={() => replace(wallet.walletId, "accelerate")} disabled={busy}><Zap size={12} />加速</button><button type="button" onClick={() => replace(wallet.walletId, "cancel")} disabled={busy}><Square size={11} />取消</button></div> : null}</td></tr>
              })}
            </tbody></table></div>
          </section>

        </>
      ) : null}

      <section className="operationForm advancedLogs">
        <div className="formTitleRow"><h2>任务日志</h2>{job ? <button className="iconAction" type="button" title="刷新任务" aria-label="刷新任务" onClick={() => perform(() => request(`/api/advanced-mint/jobs/${job.id}`))} disabled={busy}><RefreshCcw size={14} className={busy ? "spin" : ""} /></button> : null}</div>
        <div className="advancedLogTabs" role="tablist" aria-label="任务日志分类">
          {[
            ["info", "信息", job?.logs?.length || 0],
            ["pending", "待处理", summary.pending],
            ["success", "成功", summary.confirmed],
            ["failed", "失败", summary.failed],
          ].map(([value, label, count]) => <button key={value} type="button" role="tab" aria-selected={logTab === value} className={logTab === value ? "active" : ""} onClick={() => setLogTab(value)}>{label}({count})</button>)}
        </div>
        <div role="log">
          {logTab === "info" ? (job?.logs || []).map((entry, index) => <div key={`${entry.at}-${index}`} className={entry.level}><time>{new Date(entry.at).toLocaleTimeString()}</time><strong>{uiLogLevel(entry.level)}</strong><span>{/[\u3400-\u9fff]/.test(entry.message) ? entry.message : uiError(entry.message)}</span>{entry.details?.txHash ? <code>{short(entry.details.txHash)}</code> : null}</div>) : filteredResults.map((result, index) => <div key={`${result.txHash || result.walletId}-${index}`} className={result.status === "failed" ? "error" : result.status === "confirmed" ? "success" : "warning"}><time>{result.round ? `第 ${result.round} 轮` : "替换"}</time><strong>{uiStatus(result.status)}</strong><span>{result.walletId}{result.error ? ` · ${uiError(result.error)}` : ""}</span>{result.txHash ? <code>{short(result.txHash)}</code> : null}</div>)}
          {logTab === "info" && !(job?.logs || []).length ? <div className="empty"><FileJson size={14} /><span>尚未生成任务日志</span></div> : null}
          {logTab !== "info" && !filteredResults.length ? <div className="empty"><Activity size={14} /><span>该分类暂无交易</span></div> : null}
        </div>
      </section>
    </div>
  )
}
