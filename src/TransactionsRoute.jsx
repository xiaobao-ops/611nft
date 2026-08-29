import { ExternalLink, History, RefreshCcw, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { requestJson } from "./api.js"
import { uiError, uiStatus, uiTransactionType } from "./ui-text.js"
import "./utility-routes.css"

function shortHash(value) {
  const text = String(value || "")
  return text.length > 14 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text
}

function statusTone(value) {
  const status = String(value || "").toLowerCase()
  if (["confirmed", "completed", "success", "done"].includes(status)) return "success"
  if (["failed", "error", "replaced"].includes(status)) return "danger"
  if (["pending", "sending", "running", "confirmation_pending"].includes(status)) return "pending"
  return "neutral"
}

function explorerTransaction(chains, transaction) {
  const chain = chains.find((item) => Number(item.id) === Number(transaction.chainId))
  const explorer = String(chain?.explorer || "").replace(/\/+$/, "")
  return transaction.txHash && /^https?:\/\//i.test(explorer) ? `${explorer}/tx/${transaction.txHash}` : ""
}

function displayError(error) {
  return uiError(error?.message || error) || "请求失败，请检查本地服务状态。"
}

function displayTime(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("zh-CN") : "—"
}

export default function TransactionsRoute() {
  const [transactions, setTransactions] = useState([])
  const [chains, setChains] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const requestId = useRef(0)

  const loadTransactions = useCallback(async ({ signal } = {}) => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setError("")
    try {
      const [chainData, transactionData] = await Promise.all([
        requestJson("/api/chains", { signal }),
        requestJson("/api/transactions?limit=100", { signal }),
      ])
      if (currentRequest !== requestId.current) return
      setChains(Array.isArray(chainData.chains) ? chainData.chains : [])
      setTransactions(Array.isArray(transactionData.transactions) ? transactionData.transactions : [])
      setLoading(false)
    } catch (caught) {
      if (caught.name === "AbortError" || currentRequest !== requestId.current) return
      setLoading(false)
      setError(displayError(caught))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadTransactions({ signal: controller.signal })
    return () => controller.abort()
  }, [loadTransactions])

  return (
    <section className="utilityRoute" aria-label="交易记录">
      <div className="utilityToolbar">
        <div className="utilityToolbarCopy">
          <strong>最近交易</strong>
          <span>读取本地执行日志与链上交易回执，共 {transactions.length} 条</span>
        </div>
        <div className="utilityToolbarActions">
          <button className="utilityButton" type="button" disabled={loading} onClick={() => void loadTransactions()}>
            <RefreshCcw className={loading ? "spin" : ""} size={15} />刷新
          </button>
        </div>
      </div>

      {error ? <div className="utilityError" role="alert"><ShieldAlert size={16} />{error}</div> : null}

      <div className="transactionTable" aria-busy={loading}>
        <table>
          <thead><tr><th>状态</th><th>钱包</th><th>类型</th><th>交易哈希</th><th>摘要</th><th>时间</th></tr></thead>
          <tbody>
            {transactions.map((transaction) => {
              const transactionUrl = explorerTransaction(chains, transaction)
              return (
                <tr key={transaction.id}>
                  <td data-label="状态"><span className={`transactionStatus ${statusTone(transaction.status)}`}>{uiStatus(transaction.status)}</span></td>
                  <td data-label="钱包"><strong className="transactionWallet">{transaction.walletId || "—"}</strong></td>
                  <td data-label="类型">{uiTransactionType(transaction.type)}</td>
                  <td data-label="交易哈希">{transactionUrl ? <a className="transactionLink" href={transactionUrl} target="_blank" rel="noreferrer" title={transaction.txHash}><code>{shortHash(transaction.txHash)}</code><ExternalLink size={13} /></a> : transaction.txHash ? <code title={transaction.txHash}>{shortHash(transaction.txHash)}</code> : <span className="utilityMuted">无</span>}</td>
                  <td data-label="摘要" className={transaction.error ? "transactionError" : ""}>{transaction.error ? uiError(transaction.error) : transaction.summary || "—"}</td>
                  <td data-label="时间"><time dateTime={transaction.createdAt || undefined}>{displayTime(transaction.createdAt)}</time></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!transactions.length ? <div className="utilityEmpty"><History size={21} /><strong>{loading ? "正在读取交易记录" : "暂无交易记录"}</strong></div> : null}
      </div>
    </section>
  )
}
