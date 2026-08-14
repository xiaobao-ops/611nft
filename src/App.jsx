import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  BadgeCheck,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Coins,
  ExternalLink,
  FileJson,
  Gauge,
  Globe2,
  ImagePlus,
  KeyRound,
  Layers3,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RadioTower,
  RefreshCcw,
  Search,
  Send,
  Server,
  ShieldAlert,
  Star,
  Square,
  Tags,
  Terminal,
  Wallet,
  X,
  Zap,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { readStoredChainId, resolveSupportedChainId, saveStoredChainId } from "./chain-preference.js"
import {
  collectionDetailFromMintEvent,
  optimisticCollectionDetail,
  syncCollectionDetailFromOverview,
} from "./collection-detail.js"
import { confirmedTaskPrompt, confirmedTaskRequest, redactSensitiveResult } from "./confirmed-task.js"
import { documentLanguage, readMonitorLanguage, saveMonitorLanguage } from "./language.js"
import { liveFeedSnapshot, visibleLiveFeedEvents } from "./live-feed.js"
import { canChangeMintInputs, isMintJobSending } from "./mint-job-state.js"
import { mintSetupFromCollection, mintSetupFromRecentMint } from "./mint-setup.js"
import { formatRelativeTime } from "./relative-time.js"
import logoUrl from "../apps/web/assets/611nft-logo.png"

const tabs = [
  { id: "wallets", label: "Wallets", icon: Wallet },
  { id: "balances", label: "Balances", icon: Gauge },
  { id: "one", label: "One To Many", icon: Send },
  { id: "many", label: "Many To One", icon: ArrowDownToLine },
  { id: "multi", label: "Many To Many", icon: ArrowRightLeft },
  { id: "approval", label: "Approvals", icon: ShieldAlert },
  { id: "contract", label: "Contract Calls", icon: FileJson },
  { id: "mint", label: "NFT Mint", icon: ImagePlus },
  { id: "script", label: "Script", icon: Terminal },
  { id: "tx", label: "Transactions", icon: Activity },
]

const defaultTabId = "wallets"
const tabStorageKey = "evm-board-active-tab"
const tabIds = new Set(tabs.map((item) => item.id))
const sidebarStorageKey = "evm-board-sidebar-collapsed"

const mintCopy = {
  en: {
    title: "NFT Mint Monitor",
    subtitle: "Discover live mints, inspect collections and preview selected wallets before signing.",
    monitor: "Mint Monitor",
    execute: "Mint Setup",
    live: "Live Activity",
    search: "Search name or contract",
    all: "All",
    mintable: "Mintable",
    airdrop: "Airdrop",
    waiting: "Waiting for on-chain mint activity",
    noMatch: "No collections match these filters",
    selectCollection: "Select a collection to inspect supply, price and recent mints.",
    recentMints: "Recent Mints",
    collectionDetails: "Collection Details",
    sourceProvider: "Provider feed",
    sourceRpc: "Direct RPC fallback",
    streamConnected: "SSE connected",
    streamConnecting: "SSE connecting",
    streamOffline: "SSE offline",
    scanStrategy: "Scan strategy",
    coverage: "Block coverage",
    limitedHistory: "The selected time window can exceed local block coverage. Results only include scanned blocks.",
    degraded: "Degraded",
    liveStatus: "Live",
    catchingUp: "Catching up",
    syncStatus: "Sync status",
    synced: "Fully synced",
    refresh: "Refresh",
    useContract: "Use in Setup",
    reuseMint: "Reuse setup",
    viewContract: "View contract",
    supply: "Minted Supply",
    maxSupply: "Max Supply",
    uniqueMinters: "Unique Minters",
    uniqueMintersLoading: "Backfilling full history",
    uniqueMintersError: "History backfill delayed",
    mintPrice: "Mint Price",
    floor: "Floor Price",
    walletLimit: "Wallet Limit",
    walletLimitHint: "Cumulative maximum per wallet for the active mint stage; not a per-transaction quantity limit.",
    walletLimitUnknown: "Not exposed",
    walletLimitUnknownHint: "No public on-chain wallet limit was detected for this mint route.",
    unavailable: "Unavailable",
    noRecent: "No recent events in the selected window",
    loadingRecent: "Loading recent mints…",
    slowRecent: "Still loading recent mints. On-chain RPC may be busy…",
    detailLoadFailed: "Recent mints could not be loaded.",
    retry: "Retry",
    gasFee: "Gas fee",
    gasPending: "Gas pending",
    livePaused: "Paused on hover",
    viewTransaction: "View transaction",
    noNftMedia: "No NFT media published; showing a contract identicon",
  },
  zh: {
    title: "NFT Mint 实时监控",
    subtitle: "发现实时 Mint、审查合集，并在签名前逐钱包预览。",
    monitor: "Mint 监控",
    execute: "Mint 设置",
    live: "实时活动",
    search: "搜索名称或合约",
    all: "全部",
    mintable: "可 Mint",
    airdrop: "空投",
    waiting: "正在等待链上 Mint 活动",
    noMatch: "没有符合筛选条件的合集",
    selectCollection: "选择合集以查看供应量、价格与最近 Mint。",
    recentMints: "最近 Mint",
    collectionDetails: "合集详情",
    sourceProvider: "第三方数据源",
    sourceRpc: "RPC 链上回退",
    streamConnected: "SSE 已连接",
    streamConnecting: "SSE 连接中",
    streamOffline: "SSE 已断开",
    scanStrategy: "扫描策略",
    coverage: "区块覆盖",
    limitedHistory: "所选时间窗口可能超过本地区块覆盖范围，当前仅展示已扫描区块。",
    degraded: "降级",
    liveStatus: "实时",
    catchingUp: "正在追赶",
    syncStatus: "同步状态",
    synced: "已完整追平",
    refresh: "刷新",
    useContract: "套用到 Mint 设置",
    reuseMint: "套用参数",
    viewContract: "查看合约",
    supply: "已 Mint 供应量",
    maxSupply: "最大供应量",
    uniqueMinters: "独立 Mint 钱包",
    uniqueMintersLoading: "正在回填全历史",
    uniqueMintersError: "历史回填暂时延迟",
    mintPrice: "Mint 价格",
    floor: "地板价",
    walletLimit: "单钱包累计上限",
    walletLimitHint: "当前 Mint 阶段中每个钱包的累计上限，并非单笔交易数量上限。",
    walletLimitUnknown: "未公开",
    walletLimitUnknownHint: "当前 Mint 路由未检测到公开可读的链上钱包限额。",
    unavailable: "不可用",
    noRecent: "所选时间窗口内暂无事件",
    loadingRecent: "正在加载最近 Mint…",
    slowRecent: "最近 Mint 仍在加载，链上 RPC 可能繁忙…",
    detailLoadFailed: "最近 Mint 加载失败。",
    retry: "重试",
    gasFee: "Gas 消耗",
    gasPending: "Gas 待确认",
    livePaused: "悬停已暂停",
    viewTransaction: "查看交易",
    noNftMedia: "合约未发布 NFT 图片，当前显示合约识别图",
  },
}

const emptyOp = {
  loading: false,
  result: null,
  error: "",
}

function readInitialTab() {
  if (typeof window === "undefined") return defaultTabId
  try {
    const saved = window.localStorage.getItem(tabStorageKey)
    return tabIds.has(saved) ? saved : defaultTabId
  } catch {
    return defaultTabId
  }
}

function saveActiveTab(tabId) {
  try {
    window.localStorage.setItem(tabStorageKey, tabId)
  } catch {
    // localStorage can be unavailable in strict privacy modes.
  }
}

function readSidebarCollapsed() {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(sidebarStorageKey) === "true"
  } catch {
    return false
  }
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""
}

function nativeBalance(wallet, chainId) {
  return wallet.balances?.find((b) => b.chainId === Number(chainId) && b.tokenKey === "native")
}

function walletOption(wallet) {
  return wallet ? `${wallet.id} - ${shortAddress(wallet.address)}` : ""
}

function selectedWalletsInOrder(wallets, ids) {
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]))
  return ids.map((id) => byId.get(id)).filter(Boolean)
}

function walletGroups(wallets) {
  const byGroup = new Map()
  for (const wallet of wallets) {
    if (!wallet.group) continue
    if (!byGroup.has(wallet.group)) byGroup.set(wallet.group, [])
    byGroup.get(wallet.group).push(wallet)
  }
  return [...byGroup.entries()].map(([name, groupWallets]) => ({ name, wallets: groupWallets }))
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed: ${path}`)
  return data
}

function useForm(initial) {
  const [form, setForm] = useState(initial)
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
  return [form, set, setForm]
}

function Button({ children, icon: Icon, tone = "default", busy, ...props }) {
  return (
    <button className={`btn ${tone}`} disabled={busy || props.disabled} {...props}>
      {busy ? <RefreshCcw className="spin" size={15} /> : Icon ? <Icon size={15} /> : null}
      <span>{children}</span>
    </button>
  )
}

function contractAvatarStyle(seed) {
  const value = String(seed || "0x0").replace(/^0x/, "").padEnd(12, "0")
  const hue = Number.parseInt(value.slice(0, 6), 16) % 360
  const turn = Number.parseInt(value.slice(6, 12), 16) % 360
  return {
    background: `linear-gradient(135deg, hsl(${hue} 42% 24%), hsl(${turn} 38% 13%))`,
  }
}

function NftImage({ src, alt, className = "", fallbackSeed = "", fallbackLabel = "NFT", fallbackTitle = "NFT media unavailable" }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) {
    return (
      <span
        className={`nftImageFallback contractIdenticon ${className}`}
        style={contractAvatarStyle(fallbackSeed)}
        role="img"
        aria-label={`${alt}. ${fallbackTitle}`}
        title={fallbackTitle}
      >
        <span>{String(fallbackLabel || "NFT").trim().slice(0, 2).toUpperCase()}</span>
      </span>
    )
  }
  return <img className={`nftImage ${className}`} src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}

function ResultBox({ op }) {
  if (!op.error && !op.result) return null
  return (
    <pre className={op.error ? "result error" : "result"}>
      {op.error || JSON.stringify(op.result, null, 2)}
    </pre>
  )
}

function Stat({ icon: Icon, label, value, sub }) {
  return (
    <div className="stat">
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {sub ? <small>{sub}</small> : null}
      </div>
    </div>
  )
}

function SelectionBar({ selectedCount, onClear, disabled = false }) {
  return (
    <div className="selectionBar">
      <ListChecks size={15} />
      <span>{selectedCount} selected</span>
      <button onClick={onClear} type="button" disabled={disabled} aria-label="Clear selected wallets">
        <X size={14} />
      </button>
    </div>
  )
}

export default function App() {
  const [wallets, setWallets] = useState([])
  const [walletRoot, setWalletRoot] = useState("")
  const [chains, setChains] = useState([])
  const [chainId, setChainId] = useState(readStoredChainId)
  const [tab, setTab] = useState(readInitialTab)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [selected, setSelected] = useState(new Set())
  const [query, setQuery] = useState("")
  const [groupFilter, setGroupFilter] = useState("")
  const [activeWallet, setActiveWallet] = useState(null)
  const [op, setOp] = useState(emptyOp)
  const [transactions, setTransactions] = useState([])
  const [scriptStatus, setScriptStatus] = useState(null)
  const [scriptBusy, setScriptBusy] = useState(false)
  const [scriptError, setScriptError] = useState("")
  const [rpcTest, setRpcTest] = useState(null)
  const [scriptResults, setScriptResults] = useState(null)
  const [armConfirm, setArmConfirm] = useState("")
  const [nftMintJob, setNftMintJob] = useState(null)
  const [nftMintBusy, setNftMintBusy] = useState(false)
  const [nftMintError, setNftMintError] = useState("")
  const [mintMonitor, setMintMonitor] = useState({ loading: false, data: null, error: "" })
  const [mintMonitorWindow, setMintMonitorWindow] = useState(1800)
  const [mintMonitorFilter, setMintMonitorFilter] = useState("all")
  const [mintMonitorQuery, setMintMonitorQuery] = useState("")
  const [mintMonitorLanguage, setMintMonitorLanguage] = useState(readMonitorLanguage)
  const [mintMonitorEvents, setMintMonitorEvents] = useState([])
  const [mintMonitorStream, setMintMonitorStream] = useState("connecting")
  const [mintCollection, setMintCollection] = useState(null)
  const [mintCollectionBusy, setMintCollectionBusy] = useState(false)
  const [mintCollectionSlow, setMintCollectionSlow] = useState(false)
  const [mintCollectionError, setMintCollectionError] = useState("")
  const mintCollectionRequest = useRef({ id: 0, controller: null })
  const [mintSetupNotice, setMintSetupNotice] = useState("")

  const [createForm, setCreateForm] = useForm({ prefix: "bt", start: 101, count: 10 })
  const [balanceForm, setBalanceForm] = useForm({ tokenAddress: "" })
  const [oneForm, setOneForm] = useForm({ fromId: "default", targetIds: [], asset: "native", tokenAddress: "", amountMode: "fixed", amount: "0.001", targetBalance: "0.001", executionMode: "sequential" })
  const [manyForm, setManyForm] = useForm({ sourceIds: [], destinationWalletId: "default", reserveEth: "0.00005" })
  const [multiForm, setMultiForm] = useForm({ senderIds: [], receiverIds: [], asset: "native", tokenAddress: "", amount: "0.0001", executionMode: "sequential", preflight: true })
  const [approvalForm, setApprovalForm] = useForm({ tokenAddress: "", spender: "", amount: "0", revoke: false, executionMode: "sequential" })
  const [contractForm, setContractForm] = useForm({ to: "", valueWei: "0", data: "0x", executionMode: "sequential", preflight: true })
  const [mintForm, setMintForm, setMintFormState] = useForm({ contractAddress: "", quantity: "1", tokenId: "0", concurrency: "5", maxMintCostEth: "" })

  const chain = useMemo(() => chains.find((item) => item.id === Number(chainId)) || chains[0], [chains, chainId])
  const selectedIds = useMemo(() => [...selected], [selected])
  const selectedWallets = useMemo(() => wallets.filter((wallet) => selected.has(wallet.id)), [wallets, selected])
  const groups = useMemo(() => [...new Set(wallets.map((w) => w.group).filter(Boolean))].sort(), [wallets])
  const mintInputsLocked = !canChangeMintInputs(nftMintJob)

  const filteredWallets = useMemo(() => {
    const q = query.trim().toLowerCase()
    return wallets.filter((wallet) => {
      const haystack = `${wallet.id} ${wallet.address} ${wallet.label} ${wallet.group} ${wallet.note}`.toLowerCase()
      if (q && !haystack.includes(q)) return false
      if (groupFilter && wallet.group !== groupFilter) return false
      return true
    })
  }, [wallets, query, groupFilter])

  const totalNative = useMemo(() => {
    return wallets.reduce((sum, wallet) => {
      const balance = nativeBalance(wallet, chainId)
      return sum + Number(balance?.formatted || 0)
    }, 0)
  }, [wallets, chainId])

  async function loadAll() {
    const [walletData, chainData, txData] = await Promise.all([
      api("/api/wallets"),
      api("/api/chains"),
      api("/api/transactions?limit=100"),
    ])
    setWallets(walletData.wallets)
    setWalletRoot(walletData.walletRoot || "")
    setChains(chainData.chains)
    setChainId((current) => resolveSupportedChainId(current, chainData.chains))
    setTransactions(txData.transactions)
    if (!activeWallet && walletData.wallets[0]) setActiveWallet(walletData.wallets[0])
  }

  async function loadScriptStatus() {
    const data = await api("/api/mint-script/status")
    setScriptStatus(data.status)
    return data.status
  }

  async function loadScriptResults() {
    const data = await api("/api/mint-script/results")
    setScriptResults(data.results)
    return data.results
  }

  useEffect(() => {
    loadAll().catch((error) => setOp({ loading: false, result: null, error: error.message }))
    loadScriptStatus().catch((error) => setScriptError(error.message))
    loadScriptResults().catch((error) => setScriptError(error.message))
  }, [])

  useEffect(() => {
    saveActiveTab(tab)
  }, [tab])

  useEffect(() => {
    saveStoredChainId(chainId)
  }, [chainId])

  useEffect(() => {
    try {
      window.localStorage.setItem(sidebarStorageKey, String(sidebarCollapsed))
    } catch {
      // localStorage can be unavailable in strict privacy modes.
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    saveMonitorLanguage(mintMonitorLanguage)
    document.documentElement.lang = documentLanguage(mintMonitorLanguage)
  }, [mintMonitorLanguage])

  useEffect(() => {
    setNftMintJob((current) => isMintJobSending(current) ? current : null)
    setNftMintError("")
  }, [chainId, mintForm.contractAddress, mintForm.quantity, mintForm.tokenId, mintForm.concurrency, mintForm.maxMintCostEth, selectedIds.join("|")])

  useEffect(() => {
    if (!nftMintJob?.id || !isMintJobSending(nftMintJob)) return undefined
    let alive = true
    const refresh = async () => {
      try {
        const data = await api(`/api/nft-mint/jobs/${nftMintJob.id}`)
        if (!alive) return
        setNftMintJob((current) => ({ ...data.job, confirmationToken: current?.confirmationToken }))
        if (!["sending"].includes(data.job.status)) {
          await loadAll()
        }
      } catch (error) {
        if (alive) setNftMintError(error.message)
      }
    }
    refresh()
    const interval = setInterval(refresh, 2000)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [tab, nftMintJob?.id, nftMintJob?.status])

  useEffect(() => {
    if (tab !== "mint") return undefined
    let alive = true
    let events
    setMintMonitorStream("connecting")

    const loadOverview = async ({ quiet = false } = {}) => {
      if (!quiet && alive) setMintMonitor((current) => ({ ...current, loading: true, error: "" }))
      try {
        const data = await api(`/api/mint-monitor/overview?chainId=${Number(chainId)}&window=${mintMonitorWindow}`)
        if (!alive) return
        setMintMonitor({ loading: false, data, error: "" })
        const overviewRows = data.windows?.[String(mintMonitorWindow)] || []
        setMintCollection((current) => syncCollectionDetailFromOverview(current, overviewRows))
        setMintMonitorEvents((current) => {
          const merged = [...(data.events || []), ...current]
          return [...new Map(merged.map((event) => [event.id || `${event.txHash}-${event.address}`, event])).values()].slice(0, 100)
        })
      } catch (error) {
        if (alive) setMintMonitor((current) => ({ ...current, loading: false, error: error.message }))
      }
    }

    void loadOverview()
    const refresh = setInterval(() => void loadOverview({ quiet: true }), 15000)
    if (typeof EventSource !== "undefined") {
      events = new EventSource(`/api/mint-monitor/stream?chainId=${Number(chainId)}`)
      events.onopen = () => {
        if (alive) setMintMonitorStream("connected")
      }
      events.onmessage = (message) => {
        if (!alive) return
        try {
          const value = JSON.parse(message.data)
          if (value.type === "mint") {
            setMintMonitorEvents((current) => [value, ...current.filter((event) => event.id !== value.id)].slice(0, 100))
            setMintCollection((current) => collectionDetailFromMintEvent(current, value))
            void loadOverview({ quiet: true })
          } else if (value.type === "mint_update") {
            setMintMonitorEvents((current) => current.map((event) => event.id === value.id ? { ...event, ...value } : event))
            setMintMonitor((current) => current.data ? ({
              ...current,
              data: {
                ...current.data,
                events: (current.data.events || []).map((event) => event.id === value.id ? { ...event, ...value } : event),
                windows: Object.fromEntries(Object.entries(current.data.windows || {}).map(([key, rows]) => [
                  key,
                  rows.map((row) => row.address?.toLowerCase() === value.address?.toLowerCase() ? { ...row, image_url: value.imageUrl } : row),
                ])),
              },
            }) : current)
            setMintCollection((current) => current?.address?.toLowerCase() === value.address?.toLowerCase() ? ({
              ...current,
              image_url: value.imageUrl || current.image_url,
              recent_mints: (current.recent_mints || []).map((mint) => mint.tx_hash === value.txHash ? { ...mint, image_url: value.imageUrl, token_name: value.tokenName } : mint),
            }) : current)
          } else if (value.type === "minter_backfill_update") {
            const minterUpdate = {
              unique_minters: value.unique_minters,
              unique_minters_status: value.unique_minters_status,
              unique_minters_error: value.unique_minters_error,
              unique_minters_pages_scanned: value.unique_minters_pages_scanned,
              unique_minters_updated_at: value.unique_minters_updated_at,
            }
            setMintMonitor((current) => current.data ? ({
              ...current,
              data: {
                ...current.data,
                windows: Object.fromEntries(Object.entries(current.data.windows || {}).map(([key, rows]) => [
                  key,
                  rows.map((row) => row.address?.toLowerCase() === value.address?.toLowerCase() ? { ...row, ...minterUpdate } : row),
                ])),
              },
            }) : current)
            setMintCollection((current) => current?.address?.toLowerCase() === value.address?.toLowerCase()
              ? { ...current, ...minterUpdate }
              : current)
          } else if (value.type === "monitor_status") {
            setMintMonitor((current) => current.data ? ({
              ...current,
              data: { ...current.data, ...value, mode: value.status || value.mode || current.data.mode },
            }) : current)
            void loadOverview({ quiet: true })
          }
        } catch {
          // Ignore malformed events and allow EventSource to continue.
        }
      }
      events.onerror = () => {
        if (alive) setMintMonitorStream("offline")
      }
    }

    return () => {
      alive = false
      clearInterval(refresh)
      events?.close()
      setMintMonitorStream("offline")
    }
  }, [tab, chainId, mintMonitorWindow])

  useEffect(() => {
    mintCollectionRequest.current.controller?.abort()
    mintCollectionRequest.current = { id: mintCollectionRequest.current.id + 1, controller: null }
    setMintCollection(null)
    setMintCollectionBusy(false)
    setMintCollectionSlow(false)
    setMintCollectionError("")
    setMintMonitorEvents([])
  }, [chainId])

  useEffect(() => {
    if (tab !== "script") return undefined
    let alive = true
    const refresh = () => {
      loadScriptStatus().catch((error) => {
        if (alive) setScriptError(error.message)
      })
      loadScriptResults().catch((error) => {
        if (alive) setScriptError(error.message)
      })
    }
    refresh()
    const interval = setInterval(refresh, scriptStatus?.running ? 2500 : 8000)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [tab, scriptStatus?.running])

  function toggleWallet(id) {
    if (mintInputsLocked) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectFiltered() {
    if (mintInputsLocked) return
    setSelected(new Set(filteredWallets.map((wallet) => wallet.id)))
  }

  function setSelectedIds(ids) {
    if (mintInputsLocked) return
    setSelected(new Set(ids))
  }

  async function runOperation(fn) {
    setOp({ loading: true, result: null, error: "" })
    try {
      const result = await fn()
      setOp({ loading: false, result: redactSensitiveResult(result), error: "" })
      await loadAll()
      return result
    } catch (error) {
      setOp({ loading: false, result: null, error: error.message })
      throw error
    }
  }

  async function executePreviewedTask({ planPath, taskPath, body, prompt }) {
    await runOperation(async () => {
      const plan = await api(planPath, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!window.confirm(confirmedTaskPrompt(prompt, plan))) {
        return { ok: true, cancelled: true, plan }
      }
      return api(taskPath, {
        method: "POST",
        body: JSON.stringify(confirmedTaskRequest(plan)),
      })
    })
  }

  async function saveWalletMeta(wallet) {
    await runOperation(() =>
      api(`/api/wallets/${wallet.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: wallet.label,
          group: wallet.group,
          note: wallet.note,
          favorite: wallet.favorite,
          risk: wallet.risk,
        }),
      }),
    )
  }

  async function createWallets() {
    await runOperation(() =>
      api("/api/wallets/create", {
        method: "POST",
        body: JSON.stringify(createForm),
      }),
    )
  }

  async function refreshBalances(walletIds = selectedIds.length ? selectedIds : filteredWallets.map((wallet) => wallet.id)) {
    await runOperation(() =>
      api("/api/balances/refresh", {
        method: "POST",
        body: JSON.stringify({ walletIds, chainId: Number(chainId), tokenAddress: balanceForm.tokenAddress.trim() }),
      }),
    )
  }

  async function planOneToMany() {
    await runOperation(() =>
      api("/api/plan/one-to-many", {
        method: "POST",
        body: JSON.stringify({
          ...oneForm,
          chainId: Number(chainId),
          targetIds: oneForm.targetIds.filter((id) => id !== oneForm.fromId),
        }),
      }),
    )
  }

  async function executeOneToMany() {
    await executePreviewedTask({
      planPath: "/api/plan/one-to-many",
      taskPath: "/api/tasks/one-to-many",
      prompt: "Execute one-to-many task?",
      body: {
          ...oneForm,
          chainId: Number(chainId),
          targetIds: oneForm.targetIds.filter((id) => id !== oneForm.fromId),
      },
    })
  }

  async function planManyToOne() {
    await runOperation(() =>
      api("/api/plan/many-to-one", {
        method: "POST",
        body: JSON.stringify({
          ...manyForm,
          chainId: Number(chainId),
          sourceIds: manyForm.sourceIds.filter((id) => id !== manyForm.destinationWalletId),
        }),
      }),
    )
  }

  async function executeManyToOne() {
    await executePreviewedTask({
      planPath: "/api/plan/many-to-one",
      taskPath: "/api/tasks/many-to-one",
      prompt: "Execute many-to-one collection?",
      body: {
          ...manyForm,
          chainId: Number(chainId),
          sourceIds: manyForm.sourceIds.filter((id) => id !== manyForm.destinationWalletId),
      },
    })
  }

  async function planManyToMany() {
    await runOperation(() =>
      api("/api/plan/many-to-many", {
        method: "POST",
        body: JSON.stringify({ ...multiForm, chainId: Number(chainId) }),
      }),
    )
  }

  async function executeManyToMany() {
    await executePreviewedTask({
      planPath: "/api/plan/many-to-many",
      taskPath: "/api/tasks/many-to-many",
      prompt: "Execute many-to-many task?",
      body: { ...multiForm, chainId: Number(chainId) },
    })
  }

  async function executeApproval() {
    await executePreviewedTask({
      planPath: "/api/plan/approval",
      taskPath: "/api/tasks/approval",
      prompt: approvalForm.revoke ? "Execute approval revocation?" : "Execute approval task?",
      body: {
          ...approvalForm,
          chainId: Number(chainId),
          walletIds: selectedIds,
      },
    })
  }

  async function executeContract(form = contractForm) {
    await executePreviewedTask({
      planPath: "/api/plan/contract-call",
      taskPath: "/api/tasks/contract-call",
      prompt: `${form.executionMode === "burst" ? "Burst" : "Execute"} contract call task?`,
      body: {
          ...form,
          chainId: Number(chainId),
          walletIds: selectedIds,
      },
    })
  }

  async function createNftMintPreview() {
    const data = await api("/api/nft-mint/preview", {
      method: "POST",
      body: JSON.stringify({
        ...mintForm,
        chainId: Number(chainId),
        walletIds: selectedIds,
      }),
    })
    setNftMintJob(data.job)
    return data.job
  }

  async function previewNftMint() {
    setNftMintBusy(true)
    setNftMintError("")
    try {
      await createNftMintPreview()
    } catch (error) {
      setNftMintJob(null)
      setNftMintError(error.message)
    } finally {
      setNftMintBusy(false)
    }
  }

  async function mintNftNow() {
    setNftMintBusy(true)
    setNftMintError("")
    try {
      const freshJob = await createNftMintPreview()
      if (!freshJob.summary.ready) {
        setNftMintError("No wallet passed the automatic preflight. Review the results below before retrying.")
        return
      }
      const approved = window.confirm(
        `Automatic preflight: ${freshJob.summary.ready} ready, ${freshJob.summary.skipped} skipped, ${freshJob.summary.failed} failed. Broadcast ${freshJob.summary.ready} NFT mint transaction${freshJob.summary.ready === 1 ? "" : "s"} on ${freshJob.chainName}?`,
      )
      if (!approved) return
      setNftMintJob({ ...freshJob, status: "sending" })
      const data = await api("/api/nft-mint/send", {
        method: "POST",
        body: JSON.stringify({
          jobId: freshJob.id,
          confirmationToken: freshJob.confirmationToken,
        }),
      })
      setNftMintJob(data.job)
    } catch (error) {
      setNftMintError(error.message)
    } finally {
      setNftMintBusy(false)
    }
  }

  async function selectMintCollection(collection) {
    mintCollectionRequest.current.controller?.abort()
    const controller = new AbortController()
    const requestId = mintCollectionRequest.current.id + 1
    mintCollectionRequest.current = { id: requestId, controller }
    setMintCollection((current) => optimisticCollectionDetail(current, collection))
    setMintCollectionBusy(true)
    setMintCollectionSlow(false)
    setMintCollectionError("")
    const slowTimer = setTimeout(() => {
      if (mintCollectionRequest.current.id === requestId) setMintCollectionSlow(true)
    }, 2000)
    const timeout = setTimeout(() => controller.abort("Collection detail timed out"), 10000)
    try {
      const data = await api(`/api/mint-monitor/collection/${collection.address}?chainId=${Number(chainId)}`, { signal: controller.signal })
      if (mintCollectionRequest.current.id !== requestId) return
      setMintCollection(data.collection)
    } catch (error) {
      if (mintCollectionRequest.current.id !== requestId) return
      setMintCollectionError(controller.signal.aborted ? "Collection detail request timed out" : error.message)
    } finally {
      clearTimeout(slowTimer)
      clearTimeout(timeout)
      if (mintCollectionRequest.current.id === requestId) {
        mintCollectionRequest.current.controller = null
        setMintCollectionBusy(false)
        setMintCollectionSlow(false)
      }
    }
  }

  function useMintCollection(collection) {
    if (mintInputsLocked) return
    const source = collection?.address ? collection : mintCollection
    if (!source?.address) return
    setMintFormState((current) => mintSetupFromCollection(current, source))
    setMintSetupNotice(`${source.name || shortAddress(source.address)} contract and mint value applied.`)
    document.getElementById("mint-setup")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  function useRecentMint(collection, mint) {
    if (mintInputsLocked) return
    if (!collection?.address || !mint) return
    setMintFormState((current) => mintSetupFromRecentMint(current, collection, mint))
    setMintSetupNotice(`${collection.name || shortAddress(collection.address)} transaction parameters applied.`)
    document.getElementById("mint-setup")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  async function startMintScript(mode) {
    if (mode === "armed" && armConfirm !== "ARM") {
      setScriptError("ARM confirmation is required")
      return
    }
    if (mode === "armed" && !window.confirm("Start armed mint runner?")) return
    setScriptBusy(true)
    setScriptError("")
    try {
      const data = await api("/api/mint-script/start", {
        method: "POST",
        body: JSON.stringify({ mode, confirm: mode === "armed" ? armConfirm : "" }),
      })
      setScriptStatus(data.status)
      await loadScriptResults()
    } catch (error) {
      setScriptError(error.message)
    } finally {
      setScriptBusy(false)
    }
  }

  async function stopMintScript() {
    setScriptBusy(true)
    setScriptError("")
    try {
      const data = await api("/api/mint-script/stop", { method: "POST", body: "{}" })
      setScriptStatus(data.status)
      await loadScriptResults()
    } catch (error) {
      setScriptError(error.message)
    } finally {
      setScriptBusy(false)
    }
  }

  async function testRobinhoodRpc() {
    setScriptBusy(true)
    setScriptError("")
    try {
      const data = await api("/api/mint-script/rpc-latency", {
        method: "POST",
        body: JSON.stringify({ samples: 5, timeoutMs: 5000 }),
      })
      setRpcTest(data.rpc)
    } catch (error) {
      setScriptError(error.message)
    } finally {
      setScriptBusy(false)
    }
  }

  function explorerTx(txHash, txChainId) {
    const cfg = chains.find((item) => item.id === Number(txChainId))
    return cfg?.explorer && txHash ? `${cfg.explorer}/tx/${txHash}` : ""
  }

  function explorerContract(address, contractChainId) {
    const cfg = chains.find((item) => item.id === Number(contractChainId))
    return cfg?.explorer && address ? `${cfg.explorer}/address/${address}` : ""
  }

  return (
    <div className={sidebarCollapsed ? "appShell sidebarCollapsed" : "appShell"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark"><img src={logoUrl} alt="" /></div>
          <div className="brandCopy">
            <strong>611nft</strong>
            <span>{mintMonitorLanguage === "zh" ? "本地多钱包 Mint" : "local multi-wallet mint"}</span>
          </div>
          <button className="sidebarToggle" type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "Show navigation" : "Hide navigation"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Show navigation" : "Hide navigation"}>
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav>
          {tabs.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} type="button" title={sidebarCollapsed ? item.label : undefined} aria-label={item.label}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="walletRoot">
          <KeyRound size={14} />
          <span>{walletRoot || "~/.openclaw-wallet/wallets"}</span>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="searchBox">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search wallets, labels, addresses" />
          </div>
          <div className="toolbar">
            <div className="selectWrap">
              <select value={chainId} onChange={(event) => setChainId(Number(event.target.value))} disabled={mintInputsLocked} aria-label="Chain">
                {chains.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <ChevronDown size={14} />
            </div>
            <Button icon={RefreshCcw} onClick={() => loadAll()} busy={op.loading}>Refresh</Button>
          </div>
        </header>

        <section className="stats">
          <Stat icon={Wallet} label="Wallets" value={wallets.length} sub={`${selected.size} selected`} />
          <Stat icon={Coins} label={chain?.nativeSymbol || "Native"} value={totalNative.toFixed(6)} sub={chain?.name} />
          <Stat icon={Tags} label="Groups" value={groups.length} sub={groupFilter || "all"} />
          <Stat icon={Activity} label="Transactions" value={transactions.length} sub="local log" />
        </section>

        {tab !== "mint" && selected.size ? <SelectionBar selectedCount={selected.size} onClear={() => setSelected(new Set())} disabled={mintInputsLocked} /> : null}

        <section className={tab === "mint" ? "contentGrid mintContentGrid" : "contentGrid"}>
          <div className="primaryPane">
            {tab === "wallets" && (
              <WalletsView
                wallets={filteredWallets}
                allWallets={wallets}
                groups={groups}
                groupFilter={groupFilter}
                setGroupFilter={setGroupFilter}
                selected={selected}
                toggleWallet={toggleWallet}
                selectFiltered={selectFiltered}
                activeWallet={activeWallet}
                setActiveWallet={setActiveWallet}
                chainId={chainId}
                onSave={saveWalletMeta}
                createForm={createForm}
                setCreateForm={setCreateForm}
                onCreate={createWallets}
                busy={op.loading}
                selectionLocked={mintInputsLocked}
              />
            )}
            {tab === "balances" && (
              <BalancesView
                wallets={filteredWallets}
                selectedIds={selectedIds}
                chainId={chainId}
                chain={chain}
                balanceForm={balanceForm}
                setBalanceForm={setBalanceForm}
                refreshBalances={refreshBalances}
                busy={op.loading}
              />
            )}
            {tab === "one" && (
              <OneToManyView wallets={wallets} form={oneForm} setForm={setOneForm} onPlan={planOneToMany} onExecute={executeOneToMany} busy={op.loading} />
            )}
            {tab === "many" && (
              <ManyToOneView wallets={wallets} form={manyForm} setForm={setManyForm} onPlan={planManyToOne} onExecute={executeManyToOne} busy={op.loading} />
            )}
            {tab === "multi" && <ManyToManyView wallets={wallets} form={multiForm} setForm={setMultiForm} onPlan={planManyToMany} onExecute={executeManyToMany} busy={op.loading} />}
            {tab === "approval" && <ApprovalView selectedIds={selectedIds} form={approvalForm} setForm={setApprovalForm} onExecute={executeApproval} busy={op.loading} />}
            {tab === "contract" && <ContractView selectedIds={selectedIds} form={contractForm} setForm={setContractForm} onExecute={() => executeContract(contractForm)} busy={op.loading} />}
            {tab === "mint" && (
              <NftMintView
                wallets={wallets}
                selectedIds={selectedIds}
                form={mintForm}
                setForm={setMintForm}
                chain={chain}
                job={nftMintJob}
                error={nftMintError}
                busy={nftMintBusy}
                onPreview={previewNftMint}
                onMint={mintNftNow}
                explorerTx={explorerTx}
                explorerContract={explorerContract}
                monitor={mintMonitor}
                monitorWindow={mintMonitorWindow}
                setMonitorWindow={setMintMonitorWindow}
                monitorFilter={mintMonitorFilter}
                setMonitorFilter={setMintMonitorFilter}
                monitorQuery={mintMonitorQuery}
                setMonitorQuery={setMintMonitorQuery}
                language={mintMonitorLanguage}
                setLanguage={setMintMonitorLanguage}
                liveEvents={mintMonitorEvents}
                streamStatus={mintMonitorStream}
                collection={mintCollection}
                collectionBusy={mintCollectionBusy}
                collectionSlow={mintCollectionSlow}
                collectionError={mintCollectionError}
                onSelectCollection={selectMintCollection}
                onUseCollection={useMintCollection}
                onUseRecentMint={useRecentMint}
                onSelectedIdsChange={setSelectedIds}
                setupNotice={mintSetupNotice}
                inputsLocked={mintInputsLocked}
              />
            )}
            {tab === "script" && (
              <ScriptControlView
                status={scriptStatus}
                results={scriptResults}
                rpcTest={rpcTest}
                error={scriptError}
                busy={scriptBusy}
                armConfirm={armConfirm}
                setArmConfirm={setArmConfirm}
                onRefresh={loadScriptStatus}
                onRefreshResults={loadScriptResults}
                onStart={startMintScript}
                onStop={stopMintScript}
                onTestRpc={testRobinhoodRpc}
              />
            )}
            {tab === "tx" && <TransactionsView transactions={transactions} explorerTx={explorerTx} />}
          </div>

          <aside className={tab === "mint" ? "sidePane mintSidePane" : "sidePane"}>
            <h2>Output</h2>
            <ResultBox op={op} />
            {!op.result && !op.error ? <div className="emptyState"><Terminal size={18} />No task output yet</div> : null}
            <h2>Recent Transactions</h2>
            <div className="miniTxList">
              {transactions.slice(0, 8).map((tx) => (
                <a key={tx.id} href={explorerTx(tx.txHash, tx.chainId) || "#"} target="_blank" rel="noreferrer" className="miniTx">
                  <span className={tx.status}>{tx.status}</span>
                  <strong>{tx.walletId}</strong>
                  <small>{tx.txHash ? shortAddress(tx.txHash) : tx.error || tx.type}</small>
                </a>
              ))}
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}

function WalletsView({ wallets, allWallets, groups, groupFilter, setGroupFilter, selected, toggleWallet, selectFiltered, activeWallet, setActiveWallet, chainId, onSave, createForm, setCreateForm, onCreate, busy, selectionLocked }) {
  const [draft, setDraft] = useState(activeWallet || {})

  useEffect(() => setDraft(activeWallet || {}), [activeWallet])

  return (
    <div className="sectionStack">
      <div className="sectionHeader">
        <div>
          <h1>Wallets</h1>
          <p>{wallets.length} visible / {allWallets.length} total</p>
        </div>
        <div className="actions">
          <div className="selectWrap">
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">All groups</option>
              {groups.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
            <ChevronDown size={14} />
          </div>
          <Button icon={Check} onClick={selectFiltered} disabled={selectionLocked}>Select Visible</Button>
        </div>
      </div>

      <div className="split">
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Profile</th>
                <th>Address</th>
                <th>Label</th>
                <th>Group</th>
                <th>Native</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((wallet) => {
                const balance = nativeBalance(wallet, chainId)
                return (
                  <tr key={wallet.id} className={activeWallet?.id === wallet.id ? "selectedRow" : ""} onClick={() => setActiveWallet(wallet)}>
                    <td><input type="checkbox" checked={selected.has(wallet.id)} onChange={() => toggleWallet(wallet.id)} onClick={(event) => event.stopPropagation()} disabled={selectionLocked} /></td>
                    <td><span className="profile">{wallet.favorite ? <Star size={13} fill="currentColor" /> : null}{wallet.id}</span></td>
                    <td><code>{shortAddress(wallet.address)}</code></td>
                    <td>{wallet.label || <span className="muted">unlabeled</span>}</td>
                    <td>{wallet.group || <span className="muted">none</span>}</td>
                    <td>{balance ? `${Number(balance.formatted).toFixed(6)} ${balance.symbol}` : <span className="muted">not cached</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="editor">
          <h2>Wallet Metadata</h2>
          {draft?.id ? (
            <>
              <div className="addressBlock">
                <strong>{draft.id}</strong>
                <code>{draft.address}</code>
              </div>
              <Field label="Label"><input value={draft.label || ""} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field>
              <Field label="Group"><input value={draft.group || ""} onChange={(event) => setDraft({ ...draft, group: event.target.value })} /></Field>
              <Field label="Risk"><input value={draft.risk || ""} onChange={(event) => setDraft({ ...draft, risk: event.target.value })} /></Field>
              <Field label="Note"><textarea value={draft.note || ""} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></Field>
              <label className="checkLine"><input type="checkbox" checked={Boolean(draft.favorite)} onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })} /> Favorite</label>
              <Button icon={BadgeCheck} onClick={() => onSave(draft)} busy={busy}>Save Metadata</Button>
            </>
          ) : <div className="emptyState">Select a wallet</div>}

          <h2>Generate Profiles</h2>
          <div className="formGrid three">
            <Field label="Prefix"><input value={createForm.prefix} onChange={(event) => setCreateForm("prefix", event.target.value)} /></Field>
            <Field label="Start"><input type="number" value={createForm.start} onChange={(event) => setCreateForm("start", event.target.value)} /></Field>
            <Field label="Count"><input type="number" value={createForm.count} onChange={(event) => setCreateForm("count", event.target.value)} /></Field>
          </div>
          <Button icon={Plus} onClick={onCreate} busy={busy}>Create Wallets</Button>
        </div>
      </div>
    </div>
  )
}

function BalancesView({ wallets, selectedIds, chain, chainId, balanceForm, setBalanceForm, refreshBalances, busy }) {
  return (
    <div className="sectionStack">
      <div className="sectionHeader">
        <div>
          <h1>Balances</h1>
          <p>{chain?.name} native and ERC20 cache</p>
        </div>
        <div className="actions">
          <Button icon={RefreshCcw} onClick={() => refreshBalances()} busy={busy}>Refresh Selection</Button>
        </div>
      </div>
      <div className="formGrid two">
        <Field label="ERC20 token">
          <input value={balanceForm.tokenAddress} onChange={(event) => setBalanceForm("tokenAddress", event.target.value)} placeholder="0x token address, blank for native" />
        </Field>
        <Field label="Scope">
          <input value={selectedIds.length ? `${selectedIds.length} selected wallets` : "visible wallets"} readOnly />
        </Field>
      </div>
      <div className="tableWrap">
        <table>
          <thead>
            <tr><th>Profile</th><th>Address</th><th>Balances</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {wallets.map((wallet) => (
              <tr key={wallet.id}>
                <td><span className="profile">{wallet.id}</span></td>
                <td><code>{wallet.address}</code></td>
                <td>
                  <div className="balanceChips">
                    {(wallet.balances || []).filter((b) => b.chainId === Number(chainId)).map((balance) => (
                      <span key={`${wallet.id}-${balance.tokenKey}`}>{Number(balance.formatted).toFixed(balance.tokenKey === "native" ? 6 : 4)} {balance.symbol}</span>
                    ))}
                  </div>
                </td>
                <td>{wallet.balances?.[0]?.updatedAt ? new Date(wallet.balances[0].updatedAt).toLocaleString() : <span className="muted">never</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function OneToManyView({ wallets, form, setForm, onPlan, onExecute, busy }) {
  const receiverIds = form.targetIds.filter((id) => id !== form.fromId)
  const canSubmit = receiverIds.length > 0

  return (
    <OperationPanel
      title="One To Many"
      subtitle={`${receiverIds.length} receiver wallets selected`}
      actions={<><Button icon={ListChecks} onClick={onPlan} busy={busy} disabled={!canSubmit}>Plan</Button><Button icon={Send} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>Execute</Button></>}
    >
      <div className="formGrid three">
        <Field label="From profile">
          <select
            value={form.fromId}
            onChange={(event) => {
              const nextId = event.target.value
              setForm("fromId", nextId)
              setForm("targetIds", form.targetIds.filter((id) => id !== nextId))
            }}
          >
            {wallets.map((wallet) => <option key={wallet.id} value={wallet.id}>{walletOption(wallet)}</option>)}
          </select>
        </Field>
        <Field label="Asset"><select value={form.asset} onChange={(event) => setForm("asset", event.target.value)}><option value="native">Native</option><option value="erc20">ERC20</option></select></Field>
        <Field label="Mode"><select value={form.amountMode} onChange={(event) => setForm("amountMode", event.target.value)}><option value="fixed">Fixed</option><option value="topup">Top Up</option></select></Field>
      </div>
      {form.asset === "erc20" ? <Field label="Token address"><input value={form.tokenAddress} onChange={(event) => setForm("tokenAddress", event.target.value)} /></Field> : null}
      <div className="formGrid two">
        <Field label="Amount"><input value={form.amount} onChange={(event) => setForm("amount", event.target.value)} disabled={form.amountMode === "topup"} /></Field>
        <Field label="Target balance"><input value={form.targetBalance} onChange={(event) => setForm("targetBalance", event.target.value)} disabled={form.amountMode !== "topup"} /></Field>
      </div>
      <Field label="Execution"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">Sequential</option><option value="burst">Burst</option></select></Field>
      <WalletMultiPicker
        title="Receiver wallets"
        wallets={wallets}
        selectedIds={receiverIds}
        blockedIds={[form.fromId]}
        onChange={(ids) => setForm("targetIds", ids.filter((id) => id !== form.fromId))}
      />
    </OperationPanel>
  )
}

function ManyToOneView({ wallets, form, setForm, onPlan, onExecute, busy }) {
  const sourceIds = form.sourceIds.filter((id) => id !== form.destinationWalletId)
  const canSubmit = sourceIds.length > 0

  return (
    <OperationPanel
      title="Many To One"
      subtitle={`${sourceIds.length} source wallets selected`}
      actions={<><Button icon={ListChecks} onClick={onPlan} busy={busy} disabled={!canSubmit}>Plan</Button><Button icon={ArrowDownToLine} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>Collect</Button></>}
    >
      <div className="formGrid two">
        <Field label="Destination profile">
          <select
            value={form.destinationWalletId}
            onChange={(event) => {
              const nextId = event.target.value
              setForm("destinationWalletId", nextId)
              setForm("sourceIds", form.sourceIds.filter((id) => id !== nextId))
            }}
          >
            {wallets.map((wallet) => <option key={wallet.id} value={wallet.id}>{walletOption(wallet)}</option>)}
          </select>
        </Field>
        <Field label="Reserve ETH"><input value={form.reserveEth} onChange={(event) => setForm("reserveEth", event.target.value)} /></Field>
      </div>
      <WalletMultiPicker
        title="Source wallets"
        wallets={wallets}
        selectedIds={sourceIds}
        blockedIds={[form.destinationWalletId]}
        onChange={(ids) => setForm("sourceIds", ids.filter((id) => id !== form.destinationWalletId))}
      />
    </OperationPanel>
  )
}

function ManyToManyView({ wallets, form, setForm, onPlan, onExecute, busy }) {
  const countsMatch = form.senderIds.length > 0 && form.senderIds.length === form.receiverIds.length
  const hasSelfPair = form.senderIds.some((id, index) => id && id === form.receiverIds[index])
  const canSubmit = countsMatch && !hasSelfPair

  return (
    <OperationPanel
      title="Many To Many"
      subtitle={`${Math.min(form.senderIds.length, form.receiverIds.length)} paired rows`}
      actions={<><Button icon={ListChecks} onClick={onPlan} busy={busy} disabled={!canSubmit}>Plan</Button><Button icon={ArrowRightLeft} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>Execute</Button></>}
    >
      <div className="formGrid three">
        <Field label="Asset"><select value={form.asset} onChange={(event) => setForm("asset", event.target.value)}><option value="native">Native</option><option value="erc20">ERC20</option></select></Field>
        <Field label="Amount"><input value={form.amount} onChange={(event) => setForm("amount", event.target.value)} /></Field>
        <Field label="Execution"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">Sequential</option><option value="burst">Burst</option></select></Field>
      </div>
      {form.asset === "erc20" ? <Field label="Token address"><input value={form.tokenAddress} onChange={(event) => setForm("tokenAddress", event.target.value)} /></Field> : null}
      <label className="checkLine"><input type="checkbox" checked={form.preflight} onChange={(event) => setForm("preflight", event.target.checked)} /> Preflight</label>
      <div className="walletPickerGrid">
        <WalletMultiPicker title="Sender wallets" wallets={wallets} selectedIds={form.senderIds} onChange={(ids) => setForm("senderIds", ids)} />
        <WalletMultiPicker title="Receiver wallets" wallets={wallets} selectedIds={form.receiverIds} onChange={(ids) => setForm("receiverIds", ids)} />
      </div>
      <PairingPreview wallets={wallets} senderIds={form.senderIds} receiverIds={form.receiverIds} amount={form.amount} />
    </OperationPanel>
  )
}

function WalletMultiPicker({ title, wallets, selectedIds, onChange, blockedIds = [] }) {
  const [pickerQuery, setPickerQuery] = useState("")
  const blocked = new Set(blockedIds)
  const selectedSet = new Set(selectedIds)
  const eligibleWallets = wallets.filter((wallet) => !blocked.has(wallet.id))
  const q = pickerQuery.trim().toLowerCase()
  const visibleWallets = eligibleWallets.filter((wallet) => {
    if (!q) return true
    return `${wallet.id} ${wallet.address} ${wallet.label} ${wallet.group} ${wallet.note}`.toLowerCase().includes(q)
  })

  function toggle(id) {
    if (selectedSet.has(id)) onChange(selectedIds.filter((selectedId) => selectedId !== id))
    else onChange([...selectedIds, id])
  }

  function selectVisible() {
    const next = [...selectedIds]
    for (const wallet of visibleWallets) {
      if (!next.includes(wallet.id)) next.push(wallet.id)
    }
    onChange(next)
  }

  function moveSelected(index, delta) {
    const nextIndex = index + delta
    if (nextIndex < 0 || nextIndex >= selectedIds.length) return
    const next = [...selectedIds]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    onChange(next)
  }

  return (
    <div className="walletPicker">
      <div className="walletPickerTop">
        <div>
          <strong>{title}</strong>
          <span>{selectedIds.length} selected from local wallets</span>
        </div>
        <div className="walletPickerTools">
          <button type="button" onClick={selectVisible}>Select visible</button>
          <button type="button" onClick={() => onChange([])}>Clear</button>
        </div>
      </div>
      <div className="walletPickerSearch">
        <Search size={14} />
        <input value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Filter wallets" />
      </div>
      <GroupQuickSelect wallets={eligibleWallets} selectedIds={selectedIds} onChange={onChange} label="Groups" compact />
      <div className="walletPickerList">
        {visibleWallets.map((wallet) => (
          <label key={wallet.id} className={selectedSet.has(wallet.id) ? "walletPickRow active" : "walletPickRow"}>
            <input type="checkbox" checked={selectedSet.has(wallet.id)} onChange={() => toggle(wallet.id)} />
            <span>
              <strong>{wallet.id}</strong>
              <code>{shortAddress(wallet.address)}</code>
            </span>
            {wallet.label ? <small>{wallet.label}</small> : null}
          </label>
        ))}
        {!visibleWallets.length ? <div className="miniEmpty">No matching wallets</div> : null}
      </div>
      <SelectedWalletList wallets={wallets} selectedIds={selectedIds} onRemove={(id) => onChange(selectedIds.filter((selectedId) => selectedId !== id))} onMove={moveSelected} />
    </div>
  )
}

function GroupQuickSelect({ wallets, selectedIds, onChange, label = "Groups", compact = false, disabled = false }) {
  const groups = walletGroups(wallets)
  if (!groups.length) return null
  const selectedSet = new Set(selectedIds)

  function toggleGroup(groupWallets) {
    const groupIds = groupWallets.map((wallet) => wallet.id)
    const groupSelected = groupIds.every((id) => selectedSet.has(id))
    if (groupSelected) {
      onChange(selectedIds.filter((id) => !groupIds.includes(id)))
      return
    }

    const next = [...selectedIds]
    for (const id of groupIds) {
      if (!next.includes(id)) next.push(id)
    }
    onChange(next)
  }

  return (
    <div className={compact ? "groupQuickSelect compact" : "groupQuickSelect"}>
      <span>{label}</span>
      <div className="groupChipRow">
        {groups.map((group) => {
          const selectedCount = group.wallets.filter((wallet) => selectedSet.has(wallet.id)).length
          const active = selectedCount === group.wallets.length
          const partial = selectedCount > 0 && !active
          return (
            <button
              key={group.name}
              className={active ? "active" : partial ? "partial" : ""}
              type="button"
              onClick={() => toggleGroup(group.wallets)}
              disabled={disabled}
              title={`${selectedCount}/${group.wallets.length} selected`}
            >
              <span>{group.name}</span>
              <small>{selectedCount}/{group.wallets.length}</small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SelectedWalletList({ wallets, selectedIds, onRemove, onMove }) {
  const selectedWallets = selectedWalletsInOrder(wallets, selectedIds)
  if (!selectedWallets.length) return <div className="selectedWalletList empty">No wallets selected</div>

  return (
    <div className="selectedWalletList">
      {selectedWallets.map((wallet, index) => (
        <div key={wallet.id} className="selectedWalletRow">
          <span>{index + 1}</span>
          <strong>{wallet.id}</strong>
          <code>{shortAddress(wallet.address)}</code>
          <div className="rowControls">
            <button type="button" title="Move up" onClick={() => onMove(index, -1)} disabled={index === 0}><ChevronUp size={14} /></button>
            <button type="button" title="Move down" onClick={() => onMove(index, 1)} disabled={index === selectedWallets.length - 1}><ChevronDown size={14} /></button>
            <button type="button" title="Remove" onClick={() => onRemove(wallet.id)}><X size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  )
}

function PairingPreview({ wallets, senderIds, receiverIds, amount }) {
  const senders = selectedWalletsInOrder(wallets, senderIds)
  const receivers = selectedWalletsInOrder(wallets, receiverIds)
  const rows = Array.from({ length: Math.max(senders.length, receivers.length) }, (_, index) => ({
    sender: senders[index],
    receiver: receivers[index],
  }))
  const countsMatch = senderIds.length > 0 && senderIds.length === receiverIds.length
  const hasSelfPair = rows.some((row) => row.sender?.id && row.sender.id === row.receiver?.id)
  const notice = !rows.length
    ? "Select local sender and receiver wallets."
    : !countsMatch
      ? "Sender and receiver counts must match."
      : hasSelfPair
        ? "A row cannot send to the same wallet."
        : `${rows.length} rows ready. Pairing follows the selected order.`

  return (
    <div className="pairingPreview">
      <div className={countsMatch && !hasSelfPair ? "pairingNotice ok" : "pairingNotice warn"}>{notice}</div>
      {rows.length ? (
        <div className="pairingTable">
          <table>
            <thead>
              <tr><th>#</th><th>Sender</th><th>Receiver</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const selfPair = row.sender?.id && row.sender.id === row.receiver?.id
                return (
                  <tr key={`${row.sender?.id || "missing-s"}-${row.receiver?.id || "missing-r"}-${index}`} className={selfPair ? "badPair" : ""}>
                    <td>{index + 1}</td>
                    <td>{row.sender ? <><strong>{row.sender.id}</strong><code>{shortAddress(row.sender.address)}</code></> : <span className="muted">missing</span>}</td>
                    <td>{row.receiver ? <><strong>{row.receiver.id}</strong><code>{shortAddress(row.receiver.address)}</code></> : <span className="muted">missing</span>}</td>
                    <td>{amount}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

function ApprovalView({ selectedIds, form, setForm, onExecute, busy }) {
  return (
    <OperationPanel
      title="Approvals"
      subtitle={`${selectedIds.length} wallets selected`}
      actions={<Button icon={ShieldAlert} tone="primary" onClick={onExecute} busy={busy}>Execute</Button>}
    >
      <Field label="Token address"><input value={form.tokenAddress} onChange={(event) => setForm("tokenAddress", event.target.value)} /></Field>
      <Field label="Spender"><input value={form.spender} onChange={(event) => setForm("spender", event.target.value)} /></Field>
      <div className="formGrid two">
        <Field label="Amount"><input value={form.amount} onChange={(event) => setForm("amount", event.target.value)} disabled={form.revoke} /></Field>
        <Field label="Execution"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">Sequential</option><option value="burst">Burst</option></select></Field>
      </div>
      <label className="checkLine"><input type="checkbox" checked={form.revoke} onChange={(event) => setForm("revoke", event.target.checked)} /> Revoke to zero</label>
    </OperationPanel>
  )
}

function ContractView({ selectedIds, form, setForm, onExecute, busy }) {
  return (
    <OperationPanel
      title="Contract Calls"
      subtitle={`${selectedIds.length} wallets selected`}
      actions={<Button icon={FileJson} tone="primary" onClick={onExecute} busy={busy}>Execute</Button>}
    >
      <Field label="Contract"><input value={form.to} onChange={(event) => setForm("to", event.target.value)} /></Field>
      <Field label="Value wei"><input value={form.valueWei} onChange={(event) => setForm("valueWei", event.target.value)} /></Field>
      <Field label="Calldata"><textarea value={form.data} onChange={(event) => setForm("data", event.target.value)} spellCheck="false" /></Field>
      <div className="formGrid two">
        <Field label="Execution"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">Sequential</option><option value="burst">Burst</option></select></Field>
        <label className="checkLine inline"><input type="checkbox" checked={form.preflight} onChange={(event) => setForm("preflight", event.target.checked)} /> Preflight</label>
      </div>
    </OperationPanel>
  )
}

function NftMintView({
  wallets, selectedIds, form, setForm, chain, job, error, busy, onPreview, onMint, explorerTx, explorerContract,
  monitor, monitorWindow, setMonitorWindow, monitorFilter, setMonitorFilter, monitorQuery, setMonitorQuery,
  language, setLanguage, liveEvents, streamStatus, collection, collectionBusy, collectionSlow, collectionError, onSelectCollection, onUseCollection,
  onUseRecentMint, onSelectedIdsChange, setupNotice, inputsLocked,
}) {
  const selectedWallets = selectedWalletsInOrder(wallets, selectedIds)
  const t = mintCopy[language]
  const [pausedLiveEvents, setPausedLiveEvents] = useState(null)
  const liveFeedPauseReasons = useRef({ hover: false, focus: false })
  const collectionRows = (monitor.data?.windows?.[String(monitorWindow)] || []).filter((item) => {
    const haystack = `${item.name || ""} ${item.symbol || ""} ${item.address || ""}`.toLowerCase()
    if (monitorQuery.trim() && !haystack.includes(monitorQuery.trim().toLowerCase())) return false
    if (monitorFilter === "mintable" && !item.is_mintable) return false
    if (monitorFilter === "airdrop" && !item.is_airdrop) return false
    return true
  })
  const visibleEvents = visibleLiveFeedEvents(liveEvents, chain?.id, pausedLiveEvents)
  const liveFeedPaused = Array.isArray(pausedLiveEvents)
  const readyTotal = (job?.wallets || [])
    .filter((wallet) => wallet.preflightStatus === "ready")
    .reduce((sum, wallet) => sum + Number(wallet.transaction?.valueEth || 0), 0)
  const terminal = ["completed", "partial", "failed"].includes(job?.status)
  const strategyLabels = {
    eth_getLogs: "eth_getLogs range",
    per_block_eth_getLogs: "eth_getLogs per block",
    block_receipts: "eth_getBlockReceipts",
    transaction_receipts: "transaction receipts",
    mixed_receipts: "mixed receipts",
  }
  const streamLabel = streamStatus === "connected" ? t.streamConnected : streamStatus === "offline" ? t.streamOffline : t.streamConnecting
  const backlogBlockCount = Number(monitor.data?.backlogBlockCount || 0)
  const monitorOperational = ["live", "catching_up"].includes(monitor.data?.mode) && streamStatus === "connected"
  const monitorStateLabel = backlogBlockCount > 0 ? `${t.catchingUp} · ${formatInteger(backlogBlockCount)} blocks` : t.liveStatus

  useEffect(() => {
    liveFeedPauseReasons.current = { hover: false, focus: false }
    setPausedLiveEvents(null)
  }, [chain?.id])

  function setLiveFeedPause(reason, paused) {
    liveFeedPauseReasons.current[reason] = paused
    if (paused) {
      setPausedLiveEvents((current) => current || liveFeedSnapshot(liveEvents, chain?.id))
      return
    }
    if (!liveFeedPauseReasons.current.hover && !liveFeedPauseReasons.current.focus) setPausedLiveEvents(null)
  }

  return (
    <div className="sectionStack mintWorkspace">
      <div className="sectionHeader mintWorkspaceHeader">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <div className="actions">
          <span className={`monitorSource ${monitor.data?.mode || "starting"}`}>
            <RadioTower size={14} />
            {monitor.data?.source === "provider" ? t.sourceProvider : t.sourceRpc}
          </span>
          <button className="languageToggle" type="button" onClick={() => setLanguage(language === "en" ? "zh" : "en")} aria-label="Switch language">
            <Globe2 size={14} /> {language === "en" ? "中文" : "EN"}
          </button>
        </div>
      </div>

      <div className="mintMonitorToolbar">
        <div className="mintMonitorSearch">
          <Search size={15} />
          <input value={monitorQuery} onChange={(event) => setMonitorQuery(event.target.value)} placeholder={t.search} />
        </div>
        <div className="mintSegmented" aria-label="Mint filters">
          {["all", "mintable", "airdrop"].map((filter) => (
            <button key={filter} type="button" className={monitorFilter === filter ? "active" : ""} onClick={() => setMonitorFilter(filter)}>{t[filter]}</button>
          ))}
        </div>
        <div className="mintTimeFilters" aria-label="Time window">
          {[[60, "1m"], [180, "3m"], [300, "5m"], [600, "10m"], [1800, "30m"], [3600, "1h"], [21600, "6h"], [86400, "24h"]].map(([seconds, label]) => (
            <button key={seconds} type="button" className={monitorWindow === seconds ? "active" : ""} onClick={() => setMonitorWindow(seconds)}>{label}</button>
          ))}
        </div>
      </div>

      {monitor.error ? <div className="inlineAlert" role="alert">{monitor.error}</div> : null}
      {monitor.data?.providerError ? (
        <div className="monitorNotice"><RadioTower size={15} /><span>{language === "zh" ? "第三方监控源不可用，当前使用所选链 RPC 的真实 NFT Mint 日志。" : "The provider feed is unavailable. Live data is coming from real NFT mint logs on the selected chain RPC."}</span></div>
      ) : null}
      {monitor.data?.source === "direct_rpc" ? (
        <div className="monitorDiagnostics" aria-label={language === "zh" ? "实时监控诊断" : "Live monitor diagnostics"}>
          <span className={`streamState ${streamStatus}`}><RadioTower size={13} />{streamLabel}</span>
          <span><strong>{t.scanStrategy}</strong>{strategyLabels[monitor.data?.scanStrategy] || t.unavailable}</span>
          <span><strong>{t.coverage}</strong>{monitor.data?.coverageFromBlock && monitor.data?.latestBlock ? `${formatInteger(monitor.data.coverageFromBlock)} - ${formatInteger(monitor.data.latestBlock)}` : t.unavailable}</span>
          <span><strong>{language === "zh" ? "监控更新" : "Monitor update"}</strong>{monitor.data?.updatedAt ? formatRelativeTime(new Date(monitor.data.updatedAt).getTime() / 1000, language) : t.unavailable}</span>
          <span><strong>{t.syncStatus}</strong>{backlogBlockCount > 0 ? `${t.catchingUp} · ${formatInteger(backlogBlockCount)} blocks` : t.synced}</span>
        </div>
      ) : null}
      {monitor.data?.source === "direct_rpc" && monitor.data?.coverageLimited ? (
        <div className="coverageNotice"><ShieldAlert size={14} /><span>{t.limitedHistory}</span></div>
      ) : null}

      <div className="mintMonitorGrid">
        <section className="mintMonitorPanel collectionPanel" aria-label={t.monitor}>
          <div className="mintPanelHeader">
            <div><strong>{t.monitor}</strong><span>{collectionRows.length} {language === "zh" ? "个活跃合集" : "active collections"}</span></div>
            {monitor.loading ? <RefreshCcw className="spin" size={15} /> : <span className={`liveStatus ${monitor.data?.mode || "starting"}`}>{monitor.data?.mode === "catching_up" ? monitorStateLabel : monitor.data?.mode === "live" ? t.liveStatus : t.degraded}</span>}
          </div>
          <div className="mintCollectionList">
            {collectionRows.map((item, index) => {
              const selected = collection?.address?.toLowerCase() === item.address.toLowerCase()
              return (
                <div key={`${item.chainId}-${item.address}`} className={selected ? "mintCollectionRow active" : "mintCollectionRow"}>
                  <button type="button" className="mintCollectionSelect" onClick={() => onSelectCollection(item)} aria-label={`${language === "zh" ? "查看" : "Inspect"} ${item.name || item.address}`}>
                    <span className="collectionRank">{index + 1}</span>
                    <NftImage
                      src={item.image_url}
                      alt={item.name ? `${item.name} preview` : "NFT collection preview"}
                      className="collectionThumb"
                      fallbackSeed={item.address}
                      fallbackLabel={item.symbol || item.name}
                      fallbackTitle={t.noNftMedia}
                    />
                    <span className="collectionCopy">
                      <strong>{item.name || shortAddress(item.address)}</strong>
                      <code>{shortAddress(item.address)}</code>
                      <small><b>{formatInteger(item.recent_mints)} Mint</b>{item.is_airdrop ? ` / ${t.airdrop}` : ""}</small>
                    </span>
                  </button>
                  <span className="collectionNumbers">
                    <strong>{item.current_supply == null ? "?" : formatInteger(item.current_supply)} / {item.max_supply == null ? "?" : formatInteger(item.max_supply)}</strong>
                    <small>{language === "zh" ? "已 Mint / 总量" : "minted / total"}</small>
                    <em>{item.mint_price || t.unavailable}</em>
                  </span>
                  <a className="collectionContractLink" href={explorerContract(item.address, item.chainId || chain?.id)} target="_blank" rel="noreferrer" aria-label={`${t.viewContract}: ${item.name || item.address}`} title={t.viewContract}>
                    <ExternalLink size={14} />
                  </a>
                </div>
              )
            })}
            {!collectionRows.length ? <div className="mintMonitorEmpty">{monitorQuery ? t.noMatch : t.waiting}</div> : null}
          </div>
        </section>

        <section className="mintMonitorPanel detailPanel" aria-label={t.collectionDetails}>
          {collection ? (
            <>
              <div className="collectionDetailHeader">
                <NftImage src={collection.image_url} alt={collection.name ? `${collection.name} preview` : "NFT collection preview"} className="detailCollectionImage" fallbackSeed={collection.address} fallbackLabel={collection.symbol || collection.name} fallbackTitle={t.noNftMedia} />
                <div className="collectionDetailCopy">
                  <span>{collection.token_standard || "NFT"}</span>
                  <h2>{collection.name || shortAddress(collection.address)}</h2>
                </div>
                <code className="collectionContractAddress" dir="ltr" title={collection.address}>{collection.address}</code>
                <div className="collectionDetailActions">
                  <a className="btn" href={explorerContract(collection.address, chain?.id)} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span>{t.viewContract}</span></a>
                  <Button icon={ImagePlus} tone="primary" onClick={() => onUseCollection(collection)} disabled={inputsLocked}>{t.useContract}</Button>
                </div>
              </div>
              <div className="collectionStats">
                <div><span>{t.supply}</span><strong>{collection.current_supply == null ? t.unavailable : formatInteger(collection.current_supply)}</strong></div>
                <div><span>{t.maxSupply}</span><strong>{collection.max_supply == null ? t.unavailable : formatInteger(collection.max_supply)}</strong></div>
                <div>
                  <span>{t.uniqueMinters}</span>
                  <strong>{formatInteger(collection.unique_minters)}</strong>
                  {collection.unique_minters_status === "loading" || collection.unique_minters_status === "pending" ? (
                    <small className="minterBackfillState loading"><RefreshCcw className="spin" size={10} />{t.uniqueMintersLoading}</small>
                  ) : collection.unique_minters_status === "error" ? (
                    <small className="minterBackfillState error" title={collection.unique_minters_error}>{t.uniqueMintersError}</small>
                  ) : null}
                </div>
                <div><span>{t.mintPrice}</span><strong>{collection.mint_price || t.unavailable}</strong></div>
                <div><span>{t.floor}</span><strong>{collection.floor_price_eth == null ? t.unavailable : `${collection.floor_price_eth} ${chain?.nativeSymbol}`}</strong></div>
                <div><span>{t.walletLimit}</span><strong title={collection.max_per_wallet == null ? t.walletLimitUnknownHint : t.walletLimitHint}>{collection.max_per_wallet == null ? t.walletLimitUnknown : formatInteger(collection.max_per_wallet)}</strong></div>
              </div>
              <div className="collectionDetailTitle">
                <strong>{t.recentMints}</strong>
                <span className="collectionDetailState">{collectionBusy ? <RefreshCcw className="spin" size={12} /> : null}{collectionBusy ? (collectionSlow ? t.slowRecent : t.loadingRecent) : collection.source === "provider" ? t.sourceProvider : t.sourceRpc}</span>
              </div>
              <div className="recentMintList">
                {(collection.recent_mints || []).slice(0, 30).map((mint) => (
                  <div className="recentMintRow" key={`${mint.tx_hash}-${mint.token_id}`}>
                    <a className="recentMintTx" href={explorerTx(mint.tx_hash, chain?.id)} target="_blank" rel="noreferrer" aria-label={`${mint.token_name || `#${mint.token_id ?? "?"}`} transaction`}>
                      <NftImage src={mint.image_url || collection.image_url} alt={mint.token_name || `${collection.name || "NFT"} #${mint.token_id ?? "?"}`} className="recentMintImage" fallbackSeed={`${collection.address}${mint.token_id || ""}`} fallbackLabel={collection.symbol || collection.name} fallbackTitle={t.noNftMedia} />
                      <span><strong>{mint.token_name || `#${mint.token_id ?? "?"}`}</strong><code>{shortAddress(mint.to_address)}</code></span>
                      <span className="recentMintMeta">
                        <span className="recentMintPrice">{mint.mint_price || ""}</span>
                        <small>{formatRelativeTime(mint.timestamp, language)}</small>
                        <em className="recentMintGas" title={mint.gas_fee_wei ? `${mint.gas_used || "?"} gas · ${mint.gas_fee_wei} wei` : undefined}>
                          {mint.gas_fee_native ? `${t.gasFee} ${formatNativeFee(mint.gas_fee_native)} ${chain?.nativeSymbol || "ETH"}` : t.gasPending}
                        </em>
                      </span>
                    </a>
                    <button className="reuseMintButton" type="button" onClick={() => onUseRecentMint(collection, mint)} title={t.reuseMint} disabled={inputsLocked}><Zap size={13} /><span>{t.reuseMint}</span></button>
                  </div>
                ))}
                {collectionError ? (
                  <div className="mintMonitorEmpty collectionDetailError" role="alert">
                    <ShieldAlert size={18} />
                    <span>{t.detailLoadFailed} {collectionError}</span>
                    <button className="btn" type="button" onClick={() => onSelectCollection(collection)}><RefreshCcw size={14} /><span>{t.retry}</span></button>
                  </div>
                ) : null}
                {collectionBusy && !collection.recent_mints?.length ? <div className="mintMonitorEmpty"><RefreshCcw className="spin" size={18} />{collectionSlow ? t.slowRecent : t.loadingRecent}</div> : null}
                {!collectionBusy && !collectionError && !collection.recent_mints?.length ? <div className="mintMonitorEmpty">{t.noRecent}</div> : null}
              </div>
            </>
          ) : <div className="mintMonitorEmpty"><ImagePlus size={20} />{t.selectCollection}</div>}
        </section>

        <section
          className="mintMonitorPanel livePanel"
          aria-label={t.live}
          onPointerEnter={() => setLiveFeedPause("hover", true)}
          onPointerLeave={() => setLiveFeedPause("hover", false)}
          onFocusCapture={() => setLiveFeedPause("focus", true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setLiveFeedPause("focus", false)
          }}
        >
          <div className="mintPanelHeader"><div><strong>{t.live}</strong><span>{chain?.name}</span></div><div className="livePanelState">{liveFeedPaused ? <span className="livePauseBadge" role="status">{t.livePaused}</span> : null}<span className={`liveStatus ${monitorOperational ? monitor.data?.mode : "degraded"}`}>{monitorOperational ? monitorStateLabel : t.degraded}</span></div></div>
          <div
            className={liveFeedPaused ? "liveMintFeed paused" : "liveMintFeed"}
            role="log"
            aria-live={liveFeedPaused ? "off" : "polite"}
          >
            {visibleEvents.map((event) => (
              <a className="liveMintItem" key={event.id} href={explorerTx(event.txHash, event.chainId)} target="_blank" rel="noreferrer" title={t.viewTransaction} aria-label={`${event.tokenName || event.name || shortAddress(event.address)} · ${t.viewTransaction}`}>
                <span className="liveMintCopy"><strong>{event.tokenName || event.name || shortAddress(event.address)}</strong><small>{event.quantity} Mint / {event.mintPrice}</small><code>{event.tokenIds?.[0] ? `#${event.tokenIds[0]} / ` : ""}{shortAddress(event.recipient)}</code></span>
                <span className="liveMintCost"><time>{formatRelativeTime(event.timestamp, language)}</time><span className="liveMintHoverHint" aria-hidden="true"><ExternalLink size={11} />{t.viewTransaction}</span></span>
              </a>
            ))}
            {!visibleEvents.length ? <div className="mintMonitorEmpty">{t.waiting}</div> : null}
          </div>
        </section>
      </div>

      <div className="sectionHeader mintExecutionHeader" id="mint-setup">
        <div><h2>{t.execute}</h2><p>{`${selectedIds.length} selected wallet${selectedIds.length === 1 ? "" : "s"} on ${chain?.name || "the selected chain"}. Preview is optional; Mint always runs a fresh automatic preflight.`}</p></div>
        <div className="mintSetupActions">
          <Button icon={ListChecks} onClick={onPreview} busy={busy} disabled={!selectedIds.length || job?.status === "sending"}>Preview</Button>
          <Button icon={Zap} tone="danger" onClick={onMint} busy={busy} disabled={!selectedIds.length || !form.contractAddress || job?.status === "sending"}>Mint</Button>
        </div>
      </div>
      <GroupQuickSelect wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} label="Quick select groups" disabled={inputsLocked} />
      <div className="operationForm mintExecutionForm">
      {inputsLocked ? <div className="setupAppliedNotice mintInputLock" role="status"><RefreshCcw className="spin" size={14} />Mint 正在发送；钱包、链和交易参数已锁定，任务状态会持续更新。</div> : null}
      <div className="mintIntro">
        <ShieldAlert size={18} />
        <div>
          <strong>Mint runs an automatic preflight</strong>
          <p>Preview is optional. Mint regenerates and verifies chain, bytecode, calldata, gas, balance and your value cap, then asks for confirmation before broadcasting.</p>
        </div>
      </div>

      {setupNotice ? <div className="setupAppliedNotice" role="status"><Check size={14} />{setupNotice}</div> : null}

      <div className="mintFormGrid">
        <Field label="NFT contract" hint="Collection contract on the chain selected in the top bar.">
          <input value={form.contractAddress} onChange={(event) => setForm("contractAddress", event.target.value)} placeholder="0x..." autoComplete="off" spellCheck="false" disabled={inputsLocked} />
        </Field>
        <div className="formGrid three">
          <Field label="Quantity per wallet">
            <input type="number" min="1" max="1000" value={form.quantity} onChange={(event) => setForm("quantity", event.target.value)} inputMode="numeric" disabled={inputsLocked} />
          </Field>
          <Field label="Token ID" hint="Use 0 for standard collection mints.">
            <input type="number" min="0" value={form.tokenId} onChange={(event) => setForm("tokenId", event.target.value)} inputMode="numeric" disabled={inputsLocked} />
          </Field>
          <Field label="Concurrency" hint="0 uses all wallets, capped at 32.">
            <input type="number" min="0" max="32" value={form.concurrency} onChange={(event) => setForm("concurrency", event.target.value)} inputMode="numeric" disabled={inputsLocked} />
          </Field>
        </div>
        <Field label={`Max mint value per wallet (${chain?.nativeSymbol || "native"})`} hint="Optional hard cap for mint value. Estimated gas is checked separately.">
          <input value={form.maxMintCostEth} onChange={(event) => setForm("maxMintCostEth", event.target.value)} placeholder="Optional, for example 0.05" inputMode="decimal" disabled={inputsLocked} />
        </Field>
      </div>

      <div className="mintWalletStrip" aria-label="Selected mint wallets">
        <div>
          <strong>Selected wallets</strong>
          <span>{selectedWallets.length ? `${selectedWallets.length} local AWP profiles` : "Choose wallets from the dashboard selection"}</span>
        </div>
        <div className="mintWalletChips">
          {selectedWallets.slice(0, 8).map((wallet) => (
            <span key={wallet.id}><strong>{wallet.id}</strong><code>{shortAddress(wallet.address)}</code></span>
          ))}
          {selectedWallets.length > 8 ? <span className="moreWallets">+{selectedWallets.length - 8} more</span> : null}
        </div>
      </div>

      {error ? <div className="inlineAlert" role="alert">{error}</div> : null}

      {job ? (
        <div className="mintPreview" aria-live="polite">
          <div className="mintPreviewHeader">
            <div>
              <h2>Wallet Preflight</h2>
              <p>{job.chainName} contract {shortAddress(job.contractAddress)}. Preview expires {new Date(job.expiresAt).toLocaleTimeString()}.</p>
            </div>
            <span className={`pill ${job.status}`}>{job.status}</span>
          </div>

          <div className="mintSummary">
            <div><span>Eligible</span><strong>{job.summary.eligible ?? job.summary.ready}</strong></div>
            <div><span>Skipped</span><strong>{job.summary.skipped}</strong></div>
            <div><span>Failed</span><strong>{job.summary.failed}</strong></div>
            <div><span>Mint value</span><strong>{formatEthCompact(readyTotal)} {job.nativeSymbol}</strong></div>
          </div>

          <div className="tableWrap mintPlanTable">
            <table>
              <thead>
                <tr><th>Status</th><th>Wallet</th><th>Mint value</th><th>Gas estimate</th><th>Total needed</th><th>Target / Result</th></tr>
              </thead>
              <tbody>
                {job.wallets.map((wallet) => (
                  <tr key={wallet.walletId}>
                    <td><span className={`pill ${wallet.status}`}>{wallet.status}</span></td>
                    <td><strong>{wallet.walletId}</strong><code className="subCell">{shortAddress(wallet.address)}</code></td>
                    <td>{wallet.transaction ? `${formatEthCompact(wallet.transaction.valueEth)} ${job.nativeSymbol}` : <span className="muted">not available</span>}</td>
                    <td>{wallet.estimatedGas || <span className="muted">not available</span>}</td>
                    <td>{wallet.estimatedTotalEth ? `${formatEthCompact(wallet.estimatedTotalEth)} ${job.nativeSymbol}` : <span className="muted">not available</span>}</td>
                    <td>
                      {wallet.txHash ? (
                        <a href={explorerTx(wallet.txHash, job.chainId)} target="_blank" rel="noreferrer"><code>{shortAddress(wallet.txHash)}</code></a>
                      ) : wallet.transaction ? (
                        <><code>{shortAddress(wallet.transaction.to)}</code><span className="subCell">{wallet.transaction.actionType}</span></>
                      ) : null}
                      {wallet.reason ? <span className={`mintReason ${wallet.status}`}>{wallet.reason}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {job.status === "previewed" ? <div className="mintPreviewOnly"><ListChecks size={15} /><span>This is a read-only preview. Use the Mint button above to run a fresh preflight and broadcast after confirmation.</span></div> : null}

          {job.status === "sending" ? <div className="mintProgress"><RefreshCcw className="spin" size={16} />Signing, broadcasting and confirming wallet transactions...</div> : null}
          {terminal ? <div className={`mintProgress ${job.status}`}>{job.status === "completed" ? <Check size={16} /> : <ShieldAlert size={16} />}Mint batch {job.status}. Review every wallet result above.</div> : null}
        </div>
      ) : (
        <div className="emptyState mintEmpty"><ImagePlus size={20} />Enter or reuse mint parameters. Preview inspects only; Mint performs a fresh preflight before confirmation.</div>
      )}
      </div>
    </div>
  )
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "none"
}

function formatInteger(value) {
  if (value === null || value === undefined || value === "") return "0"
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return new Intl.NumberFormat().format(number)
}

function formatEthCompact(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) return String(value || "0")
  if (number === 0) return "0"
  if (number < 0.000001) return number.toExponential(2)
  return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
}

function formatNativeFee(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) return String(value || "0")
  if (number === 0) return "0"
  if (number < 0.000000001) return number.toExponential(4)
  return number.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")
}

function formatGwei(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) return String(value || "")
  if (number === 0) return "0"
  return number < 0.001 ? number.toExponential(2) : number.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

function statusTone(status) {
  if (["minted", "already-minted", "success", "done", "confirmed"].includes(status)) return "success"
  if (["failed", "needs-inspection", "error"].includes(status)) return "failed"
  if (["pending", "running", "dry-run-ready"].includes(status)) return "pending"
  return ""
}

function ScriptControlView({ status, results, rpcTest, error, busy, armConfirm, setArmConfirm, onRefresh, onRefreshResults, onStart, onStop, onTestRpc }) {
  const config = status?.config || {}
  const logs = status?.logs || []
  const mintRows = results?.rows || []
  const mintSummary = results?.summary || {}
  const running = Boolean(status?.running)
  const state = running ? "running" : status?.exitCode === 0 ? "done" : status?.exitCode === null || status?.exitCode === undefined ? "idle" : "failed"

  return (
    <div className="sectionStack">
      <div className="sectionHeader">
        <div>
          <h1>Script Control</h1>
          <p>ASCII Cats runner and Robinhood RPC</p>
        </div>
        <div className="actions">
          <Button icon={RefreshCcw} onClick={() => Promise.all([onRefresh(), onRefreshResults()]).catch(() => {})} busy={busy}>Refresh</Button>
          <Button icon={RadioTower} onClick={onTestRpc} busy={busy}>RPC Test</Button>
        </div>
      </div>

      {error ? <div className="inlineAlert" role="alert">{error}</div> : null}

      <div className="runnerMetrics">
        <div className="runnerMetric">
          <span className={`statusDot ${state}`}></span>
          <div>
            <small>Status</small>
            <strong>{running ? "Running" : state === "done" ? "Ready" : state === "failed" ? "Failed" : "Idle"}</strong>
          </div>
        </div>
        <div className="runnerMetric">
          <Terminal size={17} />
          <div>
            <small>Mode</small>
            <strong>{status?.mode || "none"}</strong>
          </div>
        </div>
        <div className="runnerMetric">
          <Wallet size={17} />
          <div>
            <small>Wallets</small>
            <strong>{config.walletCount || 0}</strong>
          </div>
        </div>
        <div className="runnerMetric">
          <Server size={17} />
          <div>
            <small>RPC p50</small>
            <strong>{rpcTest?.p50Ms ? `${rpcTest.p50Ms}ms` : "untested"}</strong>
          </div>
        </div>
      </div>

      <div className="scriptGrid">
        <div className="operationForm">
          <h2>Runner</h2>
          <div className="runnerState">
            <div><span>PID</span><strong>{status?.pid || "none"}</strong></div>
            <div><span>Started</span><strong>{formatDateTime(status?.startedAt)}</strong></div>
            <div><span>Exited</span><strong>{formatDateTime(status?.exitedAt)}</strong></div>
            <div><span>Exit</span><strong>{status?.exitCode ?? status?.signal ?? "none"}</strong></div>
          </div>
          <div className="formGrid two">
            <Button icon={Play} tone="primary" onClick={() => onStart("dry-run")} busy={busy} disabled={running}>Dry Run</Button>
            <Button icon={Square} tone="danger" onClick={onStop} busy={busy} disabled={!running}>Stop</Button>
          </div>
          <div className="formGrid two">
            <Field label="ARM confirmation">
              <input value={armConfirm} onChange={(event) => setArmConfirm(event.target.value)} placeholder="ARM" />
            </Field>
            <Button icon={Zap} tone="danger" onClick={() => onStart("armed")} busy={busy} disabled={running || armConfirm !== "ARM"}>Start ARM</Button>
          </div>
        </div>

        <div className="operationForm">
          <h2>Config</h2>
          <div className="configList">
            <span>Wallet source</span><strong>{config.walletSource || "unknown"}</strong>
            <span>Main proxies</span><strong>{config.proxyFileLines ?? 0}/{config.staticProxyCount ?? 0}</strong>
            <span>Reserve proxies</span><strong>{config.proxyReserveLines ?? 0}</strong>
            <span>Dynamic proxies</span><strong>{config.dynamicProxyCount ?? 0}</strong>
            <span>Proxy timeout</span><strong>{config.proxyCheckTimeoutMs || 0}ms</strong>
            <span>Replacements</span><strong>{config.proxyMaxReplacements || 0}</strong>
            <span>Concurrency</span><strong>{config.mintConcurrency || 0}</strong>
            <span>RPC host</span><strong>{config.rpcHost || "unknown"}</strong>
          </div>
        </div>
      </div>

      <div className="operationForm">
        <div className="formTitleRow">
          <h2>Mint Transactions</h2>
          <small>{results?.updatedAt ? `updated ${new Date(results.updatedAt).toLocaleTimeString()}` : "waiting for runner results"}</small>
        </div>
        <div className="runnerState mintSummaryGrid">
          <div><span>Rows</span><strong>{mintSummary.totalRows ?? 0}</strong></div>
          <div><span>Minted</span><strong>{mintSummary.minted ?? 0}</strong></div>
          <div><span>Failed / Inspect</span><strong>{mintSummary.failedOrInspection ?? 0}</strong></div>
          <div><span>Total Gas Fee</span><strong>{formatEthCompact(mintSummary.totalFeeEth)} ETH</strong></div>
          <div><span>Already Minted</span><strong>{mintSummary.alreadyMinted ?? 0}</strong></div>
          <div><span>Dry-run Ready</span><strong>{mintSummary.dryRunReady ?? 0}</strong></div>
          <div><span>Receipt OK</span><strong>{mintSummary.receiptSuccess ?? 0}</strong></div>
          <div><span>Gas Rows</span><strong>{mintSummary.gasRows ?? 0}</strong></div>
        </div>
        {mintRows.length ? (
          <div className="tableWrap mintResultsTable">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Wallet</th>
                  <th>Status</th>
                  <th>Tx</th>
                  <th>Receipt</th>
                  <th>Gas Used</th>
                  <th>Fee</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {mintRows.map((row) => {
                  const receiptStatus = row.receipt?.status || (row.txHash ? "pending" : "")
                  const txHref = row.txHash && results?.explorer ? `${results.explorer}/tx/${row.txHash}` : ""
                  return (
                    <tr key={`${row.index}-${row.address}`}>
                      <td>{row.index}</td>
                      <td><code>{shortAddress(row.address)}</code></td>
                      <td><span className={`pill ${statusTone(row.status)}`}>{row.status}</span></td>
                      <td>
                        {row.txHash ? (
                          <a href={txHref || "#"} target="_blank" rel="noreferrer">
                            <code>{shortAddress(row.txHash)}</code>
                          </a>
                        ) : <span className="muted">none</span>}
                      </td>
                      <td>
                        {receiptStatus ? <span className={`pill ${statusTone(receiptStatus)}`}>{receiptStatus}</span> : <span className="muted">n/a</span>}
                        {row.receipt?.blockNumber ? <small className="subCell">#{row.receipt.blockNumber}</small> : null}
                      </td>
                      <td>{row.receipt?.gasUsed ? formatInteger(row.receipt.gasUsed) : <span className="muted">n/a</span>}</td>
                      <td>
                        {row.receipt?.feeEth ? (
                          <>
                            <span>{formatEthCompact(row.receipt.feeEth)} ETH</span>
                            <small className="subCell">{formatGwei(row.receipt.effectiveGasPriceGwei)} gwei</small>
                          </>
                        ) : <span className="muted">n/a</span>}
                      </td>
                      <td>{row.error || row.receipt?.error || <span className="muted">none</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState"><Activity size={18} />No mint transaction rows yet</div>
        )}
      </div>

      <div className="scriptGrid">
        <div className="operationForm">
          <h2>RPC Latency</h2>
          {rpcTest ? (
            <>
              <div className="runnerState">
                <div><span>Success</span><strong>{rpcTest.successCount}/{rpcTest.samples}</strong></div>
                <div><span>Min</span><strong>{rpcTest.minMs ?? "n/a"}ms</strong></div>
                <div><span>p90</span><strong>{rpcTest.p90Ms ?? "n/a"}ms</strong></div>
                <div><span>Block</span><strong>{rpcTest.latestBlock || "n/a"}</strong></div>
              </div>
              <div className="latencyRows">
                {rpcTest.results.map((item, index) => (
                  <span key={`${item.ms}-${index}`} className={item.ok ? "ok" : "bad"}>
                    {index + 1}: {item.ok ? `${item.ms}ms` : item.error}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="emptyState"><RadioTower size={18} />No RPC sample</div>
          )}
        </div>

        <div className="operationForm">
          <h2>Command</h2>
          <div className="commandBox">
            <code>{status?.command || "none"}</code>
          </div>
        </div>
      </div>

      <div className="operationForm">
        <h2>Logs</h2>
        {logs.length ? (
          <div className="logBox" role="log" aria-live="polite">
            {logs.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className={entry.stream}>
                <span>{new Date(entry.at).toLocaleTimeString()}</span>
                <strong>{entry.stream}</strong>
                <code>{entry.line}</code>
              </div>
            ))}
          </div>
        ) : (
          <div className="emptyState"><Terminal size={18} />No runner logs</div>
        )}
      </div>
    </div>
  )
}

function OperationPanel({ title, subtitle, actions, children }) {
  return (
    <div className="sectionStack">
      <div className="sectionHeader">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="actions">{actions}</div>
      </div>
      <div className="operationForm">{children}</div>
    </div>
  )
}

function TransactionsView({ transactions, explorerTx }) {
  return (
    <div className="sectionStack">
      <div className="sectionHeader">
        <div>
          <h1>Transactions</h1>
          <p>{transactions.length} recent entries</p>
        </div>
      </div>
      <div className="tableWrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Wallet</th><th>Type</th><th>Hash</th><th>Summary</th><th>Time</th></tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td><span className={`pill ${tx.status}`}>{tx.status}</span></td>
                <td>{tx.walletId}</td>
                <td>{tx.type}</td>
                <td>{tx.txHash ? <a href={explorerTx(tx.txHash, tx.chainId)} target="_blank" rel="noreferrer"><code>{shortAddress(tx.txHash)}</code></a> : <span className="muted">none</span>}</td>
                <td>{tx.summary || tx.error}</td>
                <td>{new Date(tx.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
