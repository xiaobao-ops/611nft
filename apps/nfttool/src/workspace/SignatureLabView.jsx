import { ArrowRight, Check, FileJson, RefreshCcw, ScanSearch, ShieldCheck, Wallet } from "lucide-react"
import { useEffect, useState } from "react"
import AdvancedMintView from "./AdvancedMintView.jsx"
import { uiError, uiSignatureMode, uiStatus } from "./ui-text.js"
import WalletTableSelector from "./WalletTableSelector.jsx"

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

function WalletSelection({ wallets, selectedIds, onChange, chainId }) {
  return <WalletTableSelector wallets={wallets} selectedIds={selectedIds} onChange={onChange} chainId={chainId} title="预检钱包" compact />
}

function DataRow({ label, value, code = false }) {
  return <div className="signatureDataRow"><span>{label}</span>{code ? <code title={value}>{value || "—"}</code> : <strong>{value || "—"}</strong>}</div>
}

export default function SignatureLabView({ chain, wallets, selectedIds, onSelectedIdsChange, initialTxHash = "", initialContract = "", initialWorkspace = "analysis" }) {
  const [workspace, setWorkspace] = useState(initialWorkspace === "advanced" ? "advanced" : "analysis")
  const [advancedSeed, setAdvancedSeed] = useState(null)
  const [form, setForm] = useState({ txHash: "", to: "", data: "0x", valueWei: "0" })
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (/^0x[a-fA-F0-9]{64}$/.test(initialTxHash)) {
      setForm((current) => current.txHash ? current : { ...current, txHash: initialTxHash })
    }
  }, [initialTxHash])

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function submit(path) {
    setBusy(true)
    setError("")
    try {
      const data = await request(path, {
        method: "POST",
        body: JSON.stringify({ ...form, chainId: chain?.id, walletIds: selectedIds }),
      })
      setReport(data)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setBusy(false)
    }
  }

  function useTransaction() {
    if (!report?.transaction) return
    setForm({
      txHash: "",
      to: report.transaction.to,
      data: report.transaction.data,
      valueWei: report.transaction.valueWei,
    })
  }

  function openMint() {
    const contractAddress = report?.analysis?.nftContract
    if (!contractAddress) return
    const params = new URLSearchParams({ contractAddress })
    if (report.analysis.quantity) params.set("quantity", report.analysis.quantity)
    window.top?.location.assign(`/tool/highHexMint/opensea?${params.toString()}`)
  }

  function openAdvanced() {
    if (report?.transaction) setAdvancedSeed({ ...report.transaction })
    setWorkspace("advanced")
  }

  const analysis = report?.analysis
  const transaction = report?.transaction
  const preflight = report?.preflight
  const workspaceSwitch = (
    <div className="signatureWorkspaceSwitch" aria-label="项目破签工作区">
      <button type="button" className={workspace === "analysis" ? "active" : ""} onClick={() => setWorkspace("analysis")}><ScanSearch size={15} />交易解析</button>
      <button type="button" className={workspace === "advanced" ? "active" : ""} onClick={() => setWorkspace("advanced")}><FileJson size={15} />ABI / Hex 高级铸造</button>
    </div>
  )

  if (workspace === "advanced") {
    return (
      <div className="sectionStack signatureWorkspace">
        {workspaceSwitch}
        <AdvancedMintView
          chain={chain}
          wallets={wallets}
          selectedIds={selectedIds}
          onSelectedIdsChange={onSelectedIdsChange}
          initialTransaction={advancedSeed}
          initialContract={initialContract}
        />
      </div>
    )
  }

  return (
    <div className="sectionStack signatureWorkspace">
      {workspaceSwitch}
      <div className="sectionHeader">
        <div>
          <h1>项目破签</h1>
          <p>读取真实链上交易或原始 calldata，解析铸造方法、签名材料、阶段参数并逐钱包模拟。</p>
        </div>
        <span className="monitorSource live"><ScanSearch size={14} />{chain?.name || "当前链"}</span>
      </div>

      {error ? <div className="inlineAlert" role="alert">{uiError(error)}</div> : null}

      <div className="signatureLayout">
        <section className="operationForm signatureInput">
          <div className="formTitleRow"><h2>交易输入</h2><small>交易哈希优先；留空后使用手动 calldata</small></div>
          <label className="field"><span>交易哈希</span><input value={form.txHash} onChange={(event) => set("txHash", event.target.value)} placeholder="0x..." spellCheck="false" autoComplete="off" /></label>
          <div className="signatureDivider"><span>或手动输入</span></div>
          <label className="field"><span>调用目标</span><input value={form.to} onChange={(event) => set("to", event.target.value)} placeholder="0x..." spellCheck="false" /></label>
          <label className="field"><span>交易金额（wei）</span><input value={form.valueWei} onChange={(event) => set("valueWei", event.target.value)} inputMode="numeric" /></label>
          <label className="field"><span>Calldata</span><textarea value={form.data} onChange={(event) => set("data", event.target.value)} spellCheck="false" /></label>
          <WalletSelection wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} chainId={chain?.id} />
          <div className="signatureActions">
            <button className="btn" type="button" onClick={() => submit("/api/signature-lab/analyze")} disabled={busy}><FileJson size={15} />解析</button>
            <button className="btn primary" type="button" onClick={() => submit("/api/signature-lab/preflight")} disabled={busy || !selectedIds.length}>{busy ? <RefreshCcw className="spin" size={15} /> : <ShieldCheck size={15} />}逐钱包预检</button>
          </div>
        </section>

        <section className="signatureReport" aria-live="polite">
          {analysis ? (
            <>
              <div className="signatureReportHeader">
                <div><span>{analysis.provider}</span><h2>{analysis.method}</h2><code>{analysis.selector}</code></div>
                <span className={`signatureMode ${analysis.signatureMode}`}>{uiSignatureMode(analysis.signatureMode)}</span>
              </div>
              <div className="signatureDataGrid">
                <DataRow label="调用目标" value={analysis.to} code />
                <DataRow label="NFT 合约" value={analysis.nftContract} code />
                <DataRow label="数量" value={analysis.quantity} />
                <DataRow label="调用价值" value={`${analysis.valueEth} ${report.chain?.nativeSymbol || chain?.nativeSymbol || "—"}`} />
                <DataRow label="费用接收" value={analysis.feeRecipient} code />
                <DataRow label="指定接收者" value={analysis.minterIfNotPayer} code />
                <DataRow label="签名字节" value={analysis.signature ? String(analysis.signature.bytes) : "0"} />
                <DataRow label="Merkle 证明" value={String(analysis.proofCount || 0)} />
              </div>

              {analysis.mintParams ? (
                <div className="signatureParams">
                  <h3>铸造阶段参数</h3>
                  <div>{Object.entries(analysis.mintParams).map(([key, value]) => <DataRow key={key} label={key} value={String(value)} code />)}</div>
                </div>
              ) : null}

              {analysis.signature ? (
                <div className="signatureParams">
                  <h3>项目签名</h3>
                  <DataRow label="r" value={analysis.signature.r} code />
                  <DataRow label="s" value={analysis.signature.s} code />
                  <DataRow label="v" value={String(analysis.signature.v || "")} />
                  <DataRow label="salt" value={analysis.salt} code />
                </div>
              ) : null}

              <div className="signatureObservations">
                {analysis.observations.map((observation) => <div key={observation}><Check size={14} /><span>{observation}</span></div>)}
              </div>

              <div className="signatureReportActions">
                {transaction?.txHash ? <button className="btn" type="button" onClick={useTransaction}><ArrowRight size={15} />转为手动 calldata</button> : null}
                {transaction ? <button className="btn" type="button" onClick={openAdvanced}><ArrowRight size={15} />导入高级铸造</button> : null}
                {analysis.nftContract ? <button className="btn primary" type="button" onClick={openMint}><ArrowRight size={15} />导入 OpenSea 铸造</button> : null}
              </div>
            </>
          ) : <div className="signatureEmpty"><ScanSearch size={26} /><strong>等待真实交易输入</strong><span>解析结果会标记公开、签名或白名单阶段，并保留原始 selector。</span></div>}
        </section>
      </div>

      {preflight ? (
        <section className="operationForm signaturePreflight">
          <div className="formTitleRow"><h2>钱包预检</h2><small>{preflight.ready} 个就绪 / {preflight.failed} 个失败</small></div>
          <div className="tableWrap"><table><thead><tr><th>状态</th><th>钱包</th><th>地址</th><th>模拟结果</th></tr></thead><tbody>
            {preflight.wallets.map((row) => <tr key={row.walletId}><td><span className={`pill ${row.status}`}>{uiStatus(row.status)}</span></td><td><strong>{row.walletId}</strong></td><td><code>{row.address}</code></td><td>{row.reason ? uiError(row.reason) : <span className="readyText"><Check size={13} />eth_call 通过</span>}</td></tr>)}
          </tbody></table></div>
        </section>
      ) : null}

      <div className="signatureBoundary"><Wallet size={16} /><div><strong>分析与预检不会发送交易</strong><span>项目签名和白名单证明仍由目标合约验证；广播统一在 OpenSea 工作台执行新的报价、余额与 Gas 检查。</span></div></div>
    </div>
  )
}
