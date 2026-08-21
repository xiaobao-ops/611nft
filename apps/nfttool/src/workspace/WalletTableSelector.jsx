import { Search, X } from "lucide-react"
import { useMemo, useState } from "react"
import { groupWallets, toggleWalletGroup, walletGroupSelection } from "./wallet-selection.js"

function cachedNativeBalance(wallet, chainId) {
  return wallet.balances?.find((balance) => balance.chainId === Number(chainId) && balance.tokenKey === "native")
}

export function WalletGroupQuickSelect({ wallets, selectedIds, onChange, label = "分组", compact = false, disabled = false }) {
  const groups = useMemo(() => groupWallets(wallets), [wallets])
  const selected = new Set(selectedIds.map(String))
  if (!groups.length) return null

  return (
    <div className={compact ? "groupQuickSelect compact" : "groupQuickSelect"}>
      <span>{label}</span>
      <div className="groupChipRow">
        {groups.map((group) => {
          const { selectedCount, total, complete, partial } = walletGroupSelection(selected, group.walletIds)
          return (
            <button
              key={`wallet-group:${group.key}`}
              className={complete ? "active" : partial ? "partial" : ""}
              type="button"
              onClick={() => onChange(toggleWalletGroup(selectedIds, group.walletIds))}
              disabled={disabled}
              aria-pressed={complete}
              data-selection={complete ? "complete" : partial ? "partial" : "empty"}
              title={`${group.label}：已选择 ${selectedCount}/${total}，点击${complete ? "清除该组" : "全选该组"}`}
            >
              <span>{group.label}</span>
              <small>{selectedCount}/{total}</small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function WalletTableSelector({
  wallets,
  selectedIds,
  onChange,
  chainId,
  title = "账户",
  blockedIds = [],
  disabled = false,
  compact = false,
  showSearch = true,
}) {
  const [query, setQuery] = useState("")
  const blocked = useMemo(() => new Set(blockedIds.map(String)), [blockedIds])
  const selected = useMemo(() => new Set(selectedIds.map(String)), [selectedIds])
  const eligible = useMemo(() => wallets.filter((wallet) => !blocked.has(String(wallet.id))), [wallets, blocked])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return eligible
    return eligible.filter((wallet) => `${wallet.id} ${wallet.label} ${wallet.note} ${wallet.group} ${wallet.address}`.toLowerCase().includes(normalized))
  }, [eligible, query])
  const allVisibleSelected = visible.length > 0 && visible.every((wallet) => selected.has(String(wallet.id)))

  function toggleWallet(id) {
    const normalizedId = String(id)
    const next = selectedIds.map(String)
    const index = next.indexOf(normalizedId)
    if (index >= 0) next.splice(index, 1)
    else next.push(normalizedId)
    onChange(next)
  }

  function toggleVisible() {
    const visibleIds = visible.map((wallet) => String(wallet.id))
    if (allVisibleSelected) {
      onChange(selectedIds.map(String).filter((id) => !visibleIds.includes(id)))
      return
    }
    const next = selectedIds.map(String)
    for (const id of visibleIds) if (!next.includes(id)) next.push(id)
    onChange(next)
  }

  return (
    <section className={`walletTableSelector${compact ? " compact" : ""}`}>
      <header className="walletSelectorHeader">
        <div><strong>{title}({selected.size})</strong><span>{eligible.length} 个本地钱包</span></div>
        <div className="walletSelectorActions">
          <button type="button" onClick={toggleVisible} disabled={disabled || !visible.length}>{allVisibleSelected ? "清除当前" : "全选当前"}</button>
          <button type="button" onClick={() => onChange([])} disabled={disabled || !selected.size}>清空</button>
        </div>
      </header>
      <WalletGroupQuickSelect wallets={eligible} selectedIds={selectedIds} onChange={onChange} compact label="分组" disabled={disabled} />
      {showSearch ? (
        <label className="walletSelectorSearch">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选名称、分组或地址" />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label="清空钱包筛选"><X size={13} /></button> : null}
        </label>
      ) : null}
      <div className="tableWrap walletSelectorTableWrap">
        <table className="walletSelectorTable">
          <thead><tr><th><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} disabled={disabled || !visible.length} aria-label="全选当前钱包" /></th><th>备注</th><th>地址</th><th>余额</th><th>分组</th></tr></thead>
          <tbody>
            {visible.map((wallet) => {
              const balance = cachedNativeBalance(wallet, chainId)
              return (
                <tr key={wallet.id} className={selected.has(String(wallet.id)) ? "selectedRow" : ""}>
                  <td><input type="checkbox" checked={selected.has(String(wallet.id))} onChange={() => toggleWallet(wallet.id)} disabled={disabled} aria-label={`选择钱包 ${wallet.label || wallet.id}`} /></td>
                  <td><strong>{wallet.label || wallet.id}</strong><small>{wallet.note || wallet.id}</small></td>
                  <td><code>{wallet.address}</code></td>
                  <td>{balance ? <span>{Number(balance.formatted).toFixed(6)} {balance.symbol}</span> : <span className="muted">未查询</span>}</td>
                  <td>{wallet.group || <span className="muted">未分组</span>}</td>
                </tr>
              )
            })}
            {!visible.length ? <tr><td colSpan="5" className="miniEmpty">没有匹配的钱包</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
