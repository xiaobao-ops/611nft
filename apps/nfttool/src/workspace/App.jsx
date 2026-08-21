import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  BadgeCheck,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Coins,
  ExternalLink,
  FileJson,
  Gauge,
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
  ScanSearch,
  Send,
  Server,
  ShieldAlert,
  Star,
  Square,
  Tags,
  Terminal,
  Trash2,
  Upload,
  Wallet,
  Wifi,
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
import { applyCollectionUpdate, mergeSnapshotIntoRow } from "./collection-snapshot.js"
import { confirmedTaskPrompt, confirmedTaskRequest, redactSensitiveResult } from "./confirmed-task.js"
import { documentLanguage, readMonitorLanguage, saveMonitorLanguage } from "./language.js"
import { liveFeedSnapshot, visibleLiveFeedEvents } from "./live-feed.js"
import { preloadLiveMintImages } from "./live-mint-images.js"
import { canChangeMintInputs, isMintJobSending } from "./mint-job-state.js"
import { mintSetupFromCollection, mintSetupFromRecentMint } from "./mint-setup.js"
import {
  mergeTrendingSnapshots,
  readAlertPreferences,
  rememberAlertId,
  writeAlertPreferences,
} from "./monitor-intelligence.js"
import { createRealtimeFeedState, reduceRealtimeFeed, replaceRealtimeOverview } from "./realtime-feed.js"
import { formatRelativeTime } from "./relative-time.js"
import { mintScriptStartPayload } from "./script-start.js"
import { uiError, uiStatus, uiTransactionType, uiWalletSource } from "./ui-text.js"
import FollowMintView from "./FollowMintView.jsx"
import SignatureLabView from "./SignatureLabView.jsx"
import LiveMintView from "./LiveMintView.jsx"
import AdvancedMintView from "./AdvancedMintView.jsx"
import WalletTableSelector, { WalletGroupQuickSelect } from "./WalletTableSelector.jsx"
import {
  groupWallets,
  normalizeWalletGroup,
  readStoredWalletIds,
  reconcileWalletIds,
  writeStoredWalletIds,
} from "./wallet-selection.js"
import logoUrl from "../../../web/assets/611nft-logo-ui.png"

const baseTabs = [
  { id: "wallets", label: "钱包", description: "钱包资料、标签与执行分组", icon: Wallet },
  { id: "balances", label: "余额", description: "查看各钱包的链币与代币余额", icon: Gauge },
  { id: "one", label: "一对多分发", description: "从一个钱包向多个目标分发余额", icon: Send },
  { id: "many", label: "多对一归集", description: "将多个钱包的可用余额归集到一个钱包", icon: ArrowDownToLine },
  { id: "multi", label: "多对多转账", description: "按固定顺序配对发送与接收钱包", icon: ArrowRightLeft },
  { id: "approval", label: "授权", description: "预览并执行 ERC-20 授权限额变更", icon: ShieldAlert },
  { id: "contract", label: "合约调用", description: "使用所选钱包预览并执行 calldata", icon: FileJson },
  { id: "mint", label: "NFT 铸造", description: "监控合集并准备钱包预览", icon: ImagePlus },
  { id: "follow", label: "跟单铸造", description: "监听真实铸造并按规则生成钱包预览", icon: Bot },
  { id: "sign", label: "项目破签", description: "检查铸造 calldata、签名与钱包预检", icon: ScanSearch },
  { id: "script", label: "脚本", description: "控制隔离的铸造运行器", icon: Terminal },
  { id: "tx", label: "交易记录", description: "查看本地执行与回执日志", icon: Activity },
]

function requestedModule() {
  if (typeof window === "undefined") return "all"
  const requested = new URLSearchParams(window.location.search).get("module")
  if (["wallets", "balances", "one", "many", "multi", "monitor", "alerts", "follow", "sign", "approval", "contract", "script", "tx", "opensea"].includes(requested)) return requested
  return window.location.pathname.startsWith("/opensea") ? "opensea" : "all"
}

const tabById = (id) => baseTabs.find((item) => item.id === id)
const moduleTabs = {
  wallets: [tabById("wallets")],
  balances: [tabById("balances")],
  one: [tabById("one")],
  many: [tabById("many")],
  multi: [tabById("multi")],
  monitor: [{ ...tabById("mint"), label: "NFT 盯盘", description: "实时链上 NFT 铸造活动" }],
  alerts: [{ ...tabById("mint"), label: "电报监控", description: "本地报警规则、桌面通知与 Telegram 状态" }],
  follow: [tabById("follow")],
  sign: [tabById("sign")],
  approval: [tabById("approval")],
  contract: [tabById("contract")],
  script: [tabById("script")],
  tx: [tabById("tx")],
  opensea: [{ ...tabById("mint"), label: "OpenSea 铸造", description: "OpenSea 报价、钱包预检与广播" }],
}
const sidebarStorageKey = "evm-board-sidebar-collapsed"
const UNGROUPED_GROUP_FILTER = "__nfttool_ungrouped__"

const mintCopy = {
    title: "NFT 铸造实时监控",
    subtitle: "发现实时铸造、审查合集，并在签名前逐钱包预览。",
    monitor: "铸造监控",
    execute: "铸造设置",
    live: "实时活动",
    search: "搜索名称或合约",
    all: "全部",
    mintable: "可铸造",
    airdrop: "空投",
    waiting: "正在等待链上铸造活动",
    noMatch: "没有符合筛选条件的合集",
    selectCollection: "选择合集以查看供应量、价格与最近铸造记录。",
    recentMints: "最近铸造",
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
    useContract: "套用到铸造设置",
    reuseMint: "套用参数",
    viewContract: "查看合约",
    supply: "已铸造供应量",
    maxSupply: "最大供应量",
    uniqueMinters: "独立铸造钱包",
    uniqueMintersLoading: "正在回填全历史",
    uniqueMintersError: "历史回填暂时延迟",
    mintPrice: "铸造价格",
    floor: "地板价",
    walletLimit: "单钱包累计上限",
    walletLimitHint: "当前铸造阶段中每个钱包的累计上限，并非单笔交易数量上限。",
    walletLimitUnknown: "未公开",
    walletLimitUnknownHint: "当前铸造路由未检测到公开可读的链上钱包限额。",
    unavailable: "不可用",
    noRecent: "所选时间窗口内暂无事件",
    loadingRecent: "正在加载最近铸造记录…",
    slowRecent: "最近铸造记录仍在加载，链上 RPC 可能繁忙…",
    detailLoadFailed: "最近铸造记录加载失败。",
    retry: "重试",
    gasFee: "Gas 消耗",
    gasPending: "Gas 待确认",
    livePaused: "悬停已暂停",
    viewTransaction: "查看交易",
    noNftMedia: "合约未发布 NFT 图片，当前显示合约识别图",
}

const emptyOp = {
  loading: false,
  result: null,
  error: "",
}

function readInitialTab(moduleMode, tabs) {
  const defaultTabId = tabs[0]?.id || "wallets"
  if (typeof window === "undefined") return defaultTabId
  try {
    const tabStorageKey = `evm-board-active-tab:${moduleMode}`
    const tabIds = new Set(tabs.map((item) => item.id))
    const saved = window.localStorage.getItem(tabStorageKey)
    return tabIds.has(saved) ? saved : defaultTabId
  } catch {
    return defaultTabId
  }
}

function saveActiveTab(moduleMode, tabId) {
  try {
    window.localStorage.setItem(`evm-board-active-tab:${moduleMode}`, tabId)
  } catch {
    // localStorage can be unavailable in strict privacy modes.
  }
}

function initialMintForm(moduleMode) {
  const initial = { contractAddress: "", quantity: "1", tokenId: "0", concurrency: "5", maxMintCostEth: "" }
  if (typeof window === "undefined" || moduleMode !== "opensea") return initial
  const query = new URLSearchParams(window.location.search)
  const contractAddress = query.get("contractAddress") || ""
  const quantity = query.get("quantity") || ""
  if (/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) initial.contractAddress = contractAddress
  if (/^\d+$/.test(quantity) && Number(quantity) > 0) initial.quantity = quantity
  return initial
}

function initialSignatureTxHash() {
  if (typeof window === "undefined") return ""
  const value = new URLSearchParams(window.location.search).get("txHash") || ""
  return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : ""
}

function initialAdvancedMintContract() {
  if (typeof window === "undefined") return ""
  const value = new URLSearchParams(window.location.search).get("contractAddress") || ""
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : ""
}

function initialSignatureWorkspace() {
  if (typeof window === "undefined") return "analysis"
  return new URLSearchParams(window.location.search).get("workspace") === "advanced" ? "advanced" : "analysis"
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

function monitorAlertTitle(value) {
  return String(value?.title || value?.ruleName || "611nft 监控报警").slice(0, 120)
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败：${path}`)
  return data
}

function useForm(initial) {
  const [form, setForm] = useState(initial)
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
  return [form, set, setForm]
}

function Button({ children, icon: Icon, tone = "default", busy, ...props }) {
  return (
    <button type="button" className={`btn ${tone}`} disabled={busy || props.disabled} {...props}>
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

function NftImage({ src, alt, className = "", fallbackSeed = "", fallbackLabel = "NFT", fallbackTitle = "NFT 图片不可用" }) {
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
  if (op.error) {
    return <div className="resultMessage error"><ShieldAlert size={16} /><div><strong>操作需要处理</strong><span>{uiError(op.error)}</span></div></div>
  }
  const result = op.result || {}
  const summary = result.cancelled
    ? "操作已在执行前取消"
    : Array.isArray(result.balances)
      ? `已刷新 ${result.balances.length} 条余额`
      : Array.isArray(result.created)
        ? `已创建 ${result.created.length} 个钱包`
        : Array.isArray(result.entries)
          ? `已为预览准备 ${result.entries.length} 笔交易`
          : result.taskId
            ? `任务${uiStatus(result.status || "updated")}`
            : "操作已完成"
  return (
    <div className="resultMessage success">
      <Check size={16} />
      <div>
        <strong>{summary}</strong>
        <span>{result.skipped?.length ? `已跳过 ${result.skipped.length} 项` : "工作区已显示最新本地状态。"}</span>
        <details className="resultDetails">
          <summary>查看技术详情</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      </div>
    </div>
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
      <span>已选择 {selectedCount} 个</span>
      <button onClick={onClear} type="button" disabled={disabled} aria-label="清空所选钱包">
        <X size={14} />
      </button>
    </div>
  )
}

export default function App({ moduleName = "", theme = "" }) {
  const moduleMode = moduleTabs[moduleName] ? moduleName : requestedModule()
  const tabs = moduleTabs[moduleMode] || baseTabs
  const [wallets, setWallets] = useState([])
  const [walletsLoaded, setWalletsLoaded] = useState(false)
  const [walletRoot, setWalletRoot] = useState("")
  const [health, setHealth] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [chains, setChains] = useState([])
  const [chainId, setChainId] = useState(readStoredChainId)
  const [tab, setTab] = useState(() => readInitialTab(moduleMode, tabs))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [selected, setSelected] = useState(() => new Set(readStoredWalletIds()))
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
  const [mintMonitorLanguage] = useState(readMonitorLanguage)
  const [mintRealtime, setMintRealtime] = useState(createRealtimeFeedState)
  const [mintMonitorStream, setMintMonitorStream] = useState("connecting")
  const [mintTrending, setMintTrending] = useState({ windows: {}, snapshotId: "", generatedAt: null, loading: false, error: "" })
  const [mintRadar, setMintRadar] = useState({ drops: [], snapshotId: "", generatedAt: null, scanError: "", loading: false, error: "" })
  const [mintFlags, setMintFlags] = useState({ items: [], busyAddress: "", error: "" })
  const [mintAlerts, setMintAlerts] = useState({ rules: [], notifier: null, loading: false, error: "" })
  const [monitorAlertHistory, setMonitorAlertHistory] = useState([])
  const [alertPreferences, setAlertPreferences] = useState(readAlertPreferences)
  const [mintCollection, setMintCollection] = useState(null)
  const [mintCollectionBusy, setMintCollectionBusy] = useState(false)
  const [mintCollectionSlow, setMintCollectionSlow] = useState(false)
  const [mintCollectionError, setMintCollectionError] = useState("")
  const mintCollectionRequest = useRef({ id: 0, controller: null })
  const mintMonitorWindowRef = useRef(mintMonitorWindow)
  mintMonitorWindowRef.current = mintMonitorWindow
  const alertPreferencesRef = useRef(alertPreferences)
  alertPreferencesRef.current = alertPreferences
  const seenMonitorAlertIds = useRef([])
  const alertAudioContext = useRef(null)
  const mintBootstrapKey = useRef("")
  const tokenHoldingsRequestId = useRef(0)
  const [mintSetupNotice, setMintSetupNotice] = useState("")
  const [tokenHoldings, setTokenHoldings] = useState({ loading: false, data: null, error: "" })

  const [createForm, setCreateForm] = useForm({ prefix: "bt", start: 101, count: 1 })
  const [balanceForm, setBalanceForm] = useForm({ tokenAddress: "" })
  const [oneForm, setOneForm] = useForm({ fromId: "default", targetIds: [], asset: "native", tokenAddress: "", amountMode: "fixed", amount: "0.001", targetBalance: "0.001", executionMode: "sequential" })
  const [manyForm, setManyForm] = useForm({ sourceIds: [], destination: "", contractAddress: "", snapshotId: "", holdingIds: [], preflight: true })
  const [multiForm, setMultiForm] = useForm({ senderIds: [], receiverIds: [], asset: "native", tokenAddress: "", amount: "0.0001", executionMode: "sequential", preflight: true })
  const [approvalForm, setApprovalForm] = useForm({ tokenAddress: "", spender: "", amount: "0", revoke: false, executionMode: "sequential" })
  const [contractForm, setContractForm] = useForm({ to: "", valueWei: "0", data: "0x", executionMode: "sequential", preflight: true })
  const [mintForm, setMintForm, setMintFormState] = useForm(() => initialMintForm(moduleMode))

  const chain = useMemo(() => chains.find((item) => item.id === Number(chainId)) || chains[0], [chains, chainId])
  const selectedIds = useMemo(() => [...selected], [selected])
  const selectedWallets = useMemo(() => wallets.filter((wallet) => selected.has(wallet.id)), [wallets, selected])
  const groups = useMemo(() => groupWallets(wallets), [wallets])
  const mintInputsLocked = !canChangeMintInputs(nftMintJob)
  const activeTab = tabs.find((item) => item.id === tab) || tabs[0]
  const supportsWalletSearch = tab === "wallets" || tab === "balances"
  const singleModule = moduleMode !== "all"
  const wideTab = singleModule || ["mint", "follow", "sign"].includes(tab)

  const filteredWallets = useMemo(() => {
    const q = query.trim().toLowerCase()
    return wallets.filter((wallet) => {
      const haystack = `${wallet.id} ${wallet.address} ${wallet.label} ${wallet.group} ${wallet.note} ${wallet.proxyIp} ${wallet.exchangeAddress}`.toLowerCase()
      if (q && !haystack.includes(q)) return false
      const walletGroup = normalizeWalletGroup(wallet.group)
      if (groupFilter === UNGROUPED_GROUP_FILTER && walletGroup) return false
      if (groupFilter && groupFilter !== UNGROUPED_GROUP_FILTER && walletGroup !== groupFilter) return false
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
    const [walletData, chainData, txData, healthData] = await Promise.all([
      api("/api/wallets"),
      api("/api/chains"),
      api("/api/transactions?limit=100"),
      api("/api/health"),
    ])
    setWallets(walletData.wallets)
    setWalletsLoaded(true)
    setWalletRoot(walletData.walletRoot || healthData.walletRoot || "")
    setHealth(healthData)
    setChains(chainData.chains)
    setChainId((current) => resolveSupportedChainId(current, chainData.chains))
    setTransactions(txData.transactions)
    setActiveWallet((current) => walletData.wallets.find((wallet) => wallet.id === current?.id) || walletData.wallets[0] || null)
  }

  async function refreshAll() {
    setRefreshing(true)
    try {
      await loadAll()
    } catch (error) {
      setOp({ loading: false, result: null, error: error.message })
    } finally {
      setRefreshing(false)
    }
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

  async function playMonitorAlertTone() {
    if (typeof window === "undefined") return
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    const context = alertAudioContext.current || new AudioContextClass()
    alertAudioContext.current = context
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
  }

  function publishMonitorAlert(value) {
    const id = String(value?.id || `${value?.ruleId || "alert"}:${value?.triggeredAt || Date.now()}`)
    const remembered = rememberAlertId(seenMonitorAlertIds.current, id)
    if (remembered.duplicate) return false
    seenMonitorAlertIds.current = remembered.ids
    const alert = { ...value, id, title: monitorAlertTitle(value) }
    setMonitorAlertHistory((current) => [alert, ...current.filter((item) => item.id !== id)].slice(0, 30))
    if (alertPreferencesRef.current.sound) void playMonitorAlertTone().catch(() => {})
    if (alertPreferencesRef.current.desktop && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(alert.title, { body: String(alert.message || "检测到新的监控事件"), tag: id })
      } catch {
        // The in-app alert history still records the event.
      }
    }
    return true
  }

  async function changeAlertPreference(key, enabled) {
    let accepted = Boolean(enabled)
    if (key === "desktop" && accepted) {
      accepted = typeof Notification !== "undefined" && await Notification.requestPermission() === "granted"
      if (!accepted) setMintAlerts((current) => ({ ...current, error: "浏览器未授予桌面通知权限" }))
    }
    const next = writeAlertPreferences(window.localStorage, { ...alertPreferencesRef.current, [key]: accepted })
    alertPreferencesRef.current = next
    setAlertPreferences(next)
    if (key === "sound" && accepted) void playMonitorAlertTone().catch(() => {})
    return accepted
  }

  async function loadMintTrendingWindow(windowSeconds) {
    setMintTrending((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await api(`/api/mint-monitor/trending?chainId=${Number(chainId)}&window=${Number(windowSeconds)}&limit=20`)
      setMintTrending((current) => ({ ...mergeTrendingSnapshots(current, data), loading: false, error: "" }))
      return data
    } catch (error) {
      setMintTrending((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  async function loadMintRadar() {
    setMintRadar((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await api(`/api/seadrop-radar?chainId=${Number(chainId)}&includeUnscheduled=true`)
      setMintRadar({
        drops: data.drops || [],
        snapshotId: data.snapshotId || "",
        generatedAt: data.generatedAt || null,
        scanError: data.scanError || "",
        loading: false,
        error: "",
      })
      return data
    } catch (error) {
      setMintRadar((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  async function loadMintAlerts({ quiet = false } = {}) {
    if (!quiet) setMintAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await api(`/api/alerts?chainId=${Number(chainId)}`)
      setMintAlerts({ rules: data.rules || [], notifier: data.notifier || null, loading: false, error: "" })
      return data
    } catch (error) {
      setMintAlerts((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  async function toggleCollectionFlag(collection) {
    const address = String(collection?.address || collection?.contract || "").toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(address)) return null
    const existing = mintFlags.items.find((item) => item.address?.toLowerCase() === address)
    setMintFlags((current) => ({ ...current, busyAddress: address, error: "" }))
    try {
      if (existing) {
        await api(`/api/collections/${address}/flag?chainId=${Number(chainId)}`, { method: "DELETE" })
        setMintFlags((current) => ({ ...current, items: current.items.filter((item) => item.address?.toLowerCase() !== address), busyAddress: "" }))
        return null
      }
      const data = await api(`/api/collections/${address}/flag`, {
        method: "POST",
        body: JSON.stringify({ chainId: Number(chainId), flag: "scam", note: "个人风险标记" }),
      })
      setMintFlags((current) => ({ ...current, items: [data.flag, ...current.items.filter((item) => item.address?.toLowerCase() !== address)], busyAddress: "" }))
      return data.flag
    } catch (error) {
      setMintFlags((current) => ({ ...current, busyAddress: "", error: error.message }))
      throw error
    }
  }

  async function createMintAlertRule(input) {
    setMintAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await api("/api/alerts", { method: "POST", body: JSON.stringify({ ...input, chainId: Number(chainId) }) })
      setMintAlerts((current) => ({ ...current, rules: [data.rule, ...current.rules], loading: false }))
      return data.rule
    } catch (error) {
      setMintAlerts((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  async function updateMintAlertRule(id, input) {
    setMintAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await api(`/api/alerts/${id}`, { method: "PATCH", body: JSON.stringify(input) })
      setMintAlerts((current) => ({ ...current, rules: current.rules.map((rule) => rule.id === id ? data.rule : rule), loading: false }))
      return data.rule
    } catch (error) {
      setMintAlerts((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  async function deleteMintAlertRule(id) {
    setMintAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      await api(`/api/alerts/${id}`, { method: "DELETE" })
      setMintAlerts((current) => ({ ...current, rules: current.rules.filter((rule) => rule.id !== id), loading: false }))
    } catch (error) {
      setMintAlerts((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  async function testMintAlert() {
    setMintAlerts((current) => ({ ...current, loading: true, error: "" }))
    try {
      const data = await api("/api/alerts/test", {
        method: "POST",
        body: JSON.stringify({ chainId: Number(chainId), title: "611nft 测试报警", message: "浏览器与通知通道测试" }),
      })
      publishMonitorAlert(data.alert)
      setMintAlerts((current) => ({ ...current, loading: false }))
      return data
    } catch (error) {
      setMintAlerts((current) => ({ ...current, loading: false, error: error.message }))
      throw error
    }
  }

  useEffect(() => {
    void refreshAll()
    loadScriptStatus().catch((error) => setScriptError(error.message))
    loadScriptResults().catch((error) => setScriptError(error.message))
  }, [])

  useEffect(() => {
    if (!walletsLoaded) return
    const walletIds = new Set(wallets.map((wallet) => wallet.id))
    setSelected((current) => {
      const ids = reconcileWalletIds(current, wallets)
      writeStoredWalletIds(ids)
      const next = new Set(ids)
      return next.size === current.size && ids.every((id) => current.has(id)) ? current : next
    })
    if (!wallets.length) return
    const preferredId = wallets.find((wallet) => wallet.id === "default")?.id || wallets[0].id
    if (!walletIds.has(oneForm.fromId)) setOneForm("fromId", preferredId)
  }, [wallets, walletsLoaded, oneForm.fromId])

  useEffect(() => {
    if (walletsLoaded) writeStoredWalletIds(selected)
  }, [selected, walletsLoaded])

  useEffect(() => {
    saveActiveTab(moduleMode, tab)
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
    const frame = window.requestAnimationFrame(() => {
      document.querySelector("nav button.active")?.scrollIntoView({ block: "nearest", inline: "center" })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [moduleMode, tab])

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
    if (theme) return undefined
    const requested = new URLSearchParams(window.location.search).get("theme")
    document.documentElement.dataset.theme = requested === "light" ? "light" : "dark"
    const receiveTheme = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "611nft:theme") return
      document.documentElement.dataset.theme = event.data.theme === "light" ? "light" : "dark"
    }
    window.addEventListener("message", receiveTheme)
    return () => window.removeEventListener("message", receiveTheme)
  }, [theme])

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
    const loadOverview = async () => {
      setMintMonitor((current) => ({ ...current, loading: true, error: "" }))
      const bootstrapKey = String(Number(chainId))
      const useBootstrap = mintBootstrapKey.current !== bootstrapKey
      if (useBootstrap) {
        setMintTrending((current) => ({ ...current, loading: true, error: "" }))
        setMintRadar((current) => ({ ...current, loading: true, error: "" }))
      }
      try {
        const data = await api(useBootstrap
          ? `/api/bootstrap?chainId=${Number(chainId)}&window=${mintMonitorWindow}`
          : `/api/mint-monitor/overview?chainId=${Number(chainId)}&window=${mintMonitorWindow}`)
        if (!alive) return
        const overview = useBootstrap ? data.overview : data
        setMintMonitor({ loading: false, data: overview, error: "" })
        const overviewRows = overview.windows?.[String(mintMonitorWindow)] || []
        setMintCollection((current) => syncCollectionDetailFromOverview(current, overviewRows))
        setMintRealtime((current) => replaceRealtimeOverview(current, overview.events || []))
        if (useBootstrap) {
          mintBootstrapKey.current = bootstrapKey
          setMintTrending((current) => ({ ...mergeTrendingSnapshots(current, data.trending || {}), loading: false, error: "" }))
          setMintRadar({
            drops: data.radar?.drops || [],
            snapshotId: data.radar?.snapshotId || "",
            generatedAt: data.radar?.generatedAt || null,
            scanError: "",
            loading: false,
            error: "",
          })
          setMintFlags({ items: data.flags || [], busyAddress: "", error: "" })
        }
        void preloadLiveMintImages(overview)
      } catch (error) {
        if (alive) {
          setMintMonitor((current) => ({ ...current, loading: false, error: error.message }))
          if (useBootstrap) {
            setMintTrending((current) => ({ ...current, loading: false, error: error.message }))
            setMintRadar((current) => ({ ...current, loading: false, error: error.message }))
          }
        }
      }
    }
    void loadOverview()
    return () => { alive = false }
  }, [tab, chainId, mintMonitorWindow])

  useEffect(() => {
    if (tab !== "mint") return undefined
    void loadMintAlerts().catch(() => {})
    return undefined
  }, [tab, chainId])

  useEffect(() => {
    if (tab !== "mint") return undefined
    let alive = true
    let events
    let overviewRefreshTimer
    let overviewRequest = 0
    setMintMonitorStream("connecting")

    const loadStreamOverview = async () => {
      const requestId = ++overviewRequest
      const requestedWindow = mintMonitorWindowRef.current
      try {
        const data = await api(`/api/mint-monitor/overview?chainId=${Number(chainId)}&window=${requestedWindow}`)
        if (!alive || requestId !== overviewRequest || requestedWindow !== mintMonitorWindowRef.current) return
        setMintMonitor({ loading: false, data, error: "" })
        const overviewRows = data.windows?.[String(requestedWindow)] || []
        setMintCollection((current) => syncCollectionDetailFromOverview(current, overviewRows))
        setMintRealtime((current) => replaceRealtimeOverview(current, data.events || []))
        void preloadLiveMintImages(data)
      } catch (error) {
        if (alive && requestId === overviewRequest) setMintMonitor((current) => ({ ...current, loading: false, error: error.message }))
      }
    }

    const scheduleOverviewRefresh = () => {
      if (!alive || overviewRefreshTimer) return
      overviewRefreshTimer = window.setTimeout(() => {
        overviewRefreshTimer = undefined
        void loadStreamOverview()
      }, 1000)
    }

    if (typeof EventSource !== "undefined") {
      events = new EventSource(`/api/mint-monitor/stream?chainId=${Number(chainId)}`)
      events.onopen = () => {
        if (alive) setMintMonitorStream("connected")
      }
      const applyStreamValue = (value) => {
        const realtimeTypes = ["mint", "mint_batch", "mint_update", "heartbeat", "collection_update", "collection_patch", "discard", "replay_reset"]
        if (realtimeTypes.includes(value.type)) setMintRealtime((current) => reduceRealtimeFeed(current, value))
        if (value.type === "mint" || value.type === "mint_batch") {
          setMintCollection((current) => collectionDetailFromMintEvent(current, value))
          scheduleOverviewRefresh()
        } else if (value.type === "mint_update") {
          const imageUrl = value.imageUrl || value.projectImageUrl || value.image_url
          setMintMonitor((current) => current.data ? ({
            ...current,
            data: {
              ...current.data,
              events: (current.data.events || []).map((event) => event.id === value.id ? { ...event, ...value } : event),
              windows: Object.fromEntries(Object.entries(current.data.windows || {}).map(([key, rows]) => [
                key,
                rows.map((row) => row.address?.toLowerCase() === value.address?.toLowerCase() ? { ...row, image_url: imageUrl || row.image_url } : row),
              ])),
            },
          }) : current)
          setMintCollection((current) => current?.address?.toLowerCase() === value.address?.toLowerCase() ? ({
            ...current,
            image_url: imageUrl || current.image_url,
            recent_mints: (current.recent_mints || []).map((mint) => mint.tx_hash === value.txHash ? { ...mint, image_url: imageUrl, token_name: value.tokenName } : mint),
          }) : current)
        } else if (value.type === "collection_update" || value.type === "collection_patch") {
          const address = String(value.address || "").toLowerCase()
          setMintMonitor((current) => current.data ? { ...current, data: applyCollectionUpdate(current.data, value) } : current)
          setMintCollection((current) => String(current?.address || "").toLowerCase() === address
            ? mergeSnapshotIntoRow(current, value.collection_snapshot)
            : current)
        } else if (value.type === "discard") {
          const discardedIds = new Set((value.eventIds || []).map(String))
          setMintMonitor((current) => current.data ? ({
            ...current,
            data: { ...current.data, events: (current.data.events || []).filter((event) => !discardedIds.has(String(event.id || ""))) },
          }) : current)
          scheduleOverviewRefresh()
        } else if (value.type === "replay_reset") {
          void loadStreamOverview()
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
        } else if (value.type === "trending_snapshot") {
          setMintTrending((current) => ({ ...mergeTrendingSnapshots(current, value), loading: false, error: "" }))
        } else if (value.type === "seadrop_radar") {
          setMintRadar((current) => ({
            ...current,
            drops: value.drops || [],
            snapshotId: value.snapshotId || current.snapshotId,
            generatedAt: value.generatedAt || current.generatedAt,
            scanError: "",
            loading: false,
            error: "",
          }))
        } else if (value.type === "monitor_alert") {
          publishMonitorAlert(value)
        }
        if (["mint", "mint_batch", "mint_update", "collection_update", "collection_patch"].includes(value.type)) {
          void preloadLiveMintImages(value)
        }
      }
      events.onmessage = (message) => {
        if (!alive) return
        try {
          applyStreamValue(JSON.parse(message.data))
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
      overviewRequest += 1
      window.clearTimeout(overviewRefreshTimer)
      events?.close()
      setMintMonitorStream("offline")
    }
  }, [tab, chainId])

  useEffect(() => {
    mintCollectionRequest.current.controller?.abort()
    mintCollectionRequest.current = { id: mintCollectionRequest.current.id + 1, controller: null }
    setMintCollection(null)
    setMintCollectionBusy(false)
    setMintCollectionSlow(false)
    setMintCollectionError("")
    setMintRealtime(createRealtimeFeedState())
    setMintTrending({ windows: {}, snapshotId: "", generatedAt: null, loading: false, error: "" })
    setMintRadar({ drops: [], snapshotId: "", generatedAt: null, scanError: "", loading: false, error: "" })
    setMintFlags({ items: [], busyAddress: "", error: "" })
    setMintAlerts({ rules: [], notifier: null, loading: false, error: "" })
    setMonitorAlertHistory([])
    tokenHoldingsRequestId.current += 1
    setManyForm("snapshotId", "")
    setManyForm("holdingIds", [])
    setTokenHoldings({ loading: false, data: null, error: "" })
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
    setSelected(new Set(reconcileWalletIds(ids, wallets)))
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
      return null
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
          proxyIp: wallet.proxyIp,
          exchangeAddress: wallet.exchangeAddress,
        }),
      }),
    )
  }

  async function importWallets(text) {
    return runOperation(() => api("/api/wallets/import", {
      method: "POST",
      body: JSON.stringify({ text }),
    }))
  }

  async function removeWallets(walletIds) {
    if (!walletIds.length || !window.confirm(`删除选中的 ${walletIds.length} 个本地钱包？请确认密钥已经备份。`)) return null
    const result = await runOperation(() => api("/api/wallets", {
      method: "DELETE",
      body: JSON.stringify({ walletIds }),
    }))
    if (result) setSelected(new Set())
    return result
  }

  async function setWalletGroup(walletIds, group) {
    return runOperation(() => api("/api/wallets/bulk-group", {
      method: "POST",
      body: JSON.stringify({ walletIds, group }),
    }))
  }

  async function testWalletProxy(proxy) {
    return runOperation(() => api("/api/network/test-proxy", {
      method: "POST",
      body: JSON.stringify({ proxy }),
    }))
  }

  async function exportWallets(walletIds, phrase) {
    setOp({ loading: true, result: null, error: "" })
    try {
      const response = await fetch("/api/wallets/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletIds, phrase }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "钱包导出失败")
      }
      const blob = await response.blob()
      const href = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = href
      link.download = `nfttool-wallets-${Date.now()}.txt`
      link.click()
      URL.revokeObjectURL(href)
      setOp({ loading: false, result: { ok: true, exportedWallets: walletIds.length }, error: "" })
      return true
    } catch (error) {
      setOp({ loading: false, result: null, error: error.message })
      return false
    }
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
      prompt: "执行一对多分发任务？",
      body: {
          ...oneForm,
          chainId: Number(chainId),
          targetIds: oneForm.targetIds.filter((id) => id !== oneForm.fromId),
      },
    })
  }

  async function queryTokenHoldings() {
    const requestId = ++tokenHoldingsRequestId.current
    setTokenHoldings({ loading: true, data: null, error: "" })
    try {
      const data = await api("/api/token-holdings/query", {
        method: "POST",
        body: JSON.stringify({
          chainId: Number(chainId),
          walletIds: manyForm.sourceIds,
          contractAddress: manyForm.contractAddress.trim(),
        }),
      })
      if (requestId !== tokenHoldingsRequestId.current) return null
      setManyForm("snapshotId", data.snapshotId)
      setManyForm("holdingIds", data.holdings.rows.filter((row) => BigInt(row.count || 0) > 0n).map((row) => row.id))
      setTokenHoldings({ loading: false, data, error: "" })
      return data
    } catch (error) {
      if (requestId !== tokenHoldingsRequestId.current) return null
      setManyForm("snapshotId", "")
      setManyForm("holdingIds", [])
      setTokenHoldings({ loading: false, data: null, error: error.message })
      return null
    }
  }

  function resetTokenHoldings() {
    tokenHoldingsRequestId.current += 1
    setManyForm("snapshotId", "")
    setManyForm("holdingIds", [])
    setTokenHoldings({ loading: false, data: null, error: "" })
  }

  async function planManyToOne() {
    await runOperation(() =>
      api("/api/plan/token-collect", {
        method: "POST",
        body: JSON.stringify({
          snapshotId: manyForm.snapshotId,
          destination: manyForm.destination.trim(),
          holdingIds: manyForm.holdingIds,
          preflight: manyForm.preflight,
        }),
      }),
    )
  }

  async function executeManyToOne() {
    await executePreviewedTask({
      planPath: "/api/plan/token-collect",
      taskPath: "/api/tasks/token-collect",
      prompt: `归集所选 ${manyForm.holdingIds.length} 条代币持仓？`,
      body: {
        snapshotId: manyForm.snapshotId,
        destination: manyForm.destination.trim(),
        holdingIds: manyForm.holdingIds,
        preflight: manyForm.preflight,
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
      prompt: "执行多对多转账任务？",
      body: { ...multiForm, chainId: Number(chainId) },
    })
  }

  async function executeApproval() {
    await executePreviewedTask({
      planPath: "/api/plan/approval",
      taskPath: "/api/tasks/approval",
      prompt: approvalForm.revoke ? "执行撤销授权任务？" : "执行授权任务？",
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
      prompt: `${form.executionMode === "burst" ? "并发执行" : "执行"}合约调用任务？`,
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
        setNftMintError("没有钱包通过自动预检，请检查下方结果后重试。")
        return
      }
      const approved = window.confirm(
        `自动预检：${freshJob.summary.ready} 个就绪，${freshJob.summary.skipped} 个跳过，${freshJob.summary.failed} 个失败。确认在 ${freshJob.chainName} 广播 ${freshJob.summary.ready} 笔 NFT 铸造交易？`,
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
    const timeout = setTimeout(() => controller.abort("合集详情请求超时"), 10000)
    try {
      const data = await api(`/api/mint-monitor/collection/${collection.address}?chainId=${Number(chainId)}`, { signal: controller.signal })
      if (mintCollectionRequest.current.id !== requestId) return
      setMintCollection(data.collection)
    } catch (error) {
      if (mintCollectionRequest.current.id !== requestId) return
      setMintCollectionError(controller.signal.aborted ? "合集详情请求超时" : error.message)
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
    setMintSetupNotice(`已套用 ${source.name || shortAddress(source.address)} 的合约与铸造金额。`)
    document.getElementById("mint-setup")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  function useRecentMint(collection, mint) {
    if (mintInputsLocked) return
    if (!collection?.address || !mint) return
    setMintFormState((current) => mintSetupFromRecentMint(current, collection, mint))
    setMintSetupNotice(`已套用 ${collection.name || shortAddress(collection.address)} 的交易参数。`)
    document.getElementById("mint-setup")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  async function startMintScript(mode) {
    if (mode === "armed" && armConfirm !== "确认执行") {
      setScriptError("请输入执行确认短语")
      return
    }
    if (mode === "armed" && !window.confirm("确认启动实盘铸造运行器？")) return
    setScriptBusy(true)
    setScriptError("")
    try {
      const preview = mode === "armed"
        ? await api("/api/mint-script/preview", {
            method: "POST",
            body: JSON.stringify({ mode }),
          })
        : null
      const data = await api("/api/mint-script/start", {
        method: "POST",
        body: JSON.stringify(mintScriptStartPayload(mode, preview)),
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

  function explorerBlock(blockNumber, blockChainId) {
    const cfg = chains.find((item) => item.id === Number(blockChainId))
    return cfg?.explorer && blockNumber !== null && blockNumber !== undefined && String(blockNumber) !== ""
      ? `${cfg.explorer}/block/${blockNumber}`
      : ""
  }

  return (
    <div className={`${sidebarCollapsed ? "workspaceScope appShell sidebarCollapsed" : "workspaceScope appShell"}${singleModule ? " singleModule" : ""}`} data-theme={theme || document.documentElement.dataset.theme || "dark"}>
      {!singleModule ? <aside className="sidebar">
        <div className="brand">
          <div className="brandMark"><img src={logoUrl} alt="" /></div>
          <div className="brandCopy">
            <strong>611nft</strong>
            <span>本地多钱包铸造</span>
          </div>
          <button className="sidebarToggle" type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "显示导航" : "隐藏导航"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "显示导航" : "隐藏导航"}>
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
          <span className={wallets.length ? "statusDot ready" : "statusDot"} aria-hidden="true" />
          <div>
            <strong>{wallets.length ? "本地签名器已就绪" : "暂无本地钱包"}</strong>
            <span>{walletRoot || "根目录 .env"}</span>
          </div>
        </div>
      </aside> : null}

      <main className={singleModule ? "embeddedMain" : ""}>
        {!singleModule ? <header className="topbar">
          <div className="topbarLead">
            <div className="pageIdentity">
              <span>工作区 / {chain?.name || "本地"} / API {health?.port || "—"}</span>
              <strong>{activeTab.label}</strong>
              <small>{activeTab.description}</small>
            </div>
            {supportsWalletSearch ? (
              <div className="searchBox">
                <Search size={16} />
                <input aria-label="搜索钱包" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、标签或地址" />
                {query ? <button type="button" onClick={() => setQuery("")} aria-label="清空搜索"><X size={14} /></button> : null}
              </div>
            ) : null}
          </div>
          <div className="toolbar">
            <div className="selectWrap">
              <select value={chainId} onChange={(event) => setChainId(Number(event.target.value))} disabled={mintInputsLocked} aria-label="当前链">
                {chains.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <ChevronDown size={14} />
            </div>
            <Button icon={RefreshCcw} onClick={refreshAll} busy={refreshing}>刷新</Button>
          </div>
        </header> : moduleMode !== "monitor" ? <header className="embeddedControlBar">
          {supportsWalletSearch ? <div className="searchBox"><Search size={16} /><input aria-label="搜索钱包" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、分组或地址" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="清空搜索"><X size={14} /></button> : null}</div> : <span />}
          <div className="toolbar"><div className="selectWrap"><select value={chainId} onChange={(event) => setChainId(Number(event.target.value))} disabled={mintInputsLocked} aria-label="当前链">{chains.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></div><Button icon={RefreshCcw} onClick={refreshAll} busy={refreshing}>刷新</Button></div>
        </header> : null}

        {!singleModule ? <section className="stats">
          <Stat icon={Wallet} label="钱包" value={wallets.length} sub={`已选择 ${selected.size} 个`} />
          <Stat icon={Coins} label={chain?.nativeSymbol || "—"} value={totalNative.toFixed(6)} sub={chain?.name} />
          <Stat icon={Tags} label="分组" value={groups.length} sub={groupFilter === UNGROUPED_GROUP_FILTER ? "未分组" : groupFilter || "全部"} />
          <Stat icon={Activity} label="交易" value={transactions.length} sub="本地日志" />
        </section> : null}

        {!wallets.length && tab !== "mint" ? (
          <div className="signerNotice" role="status">
            <KeyRound size={16} />
            <div><strong>本地签名器暂无钱包</strong><span>请在根目录 .env 中加入一行 64 位私钥，或在下方创建钱包。</span></div>
          </div>
        ) : null}

        {tab !== "mint" && selected.size ? <SelectionBar selectedCount={selected.size} onClear={() => setSelected(new Set())} disabled={mintInputsLocked} /> : null}

        <section className={wideTab ? "contentGrid mintContentGrid" : "contentGrid"}>
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
                onImport={importWallets}
                onRemove={removeWallets}
                onExport={exportWallets}
                onBulkGroup={setWalletGroup}
                onTestProxy={testWalletProxy}
                onRefreshBalances={() => refreshBalances(selectedIds.length ? selectedIds : filteredWallets.map((wallet) => wallet.id))}
                onSelectionChange={setSelectedIds}
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
                onSelectedIdsChange={setSelectedIds}
                busy={op.loading}
              />
            )}
            {tab === "one" && (
              <OneToManyView wallets={wallets} chain={chain} form={oneForm} setForm={setOneForm} onPlan={planOneToMany} onExecute={executeOneToMany} busy={op.loading} />
            )}
            {tab === "many" && (
              <ManyToOneView wallets={wallets} chain={chain} form={manyForm} setForm={setManyForm} holdings={tokenHoldings} onQuery={queryTokenHoldings} onReset={resetTokenHoldings} onPlan={planManyToOne} onExecute={executeManyToOne} busy={op.loading} />
            )}
            {tab === "multi" && <ManyToManyView wallets={wallets} chain={chain} form={multiForm} setForm={setMultiForm} onPlan={planManyToMany} onExecute={executeManyToMany} busy={op.loading} />}
            {tab === "approval" && <ApprovalView wallets={wallets} chain={chain} selectedIds={selectedIds} onSelectedIdsChange={setSelectedIds} form={approvalForm} setForm={setApprovalForm} onExecute={executeApproval} busy={op.loading} />}
            {tab === "contract" && <AdvancedMintView chain={chain} wallets={wallets} selectedIds={selectedIds} onSelectedIdsChange={setSelectedIds} initialContract={initialAdvancedMintContract()} />}
            {tab === "mint" && ["monitor", "alerts"].includes(moduleMode) && (
              <LiveMintView
                initialView={moduleMode === "alerts" ? "alerts" : "live"}
                chain={chain}
                chains={chains}
                chainId={chainId}
                onChainChange={setChainId}
                wallets={wallets}
                selectedIds={selectedIds}
                onSelectedIdsChange={setSelectedIds}
                monitor={mintMonitor}
                monitorWindow={mintMonitorWindow}
                setMonitorWindow={setMintMonitorWindow}
                liveEvents={mintRealtime.events}
                realtime={mintRealtime}
                streamStatus={mintMonitorStream}
                trending={mintTrending}
                onLoadTrending={loadMintTrendingWindow}
                radar={mintRadar}
                onRefreshRadar={loadMintRadar}
                flags={mintFlags}
                onToggleFlag={toggleCollectionFlag}
                alerts={mintAlerts}
                alertHistory={monitorAlertHistory}
                alertPreferences={alertPreferences}
                onAlertPreferenceChange={changeAlertPreference}
                onCreateAlert={createMintAlertRule}
                onUpdateAlert={updateMintAlertRule}
                onDeleteAlert={deleteMintAlertRule}
                onTestAlert={testMintAlert}
                onRefreshAlerts={loadMintAlerts}
                explorerTx={explorerTx}
                explorerContract={explorerContract}
                explorerBlock={explorerBlock}
                onSelectCollection={selectMintCollection}
                mintForm={mintForm}
                setMintForm={setMintForm}
                job={nftMintJob}
                error={nftMintError}
                busy={nftMintBusy}
                onPreview={previewNftMint}
                onMint={mintNftNow}
              />
            )}
            {tab === "mint" && !["monitor", "alerts"].includes(moduleMode) && (
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
                liveEvents={mintRealtime.events}
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
            {tab === "follow" && (
              <FollowMintView
                wallets={wallets}
                chain={chain}
                selectedIds={selectedIds}
                onSelectedIdsChange={setSelectedIds}
              />
            )}
            {tab === "sign" && (
              <SignatureLabView
                chain={chain}
                wallets={wallets}
                selectedIds={selectedIds}
                onSelectedIdsChange={setSelectedIds}
                initialTxHash={initialSignatureTxHash()}
                initialContract={initialAdvancedMintContract()}
                initialWorkspace={initialSignatureWorkspace()}
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

          <aside className={wideTab ? "sidePane mintSidePane" : "sidePane"}>
            <h2>输出</h2>
            <ResultBox op={op} />
            {!op.result && !op.error ? <div className="emptyState"><Terminal size={18} />暂无任务输出</div> : null}
            <h2>最近交易</h2>
            <div className="miniTxList">
              {transactions.slice(0, 8).map((tx) => (
                <a key={tx.id} href={explorerTx(tx.txHash, tx.chainId) || "#"} target="_blank" rel="noreferrer" className="miniTx">
                  <span className={tx.status}>{uiStatus(tx.status)}</span>
                  <strong>{tx.walletId}</strong>
                  <small>{tx.txHash ? shortAddress(tx.txHash) : tx.error ? uiError(tx.error) : uiTransactionType(tx.type)}</small>
                </a>
              ))}
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}

function WalletsView({
  wallets, allWallets, groups, groupFilter, setGroupFilter, selected, toggleWallet, selectFiltered,
  activeWallet, setActiveWallet, chainId, onSave, createForm, setCreateForm, onCreate, onImport,
  onRemove, onExport, onBulkGroup, onTestProxy, onRefreshBalances, onSelectionChange, busy, selectionLocked,
}) {
  const [draft, setDraft] = useState(activeWallet || {})
  const [panel, setPanel] = useState("")
  const [importText, setImportText] = useState("")
  const [bulkGroup, setBulkGroup] = useState("")
  const [exportPhrase, setExportPhrase] = useState("")
  const [proxyProbe, setProxyProbe] = useState("")
  const selectedIds = [...selected]

  useEffect(() => setDraft(activeWallet || {}), [activeWallet])

  async function submitImport() {
    const result = await onImport(importText)
    if (result) {
      setImportText("")
      setPanel("")
    }
  }

  async function submitExport() {
    const ok = await onExport(selectedIds, exportPhrase)
    if (ok) {
      setExportPhrase("")
      setPanel("")
    }
  }

  return (
    <div className="sectionStack walletWorkbench">
      <div className="sectionHeader compactHeader">
        <div><h1>钱包管理</h1><p>账号({allWallets.length}) · 当前显示 {wallets.length} · 已选 {selected.size}</p></div>
        <div className="actions walletFilters">
          <div className="selectWrap">
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="">全部分组</option>
              {groups.filter((group) => group.key).map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}
              {groups.some((group) => !group.key) ? <option value={UNGROUPED_GROUP_FILTER}>未分组</option> : null}
            </select>
            <ChevronDown size={14} />
          </div>
          <Button icon={Check} onClick={selectFiltered} disabled={selectionLocked}>全选当前</Button>
        </div>
      </div>

      <WalletGroupQuickSelect wallets={allWallets} selectedIds={selectedIds} onChange={onSelectionChange} label="钱包分组" disabled={selectionLocked} />

      <div className="walletActionBar">
        <Button icon={Upload} tone={panel === "import" ? "primary" : "default"} onClick={() => setPanel(panel === "import" ? "" : "import")}>导入私钥</Button>
        <Button icon={Trash2} tone="danger" onClick={() => onRemove(selectedIds)} disabled={!selectedIds.length || selectionLocked}>删除选中</Button>
        <Button icon={RefreshCcw} onClick={onRefreshBalances} busy={busy} disabled={!wallets.length}>余额查询</Button>
        <label className="inlineTool"><span>设置分组</span><input value={bulkGroup} onChange={(event) => setBulkGroup(event.target.value)} placeholder="分组名称" /><button type="button" onClick={() => onBulkGroup(selectedIds, bulkGroup)} disabled={!selectedIds.length || busy}>应用</button></label>
        <Button icon={X} onClick={() => onBulkGroup(selectedIds, "")} disabled={!selectedIds.length || busy}>清除分组</Button>
        <label className="inlineTool proxyTool"><span>代理</span><input value={proxyProbe} onChange={(event) => setProxyProbe(event.target.value)} placeholder="127.0.0.1:8080" /><button type="button" onClick={() => onTestProxy(proxyProbe)} disabled={!proxyProbe || busy}><Wifi size={14} />测试 IP</button></label>
        <Button icon={Plus} tone={panel === "create" ? "primary" : "default"} onClick={() => setPanel(panel === "create" ? "" : "create")}>创建钱包</Button>
        <Button icon={Download} tone={panel === "export" ? "primary" : "default"} onClick={() => setPanel(panel === "export" ? "" : "export")} disabled={!selectedIds.length}>导出</Button>
      </div>

      {panel === "import" ? (
        <section className="walletInlinePanel">
          <div><strong>批量导入</strong><span>每行一个钱包，只接受：名称,私钥 或 名称,分组,私钥</span></div>
          <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={`土狗1,0123...abcd\n土狗2,测试组,4567...cdef`} autoComplete="off" spellCheck="false" />
          <Button icon={Upload} tone="primary" onClick={submitImport} busy={busy} disabled={!importText.trim()}>校验并导入</Button>
        </section>
      ) : null}

      {panel === "create" ? (
        <section className="walletInlinePanel walletCreatePanel">
          <div><strong>创建本地钱包</strong><span>新私钥写入权限为 600 的本地密钥文件。</span></div>
          <Field label="名称前缀"><input value={createForm.prefix} onChange={(event) => setCreateForm("prefix", event.target.value)} /></Field>
          <Field label="起始序号"><input type="number" min="1" step="1" value={createForm.start} onChange={(event) => setCreateForm("start", event.target.value)} /></Field>
          <Field label="数量"><input type="number" min="1" max="500" step="1" value={createForm.count} onChange={(event) => setCreateForm("count", event.target.value)} /></Field>
          <Button icon={Plus} tone="primary" onClick={onCreate} busy={busy}>创建</Button>
        </section>
      ) : null}

      {panel === "export" ? (
        <section className="walletInlinePanel exportPanel">
          <div><strong>导出 {selectedIds.length} 个本地私钥</strong><span>输出明文文件；输入确认短语后由浏览器直接下载。</span></div>
          <input value={exportPhrase} onChange={(event) => setExportPhrase(event.target.value)} placeholder="确认导出私钥" autoComplete="off" />
          <Button icon={Download} tone="danger" onClick={submitExport} busy={busy} disabled={exportPhrase !== "确认导出私钥"}>确认导出</Button>
        </section>
      ) : null}

      <div className="tableWrap walletTableWrap">
          <table className="walletDataTable">
            <thead>
              <tr>
                <th></th>
                <th>备注 / 名称</th>
                <th>钱包地址</th>
                <th>余额</th>
                <th>分组</th>
                <th>代理 IP</th>
                <th>交易所地址</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((wallet) => {
                const balance = nativeBalance(wallet, chainId)
                return (
                  <tr key={wallet.id} className={activeWallet?.id === wallet.id ? "selectedRow" : ""} onClick={() => setActiveWallet(wallet)}>
                    <td><input type="checkbox" checked={selected.has(wallet.id)} onChange={() => toggleWallet(wallet.id)} onClick={(event) => event.stopPropagation()} disabled={selectionLocked} /></td>
                    <td><span className="profile">{wallet.favorite ? <Star size={13} fill="currentColor" /> : null}{wallet.label || wallet.id}</span><small>{wallet.note || wallet.id}</small></td>
                    <td><code className="fullAddress">{wallet.address}</code></td>
                    <td>{balance ? `${Number(balance.formatted).toFixed(6)} ${balance.symbol}` : <span className="muted">未查询</span>}</td>
                    <td>{wallet.group || <span className="muted">未分组</span>}</td>
                    <td>{wallet.proxyIp || <span className="muted">—</span>}</td>
                    <td><code>{wallet.exchangeAddress ? shortAddress(wallet.exchangeAddress) : "—"}</code></td>
                    <td><span className="sourceTag">{uiWalletSource(wallet.source)}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
      </div>

        <div className="editor walletMetadataEditor">
          <h2>钱包资料</h2>
          {draft?.id ? (
            <>
              <div className="addressBlock">
                <strong>{draft.id}</strong>
                <code>{draft.address}</code>
              </div>
              <Field label="名称"><input value={draft.label || ""} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field>
              <Field label="分组"><input value={draft.group || ""} onChange={(event) => setDraft({ ...draft, group: event.target.value })} /></Field>
              <Field label="代理 IP"><input value={draft.proxyIp || ""} onChange={(event) => setDraft({ ...draft, proxyIp: event.target.value })} placeholder="http://127.0.0.1:8080" /></Field>
              <Field label="交易所地址"><input value={draft.exchangeAddress || ""} onChange={(event) => setDraft({ ...draft, exchangeAddress: event.target.value })} placeholder="0x..." /></Field>
              <Field label="风险标签"><input value={draft.risk || ""} onChange={(event) => setDraft({ ...draft, risk: event.target.value })} /></Field>
              <Field label="备注"><textarea value={draft.note || ""} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></Field>
              <label className="checkLine"><input type="checkbox" checked={Boolean(draft.favorite)} onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })} /> 收藏</label>
              <Button icon={BadgeCheck} onClick={() => onSave(draft)} busy={busy}>保存资料</Button>
            </>
          ) : <div className="emptyState">选择一个钱包后编辑资料</div>}
        </div>
    </div>
  )
}

function BalancesView({ wallets, selectedIds, chain, chainId, balanceForm, setBalanceForm, refreshBalances, onSelectedIdsChange, busy }) {
  return (
    <div className="sectionStack">
      <div className="sectionHeader">
        <div>
          <h1>余额</h1>
          <p>{chain?.name} {chain?.nativeSymbol || "链币"} 与 ERC20 缓存</p>
        </div>
        <div className="actions">
          <Button icon={RefreshCcw} onClick={() => refreshBalances()} busy={busy} disabled={!wallets.length}>刷新所选钱包</Button>
        </div>
      </div>
      <div className="formGrid two">
        <Field label="ERC20 代币">
          <input value={balanceForm.tokenAddress} onChange={(event) => setBalanceForm("tokenAddress", event.target.value)} placeholder={`0x 代币地址；留空查询 ${chain?.nativeSymbol || "链币"}`} />
        </Field>
        <Field label="范围">
          <input value={selectedIds.length ? `已选择 ${selectedIds.length} 个钱包` : "当前可见钱包"} readOnly />
        </Field>
      </div>
      <WalletTableSelector wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} chainId={chainId} title="查询钱包" compact />
      <div className="tableWrap">
        <table>
          <thead>
            <tr><th>钱包</th><th>地址</th><th>余额</th><th>更新时间</th></tr>
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
                <td>{wallet.balances?.[0]?.updatedAt ? new Date(wallet.balances[0].updatedAt).toLocaleString() : <span className="muted">从未</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function OneToManyView({ wallets, chain, form, setForm, onPlan, onExecute, busy }) {
  const receiverIds = form.targetIds.filter((id) => id !== form.fromId)
  const canSubmit = receiverIds.length > 0

  return (
    <OperationPanel
      title="一对多分发"
      subtitle={`已选择 ${receiverIds.length} 个接收钱包`}
      actions={<><Button icon={ListChecks} onClick={onPlan} busy={busy} disabled={!canSubmit}>生成计划</Button><Button icon={Send} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>执行</Button></>}
    >
      <div className="formGrid three">
        <Field label="发送钱包">
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
        <Field label="资产"><select value={form.asset} onChange={(event) => setForm("asset", event.target.value)}><option value="native">{chain?.nativeSymbol || "链币"}</option><option value="erc20">ERC20</option></select></Field>
        <Field label="模式"><select value={form.amountMode} onChange={(event) => setForm("amountMode", event.target.value)}><option value="fixed">固定金额</option><option value="topup">补足余额</option></select></Field>
      </div>
      {form.asset === "erc20" ? <Field label="代币地址"><input value={form.tokenAddress} onChange={(event) => setForm("tokenAddress", event.target.value)} /></Field> : null}
      <div className="formGrid two">
        <Field label="金额"><input value={form.amount} onChange={(event) => setForm("amount", event.target.value)} disabled={form.amountMode === "topup"} /></Field>
        <Field label="目标余额"><input value={form.targetBalance} onChange={(event) => setForm("targetBalance", event.target.value)} disabled={form.amountMode !== "topup"} /></Field>
      </div>
      <Field label="执行方式"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">顺序执行</option><option value="burst">并发执行</option></select></Field>
      <WalletMultiPicker
        title="接收钱包"
        wallets={wallets}
        chainId={chain?.id}
        selectedIds={receiverIds}
        blockedIds={[form.fromId]}
        onChange={(ids) => setForm("targetIds", ids.filter((id) => id !== form.fromId))}
      />
    </OperationPanel>
  )
}

function ManyToOneView({ wallets, chain, form, setForm, holdings, onQuery, onReset, onPlan, onExecute, busy }) {
  const rows = holdings.data?.holdings?.rows || []
  const positiveRows = rows.filter((row) => BigInt(row.count || 0) > 0n)
  const selected = new Set(form.holdingIds)
  const allSelected = positiveRows.length > 0 && positiveRows.every((row) => selected.has(row.id))
  const canQuery = form.sourceIds.length > 0 && /^0x[a-fA-F0-9]{40}$/.test(form.contractAddress)
  const canSubmit = Boolean(form.snapshotId && form.holdingIds.length && /^0x[a-fA-F0-9]{40}$/.test(form.destination))
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]))

  function setSources(ids) {
    setForm("sourceIds", ids)
    onReset()
  }

  function setContract(value) {
    setForm("contractAddress", value)
    onReset()
  }

  function toggleHolding(id) {
    setForm("holdingIds", selected.has(id) ? form.holdingIds.filter((value) => value !== id) : [...form.holdingIds, id])
  }

  function toggleAllHoldings() {
    setForm("holdingIds", allSelected ? [] : positiveRows.map((row) => row.id))
  }

  return (
    <div className="sectionStack tokenCollectWorkbench">
      <div className="sectionHeader compactHeader">
        <div><h1>归集代币</h1><p>{chain?.name} · 已选择 {form.sourceIds.length} 个来源钱包</p></div>
        <div className="actions"><Button icon={ListChecks} onClick={onPlan} busy={busy} disabled={!canSubmit}>生成归集计划</Button><Button icon={ArrowDownToLine} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>归集所选代币</Button></div>
      </div>

      <WalletTableSelector wallets={wallets} selectedIds={form.sourceIds} onChange={setSources} chainId={chain?.id} title="账户" compact />

      <div className="tokenCollectFields">
        <Field label="接收地址"><input value={form.destination} onChange={(event) => setForm("destination", event.target.value)} placeholder="0x 接收全部代币的地址" spellCheck="false" /></Field>
        <Field label="筛选合约"><input value={form.contractAddress} onChange={(event) => setContract(event.target.value)} placeholder="0x ERC20 / ERC721 / ERC1155 合约地址" spellCheck="false" /></Field>
      </div>

      <div className="tokenCollectQueryBar">
        <Button icon={Search} tone="primary" onClick={onQuery} busy={holdings.loading} disabled={!canQuery}>批量查询持仓</Button>
        <div><span>持仓总量</span><strong>{holdings.data ? `${holdings.data.holdings.totalFormatted} ${holdings.data.holdings.symbol}` : "0"}</strong></div>
        {holdings.data ? <small>{holdings.data.holdings.standard} · 查询 {holdings.data.holdings.walletCount} 个钱包 · {new Date(holdings.data.expiresAt).toLocaleTimeString()} 前有效</small> : null}
      </div>

      {holdings.error ? <div className="inlineAlert" role="alert">{uiError(holdings.error)}</div> : null}
      {holdings.data && !holdings.data.holdings.coverageComplete ? <div className="advancedWarning"><ShieldAlert size={15} /><span>合约不支持完整枚举；表格仅列出链上事件可验证的 Token ID，总余额仍来自实时 `balanceOf`。</span></div> : null}

      <div className="tableWrap tokenHoldingsTable">
        <table>
          <thead><tr><th>账户</th><th>地址</th><th>Token ID</th><th>数量</th><th><input type="checkbox" checked={allSelected} onChange={toggleAllHoldings} disabled={!positiveRows.length} aria-label="选择全部持仓" /></th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const wallet = walletById.get(row.walletId)
              const positive = BigInt(row.count || 0) > 0n
              return <tr key={row.id}><td><strong>{wallet?.label || row.walletId}</strong><small>{wallet?.group || row.walletId}</small></td><td><code>{row.address}</code></td><td><code>{row.tokenId ?? "—"}</code></td><td>{row.formatted} {row.standard === "ERC20" ? row.symbol : ""}</td><td><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleHolding(row.id)} disabled={!positive} aria-label={`选择持仓 ${row.id}`} /></td></tr>
            })}
            {!rows.length ? <tr><td colSpan="5" className="miniEmpty">输入合约并查询所选钱包后，这里显示真实持仓</td></tr> : null}
          </tbody>
        </table>
      </div>
      <label className="checkLine"><input type="checkbox" checked={form.preflight} onChange={(event) => setForm("preflight", event.target.checked)} />发送前逐笔执行链上预检</label>
    </div>
  )
}

function ManyToManyView({ wallets, chain, form, setForm, onPlan, onExecute, busy }) {
  const countsMatch = form.senderIds.length > 0 && form.senderIds.length === form.receiverIds.length
  const hasSelfPair = form.senderIds.some((id, index) => id && id === form.receiverIds[index])
  const canSubmit = countsMatch && !hasSelfPair

  return (
    <OperationPanel
      title="多对多转账"
      subtitle={`已配对 ${Math.min(form.senderIds.length, form.receiverIds.length)} 行`}
      actions={<><Button icon={ListChecks} onClick={onPlan} busy={busy} disabled={!canSubmit}>生成计划</Button><Button icon={ArrowRightLeft} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>执行</Button></>}
    >
      <div className="formGrid three">
        <Field label="资产"><select value={form.asset} onChange={(event) => setForm("asset", event.target.value)}><option value="native">{chain?.nativeSymbol || "链币"}</option><option value="erc20">ERC20</option></select></Field>
        <Field label="金额"><input value={form.amount} onChange={(event) => setForm("amount", event.target.value)} /></Field>
        <Field label="执行方式"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">顺序执行</option><option value="burst">并发执行</option></select></Field>
      </div>
      {form.asset === "erc20" ? <Field label="代币地址"><input value={form.tokenAddress} onChange={(event) => setForm("tokenAddress", event.target.value)} /></Field> : null}
      <label className="checkLine"><input type="checkbox" checked={form.preflight} onChange={(event) => setForm("preflight", event.target.checked)} /> 预检</label>
      <div className="walletPickerGrid">
        <WalletMultiPicker title="发送钱包" wallets={wallets} chainId={chain?.id} selectedIds={form.senderIds} onChange={(ids) => setForm("senderIds", ids)} />
        <WalletMultiPicker title="接收钱包" wallets={wallets} chainId={chain?.id} selectedIds={form.receiverIds} onChange={(ids) => setForm("receiverIds", ids)} />
      </div>
      <PairingPreview wallets={wallets} senderIds={form.senderIds} receiverIds={form.receiverIds} amount={form.amount} />
    </OperationPanel>
  )
}

function WalletMultiPicker({ title, wallets, chainId, selectedIds, onChange, blockedIds = [] }) {
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
      <WalletTableSelector wallets={wallets} selectedIds={selectedIds} onChange={onChange} chainId={chainId} title={title} blockedIds={blockedIds} compact />
      <SelectedWalletList wallets={wallets} selectedIds={selectedIds} onRemove={(id) => onChange(selectedIds.filter((selectedId) => selectedId !== id))} onMove={moveSelected} />
    </div>
  )
}

function SelectedWalletList({ wallets, selectedIds, onRemove, onMove }) {
  const selectedWallets = selectedWalletsInOrder(wallets, selectedIds)
  if (!selectedWallets.length) return <div className="selectedWalletList empty">尚未选择钱包</div>

  return (
    <div className="selectedWalletList">
      {selectedWallets.map((wallet, index) => (
        <div key={wallet.id} className="selectedWalletRow">
          <span>{index + 1}</span>
          <strong>{wallet.id}</strong>
          <code>{shortAddress(wallet.address)}</code>
          <div className="rowControls">
            <button type="button" title="上移" onClick={() => onMove(index, -1)} disabled={index === 0}><ChevronUp size={14} /></button>
            <button type="button" title="下移" onClick={() => onMove(index, 1)} disabled={index === selectedWallets.length - 1}><ChevronDown size={14} /></button>
            <button type="button" title="移除" onClick={() => onRemove(wallet.id)}><X size={14} /></button>
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
    ? "请选择本地发送与接收钱包。"
    : !countsMatch
      ? "发送与接收钱包数量必须一致。"
      : hasSelfPair
        ? "同一行的发送与接收钱包不得相同。"
        : `${rows.length} 行已就绪，将按所选顺序配对。`

  return (
    <div className="pairingPreview">
      <div className={countsMatch && !hasSelfPair ? "pairingNotice ok" : "pairingNotice warn"}>{notice}</div>
      {rows.length ? (
        <div className="pairingTable">
          <table>
            <thead>
              <tr><th>#</th><th>发送钱包</th><th>接收钱包</th><th>金额</th></tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const selfPair = row.sender?.id && row.sender.id === row.receiver?.id
                return (
                  <tr key={`${row.sender?.id || "missing-s"}-${row.receiver?.id || "missing-r"}-${index}`} className={selfPair ? "badPair" : ""}>
                    <td>{index + 1}</td>
                    <td>{row.sender ? <><strong>{row.sender.id}</strong><code>{shortAddress(row.sender.address)}</code></> : <span className="muted">缺失</span>}</td>
                    <td>{row.receiver ? <><strong>{row.receiver.id}</strong><code>{shortAddress(row.receiver.address)}</code></> : <span className="muted">缺失</span>}</td>
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

function ApprovalView({ wallets, chain, selectedIds, onSelectedIdsChange, form, setForm, onExecute, busy }) {
  const canSubmit = selectedIds.length > 0 && /^0x[a-fA-F0-9]{40}$/.test(form.tokenAddress) && /^0x[a-fA-F0-9]{40}$/.test(form.spender)
  return (
    <OperationPanel
      title="授权"
      subtitle={`已选择 ${selectedIds.length} 个钱包`}
      actions={<Button icon={ShieldAlert} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>预览并执行</Button>}
    >
      <WalletTableSelector wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} chainId={chain?.id} title="授权钱包" compact />
      <Field label="代币地址"><input value={form.tokenAddress} onChange={(event) => setForm("tokenAddress", event.target.value)} /></Field>
      <Field label="被授权地址"><input value={form.spender} onChange={(event) => setForm("spender", event.target.value)} /></Field>
      <div className="formGrid two">
        <Field label="数量"><input value={form.amount} onChange={(event) => setForm("amount", event.target.value)} disabled={form.revoke} /></Field>
        <Field label="执行方式"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">顺序执行</option><option value="burst">并发执行</option></select></Field>
      </div>
      <label className="checkLine"><input type="checkbox" checked={form.revoke} onChange={(event) => setForm("revoke", event.target.checked)} /> 撤销为零</label>
    </OperationPanel>
  )
}

function ContractView({ selectedIds, form, setForm, onExecute, busy }) {
  const canSubmit = selectedIds.length > 0 && /^0x[a-fA-F0-9]{40}$/.test(form.to) && /^0x([a-fA-F0-9]{2})*$/.test(form.data)
  return (
    <OperationPanel
      title="合约调用"
      subtitle={`已选择 ${selectedIds.length} 个钱包`}
      actions={<Button icon={FileJson} tone="primary" onClick={onExecute} busy={busy} disabled={!canSubmit}>预览并执行</Button>}
    >
      <Field label="合约"><input value={form.to} onChange={(event) => setForm("to", event.target.value)} /></Field>
      <Field label="交易金额（wei）"><input value={form.valueWei} onChange={(event) => setForm("valueWei", event.target.value)} /></Field>
      <Field label="Calldata"><textarea value={form.data} onChange={(event) => setForm("data", event.target.value)} spellCheck="false" /></Field>
      <div className="formGrid two">
        <Field label="执行方式"><select value={form.executionMode} onChange={(event) => setForm("executionMode", event.target.value)}><option value="sequential">顺序执行</option><option value="burst">并发执行</option></select></Field>
        <label className="checkLine inline"><input type="checkbox" checked={form.preflight} onChange={(event) => setForm("preflight", event.target.checked)} /> 预检</label>
      </div>
    </OperationPanel>
  )
}

function NftMintView({
  wallets, selectedIds, form, setForm, chain, job, error, busy, onPreview, onMint, explorerTx, explorerContract,
  monitor, monitorWindow, setMonitorWindow, monitorFilter, setMonitorFilter, monitorQuery, setMonitorQuery,
  language, liveEvents, streamStatus, collection, collectionBusy, collectionSlow, collectionError, onSelectCollection, onUseCollection,
  onUseRecentMint, onSelectedIdsChange, setupNotice, inputsLocked, monitorOnly = false,
}) {
  const selectedWallets = selectedWalletsInOrder(wallets, selectedIds)
  const t = mintCopy
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
    eth_getLogs: "eth_getLogs 区间扫描",
    per_block_eth_getLogs: "eth_getLogs 逐区块扫描",
    block_receipts: "eth_getBlockReceipts",
    transaction_receipts: "逐交易回执",
    mixed_receipts: "混合回执",
  }
  const streamLabel = streamStatus === "connected" ? t.streamConnected : streamStatus === "offline" ? t.streamOffline : t.streamConnecting
  const backlogBlockCount = Number(monitor.data?.backlogBlockCount || 0)
  const monitorOperational = ["live", "catching_up"].includes(monitor.data?.mode) && streamStatus === "connected"
  const monitorStateLabel = backlogBlockCount > 0 ? `${t.catchingUp} · ${formatInteger(backlogBlockCount)} 个区块` : t.liveStatus

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
    <div className={`sectionStack mintWorkspace${monitorOnly ? " monitorOnly" : ""}`}>
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
        </div>
      </div>

      <div className="mintMonitorToolbar">
        <div className="mintMonitorSearch">
          <Search size={15} />
          <input value={monitorQuery} onChange={(event) => setMonitorQuery(event.target.value)} placeholder={t.search} />
        </div>
        <div className="mintSegmented" aria-label="铸造筛选">
          {["all", "mintable", "airdrop"].map((filter) => (
            <button key={filter} type="button" className={monitorFilter === filter ? "active" : ""} onClick={() => setMonitorFilter(filter)}>{t[filter]}</button>
          ))}
        </div>
        <div className="mintTimeFilters" aria-label="时间窗口">
          {[[60, "1m"], [180, "3m"], [300, "5m"], [600, "10m"], [1800, "30m"], [3600, "1h"], [21600, "6h"], [86400, "24h"]].map(([seconds, label]) => (
            <button key={seconds} type="button" className={monitorWindow === seconds ? "active" : ""} onClick={() => setMonitorWindow(seconds)}>{label}</button>
          ))}
        </div>
      </div>

      {monitor.error ? <div className="inlineAlert" role="alert">{monitor.error}</div> : null}
      {monitor.data?.providerError ? (
        <div className="monitorNotice"><RadioTower size={15} /><span>第三方监控源不可用，当前使用所选链 RPC 的真实 NFT 铸造日志。</span></div>
      ) : null}
      {monitor.data?.source === "direct_rpc" ? (
        <div className="monitorDiagnostics" aria-label="实时监控诊断">
          <span className={`streamState ${streamStatus}`}><RadioTower size={13} />{streamLabel}</span>
          <span><strong>{t.scanStrategy}</strong>{strategyLabels[monitor.data?.scanStrategy] || t.unavailable}</span>
          <span><strong>{t.coverage}</strong>{monitor.data?.coverageFromBlock && monitor.data?.latestBlock ? `${formatInteger(monitor.data.coverageFromBlock)} - ${formatInteger(monitor.data.latestBlock)}` : t.unavailable}</span>
          <span><strong>监控更新</strong>{monitor.data?.updatedAt ? formatRelativeTime(new Date(monitor.data.updatedAt).getTime() / 1000, language) : t.unavailable}</span>
          <span><strong>{t.syncStatus}</strong>{backlogBlockCount > 0 ? `${t.catchingUp} · ${formatInteger(backlogBlockCount)} 个区块` : t.synced}</span>
        </div>
      ) : null}
      {monitor.data?.source === "direct_rpc" && monitor.data?.coverageLimited ? (
        <div className="coverageNotice"><ShieldAlert size={14} /><span>{t.limitedHistory}</span></div>
      ) : null}

      <div className="mintMonitorGrid">
        <section className="mintMonitorPanel collectionPanel" aria-label={t.monitor}>
          <div className="mintPanelHeader">
            <div><strong>{t.monitor}</strong><span>{collectionRows.length} 个活跃合集</span></div>
            {monitor.loading ? <RefreshCcw className="spin" size={15} /> : <span className={`liveStatus ${monitor.data?.mode || "starting"}`}>{monitor.data?.mode === "catching_up" ? monitorStateLabel : monitor.data?.mode === "live" ? t.liveStatus : t.degraded}</span>}
          </div>
          <div className="mintCollectionList">
            {collectionRows.map((item, index) => {
              const selected = collection?.address?.toLowerCase() === item.address.toLowerCase()
              return (
                <div key={`${item.chainId}-${item.address}`} className={selected ? "mintCollectionRow active" : "mintCollectionRow"}>
                  <button type="button" className="mintCollectionSelect" onClick={() => onSelectCollection(item)} aria-label={`查看 ${item.name || item.address}`}>
                    <span className="collectionRank">{index + 1}</span>
                    <NftImage
                      src={item.image_url}
                      alt={item.name ? `${item.name} 预览` : "NFT 合集预览"}
                      className="collectionThumb"
                      fallbackSeed={item.address}
                      fallbackLabel={item.symbol || item.name}
                      fallbackTitle={t.noNftMedia}
                    />
                    <span className="collectionCopy">
                      <strong>{item.name || shortAddress(item.address)}</strong>
                      <code>{shortAddress(item.address)}</code>
                      <small><b>{formatInteger(item.recent_mints)} 次铸造</b>{item.is_airdrop ? ` / ${t.airdrop}` : ""}</small>
                    </span>
                  </button>
                  <span className="collectionNumbers">
                    <strong>{item.current_supply == null ? "?" : formatInteger(item.current_supply)} / {item.max_supply == null ? "?" : formatInteger(item.max_supply)}</strong>
                    <small>已铸造 / 总量</small>
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
                <NftImage src={collection.image_url} alt={collection.name ? `${collection.name} 预览` : "NFT 合集预览"} className="detailCollectionImage" fallbackSeed={collection.address} fallbackLabel={collection.symbol || collection.name} fallbackTitle={t.noNftMedia} />
                <div className="collectionDetailCopy">
                  <span>{collection.token_standard || "NFT"}</span>
                  <h2>{collection.name || shortAddress(collection.address)}</h2>
                </div>
                <code className="collectionContractAddress" dir="ltr" title={collection.address}>{collection.address}</code>
                <div className="collectionDetailActions">
                  <a className="btn" href={explorerContract(collection.address, chain?.id)} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span>{t.viewContract}</span></a>
                  {!monitorOnly ? <Button icon={ImagePlus} tone="primary" onClick={() => onUseCollection(collection)} disabled={inputsLocked}>{t.useContract}</Button> : null}
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
                <div><span>{t.floor}</span><strong>{collection.floor_price_eth == null ? t.unavailable : `${collection.floor_price_eth} ${chain?.nativeSymbol || "—"}`}</strong></div>
                <div><span>{t.walletLimit}</span><strong title={collection.max_per_wallet == null ? t.walletLimitUnknownHint : t.walletLimitHint}>{collection.max_per_wallet == null ? t.walletLimitUnknown : formatInteger(collection.max_per_wallet)}</strong></div>
              </div>
              <div className="collectionDetailTitle">
                <strong>{t.recentMints}</strong>
                <span className="collectionDetailState">{collectionBusy ? <RefreshCcw className="spin" size={12} /> : null}{collectionBusy ? (collectionSlow ? t.slowRecent : t.loadingRecent) : collection.source === "provider" ? t.sourceProvider : t.sourceRpc}</span>
              </div>
              <div className="recentMintList">
                {(collection.recent_mints || []).slice(0, 30).map((mint) => (
                  <div className="recentMintRow" key={`${mint.tx_hash}-${mint.token_id}`}>
                    <a className="recentMintTx" href={explorerTx(mint.tx_hash, chain?.id)} target="_blank" rel="noreferrer" aria-label={`${mint.token_name || `#${mint.token_id ?? "?"}`} 交易`}>
                      <NftImage src={mint.image_url || collection.image_url} alt={mint.token_name || `${collection.name || "NFT"} #${mint.token_id ?? "?"}`} className="recentMintImage" fallbackSeed={`${collection.address}${mint.token_id || ""}`} fallbackLabel={collection.symbol || collection.name} fallbackTitle={t.noNftMedia} />
                      <span><strong>{mint.token_name || `#${mint.token_id ?? "?"}`}</strong><code>{shortAddress(mint.to_address)}</code></span>
                      <span className="recentMintMeta">
                        <span className="recentMintPrice">{mint.mint_price || ""}</span>
                        <small>{formatRelativeTime(mint.timestamp, language)}</small>
                        <em className="recentMintGas" title={mint.gas_fee_wei ? `${mint.gas_used || "?"} gas · ${mint.gas_fee_wei} wei` : undefined}>
                          {mint.gas_fee_native ? `${t.gasFee} ${formatNativeFee(mint.gas_fee_native)} ${mint.native_symbol || chain?.nativeSymbol || "—"}` : t.gasPending}
                        </em>
                      </span>
                    </a>
                    {!monitorOnly ? <button className="reuseMintButton" type="button" onClick={() => onUseRecentMint(collection, mint)} title={t.reuseMint} disabled={inputsLocked}><Zap size={13} /><span>{t.reuseMint}</span></button> : null}
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
              monitorOnly ? (
                <div className="liveMintItem monitorEventRow" key={event.id}>
                  <button className="monitorEventLoad" type="button" onClick={() => onSelectCollection(event)}>
                    <span className="monitorEventTop"><strong>{event.tokenName || event.name || shortAddress(event.address)}</strong><time>{formatRelativeTime(event.timestamp, language)}</time></span>
                    <span className="monitorEventTags">
                      <b className={event.isFree ? "free" : "paid"}>{event.isFree ? "免费" : event.mintPrice}</b>
                      <em className={Number(event.gasLimit || 0) > 200000 ? "hot" : ""}>Gas {event.gasLimit ? formatInteger(event.gasLimit) : "—"}</em>
                      <em>{event.selector || "选择器 —"}</em>
                      <em>{event.tokenStandard || "NFT"}</em>
                      {event.platform ? <em>{event.platform}</em> : null}
                    </span>
                    <span className="monitorEventMeta"><code>{shortAddress(event.address)}</code><span>铸造 {event.quantity || "—"}</span><span>供应量 {event.currentSupply == null ? "—" : formatInteger(event.currentSupply)} / {event.maxSupply == null ? "—" : formatInteger(event.maxSupply)}</span><span>{event.parameterCount == null ? "参数 —" : `${event.parameterCount} 参数字`}</span></span>
                  </button>
                  <a className="monitorEventLink" href={explorerTx(event.txHash, event.chainId)} target="_blank" rel="noreferrer" title={t.viewTransaction} aria-label={`${event.name || event.address} ${t.viewTransaction}`}><ExternalLink size={13} /></a>
                </div>
              ) : (
                <a className="liveMintItem" key={event.id} href={explorerTx(event.txHash, event.chainId)} target="_blank" rel="noreferrer" title={t.viewTransaction} aria-label={`${event.tokenName || event.name || shortAddress(event.address)} · ${t.viewTransaction}`}>
                  <span className="liveMintCopy"><strong>{event.tokenName || event.name || shortAddress(event.address)}</strong><small>{event.quantity} 次铸造 / {event.mintPrice}</small><code>{event.tokenIds?.[0] ? `#${event.tokenIds[0]} / ` : ""}{shortAddress(event.recipient)}</code></span>
                  <span className="liveMintCost"><time>{formatRelativeTime(event.timestamp, language)}</time><span className="liveMintHoverHint" aria-hidden="true"><ExternalLink size={11} />{t.viewTransaction}</span></span>
                </a>
              )
            ))}
            {!visibleEvents.length ? <div className="mintMonitorEmpty">{t.waiting}</div> : null}
          </div>
        </section>
      </div>

      {!monitorOnly ? <>
      <div className="sectionHeader mintExecutionHeader" id="mint-setup">
        <div><h2>{t.execute}</h2><p>已在 {chain?.name || "当前链"} 选择 {selectedIds.length} 个钱包。预览为可选操作；铸造始终会重新执行自动预检。</p></div>
        <div className="mintSetupActions">
          <Button icon={ListChecks} onClick={onPreview} busy={busy} disabled={!selectedIds.length || job?.status === "sending"}>预览</Button>
          <Button icon={Zap} tone="danger" onClick={onMint} busy={busy} disabled={!selectedIds.length || !form.contractAddress || job?.status === "sending"}>铸造</Button>
        </div>
      </div>
      <WalletGroupQuickSelect wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} label="快速选择分组" disabled={inputsLocked} />
      <div className="operationForm mintExecutionForm">
      {inputsLocked ? <div className="setupAppliedNotice mintInputLock" role="status"><RefreshCcw className="spin" size={14} />铸造交易正在发送；钱包、链和交易参数已锁定，任务状态会持续更新。</div> : null}
      <div className="mintIntro">
        <ShieldAlert size={18} />
        <div>
          <strong>铸造会自动执行预检</strong>
          <p>预览为可选操作。铸造会重新生成并验证链、字节码、calldata、Gas、余额和金额上限，然后在广播前再次确认。</p>
        </div>
      </div>

      {setupNotice ? <div className="setupAppliedNotice" role="status"><Check size={14} />{setupNotice}</div> : null}

      <div className="mintFormGrid">
        <Field label="NFT 合约" hint="顶部栏所选链上的合集合约。">
          <input value={form.contractAddress} onChange={(event) => setForm("contractAddress", event.target.value)} placeholder="0x..." autoComplete="off" spellCheck="false" disabled={inputsLocked} />
        </Field>
        <div className="formGrid three">
          <Field label="每钱包数量">
            <input type="number" min="1" max="1000" value={form.quantity} onChange={(event) => setForm("quantity", event.target.value)} inputMode="numeric" disabled={inputsLocked} />
          </Field>
          <Field label="代币编号" hint="标准合集铸造使用 0。">
            <input type="number" min="0" value={form.tokenId} onChange={(event) => setForm("tokenId", event.target.value)} inputMode="numeric" disabled={inputsLocked} />
          </Field>
          <Field label="并发数" hint="0 表示使用全部钱包，最多 32。">
            <input type="number" min="0" max="32" value={form.concurrency} onChange={(event) => setForm("concurrency", event.target.value)} inputMode="numeric" disabled={inputsLocked} />
          </Field>
        </div>
        <Field label={`每钱包最大铸造金额（${chain?.nativeSymbol || "—"}）`} hint="可选的铸造金额硬上限；预计 Gas 会单独检查。">
          <input value={form.maxMintCostEth} onChange={(event) => setForm("maxMintCostEth", event.target.value)} placeholder="可选，例如 0.05" inputMode="decimal" disabled={inputsLocked} />
        </Field>
      </div>

      <div className="mintWalletStrip" aria-label="已选择的铸造钱包">
        <div>
          <strong>已选择钱包</strong>
          <span>{selectedWallets.length ? `${selectedWallets.length} 个本地钱包` : "请从工作区选择钱包"}</span>
        </div>
        <div className="mintWalletChips">
          {selectedWallets.slice(0, 8).map((wallet) => (
            <span key={wallet.id}><strong>{wallet.id}</strong><code>{shortAddress(wallet.address)}</code></span>
          ))}
          {selectedWallets.length > 8 ? <span className="moreWallets">另有 {selectedWallets.length - 8} 个</span> : null}
        </div>
      </div>

      {error ? <div className="inlineAlert" role="alert">{uiError(error)}</div> : null}

      {job ? (
        <div className="mintPreview" aria-live="polite">
          <div className="mintPreviewHeader">
            <div>
              <h2>钱包预检</h2>
              <p>{job.chainName} 合约 {shortAddress(job.contractAddress)}，预览将在 {new Date(job.expiresAt).toLocaleTimeString()} 过期。</p>
            </div>
            <span className={`pill ${job.status}`}>{uiStatus(job.status)}</span>
          </div>

          <div className="mintSummary">
            <div><span>可执行</span><strong>{job.summary.eligible ?? job.summary.ready}</strong></div>
            <div><span>已跳过</span><strong>{job.summary.skipped}</strong></div>
            <div><span>失败</span><strong>{job.summary.failed}</strong></div>
            <div><span>铸造金额</span><strong>{formatEthCompact(readyTotal)} {job.nativeSymbol}</strong></div>
          </div>

          <div className="tableWrap mintPlanTable">
            <table>
              <thead>
                <tr><th>状态</th><th>钱包</th><th>铸造金额</th><th>Gas 估算</th><th>总需求</th><th>目标 / 结果</th></tr>
              </thead>
              <tbody>
                {job.wallets.map((wallet) => (
                  <tr key={wallet.walletId}>
                    <td><span className={`pill ${wallet.status}`}>{uiStatus(wallet.status)}</span></td>
                    <td><strong>{wallet.walletId}</strong><code className="subCell">{shortAddress(wallet.address)}</code></td>
                    <td>{wallet.transaction ? `${formatEthCompact(wallet.transaction.valueEth)} ${job.nativeSymbol}` : <span className="muted">不可用</span>}</td>
                    <td>{wallet.estimatedGas || <span className="muted">不可用</span>}</td>
                    <td>{wallet.estimatedTotalEth ? `${formatEthCompact(wallet.estimatedTotalEth)} ${job.nativeSymbol}` : <span className="muted">不可用</span>}</td>
                    <td>
                      {wallet.txHash ? (
                        <a href={explorerTx(wallet.txHash, job.chainId)} target="_blank" rel="noreferrer"><code>{shortAddress(wallet.txHash)}</code></a>
                      ) : wallet.transaction ? (
                        <><code>{shortAddress(wallet.transaction.to)}</code><span className="subCell">交易操作</span></>
                      ) : null}
                      {wallet.reason ? <span className={`mintReason ${wallet.status}`}>{uiError(wallet.reason)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {job.status === "previewed" ? <div className="mintPreviewOnly"><ListChecks size={15} /><span>这是只读预览。使用上方铸造按钮重新执行预检，并在确认后广播。</span></div> : null}

          {job.status === "sending" ? <div className="mintProgress"><RefreshCcw className="spin" size={16} />正在签名、广播并确认钱包交易…</div> : null}
          {terminal ? <div className={`mintProgress ${job.status}`}>{job.status === "completed" ? <Check size={16} /> : <ShieldAlert size={16} />}铸造批次{uiStatus(job.status)}，请检查上方每个钱包的结果。</div> : null}
        </div>
      ) : (
        <div className="emptyState mintEmpty"><ImagePlus size={20} />请输入或套用铸造参数。预览仅检查；铸造会在确认前重新执行预检。</div>
      )}
      </div>
      </> : null}
    </div>
  )
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "无"
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
          <h1>脚本控制</h1>
          <p>铸造运行器与 Robinhood RPC</p>
        </div>
        <div className="actions">
          <Button icon={RefreshCcw} onClick={() => Promise.all([onRefresh(), onRefreshResults()]).catch(() => {})} busy={busy}>刷新</Button>
          <Button icon={RadioTower} onClick={onTestRpc} busy={busy}>RPC 测试</Button>
        </div>
      </div>

      {error ? <div className="inlineAlert" role="alert">{uiError(error)}</div> : null}

      <div className="runnerMetrics">
        <div className="runnerMetric">
          <span className={`statusDot ${state}`}></span>
          <div>
            <small>状态</small>
            <strong>{running ? "运行中" : state === "done" ? "就绪" : state === "failed" ? "失败" : "空闲"}</strong>
          </div>
        </div>
        <div className="runnerMetric">
          <Terminal size={17} />
          <div>
            <small>模式</small>
            <strong>{status?.mode === "armed" ? "实盘" : status?.mode === "dry-run" ? "演练" : "无"}</strong>
          </div>
        </div>
        <div className="runnerMetric">
          <Wallet size={17} />
          <div>
            <small>钱包</small>
            <strong>{config.walletCount || 0}</strong>
          </div>
        </div>
        <div className="runnerMetric">
          <Server size={17} />
          <div>
            <small>RPC p50</small>
            <strong>{rpcTest?.p50Ms ? `${rpcTest.p50Ms} 毫秒` : "未测试"}</strong>
          </div>
        </div>
      </div>

      <div className="scriptGrid">
        <div className="operationForm">
          <h2>运行器</h2>
          <div className="runnerState">
            <div><span>进程号</span><strong>{status?.pid || "无"}</strong></div>
            <div><span>启动时间</span><strong>{formatDateTime(status?.startedAt)}</strong></div>
            <div><span>退出时间</span><strong>{formatDateTime(status?.exitedAt)}</strong></div>
            <div><span>退出状态</span><strong>{status?.exitCode ?? status?.signal ?? "无"}</strong></div>
          </div>
          <div className="formGrid two">
            <Button icon={Play} tone="primary" onClick={() => onStart("dry-run")} busy={busy} disabled={running}>演练</Button>
            <Button icon={Square} tone="danger" onClick={onStop} busy={busy} disabled={!running}>停止</Button>
          </div>
          <div className="formGrid two">
            <Field label="执行确认">
              <input value={armConfirm} onChange={(event) => setArmConfirm(event.target.value)} placeholder="确认执行" />
            </Field>
            <Button icon={Zap} tone="danger" onClick={() => onStart("armed")} busy={busy} disabled={running || armConfirm !== "确认执行"}>开始实盘</Button>
          </div>
        </div>

        <div className="operationForm">
          <h2>配置</h2>
          <div className="configList">
            <span>钱包来源</span><strong>{config.walletSource || "未知"}</strong>
            <span>主代理</span><strong>{config.proxyFileLines ?? 0}/{config.staticProxyCount ?? 0}</strong>
            <span>备用代理</span><strong>{config.proxyReserveLines ?? 0}</strong>
            <span>动态代理</span><strong>{config.dynamicProxyCount ?? 0}</strong>
            <span>代理超时</span><strong>{config.proxyCheckTimeoutMs || 0} 毫秒</strong>
            <span>替换次数</span><strong>{config.proxyMaxReplacements || 0}</strong>
            <span>并发数</span><strong>{config.mintConcurrency || 0}</strong>
            <span>RPC 主机</span><strong>{config.rpcHost || "未知"}</strong>
          </div>
        </div>
      </div>

      <div className="operationForm">
        <div className="formTitleRow">
          <h2>铸造交易</h2>
          <small>{results?.updatedAt ? `更新于 ${new Date(results.updatedAt).toLocaleTimeString()}` : "等待运行结果"}</small>
        </div>
        <div className="runnerState mintSummaryGrid">
          <div><span>记录数</span><strong>{mintSummary.totalRows ?? 0}</strong></div>
          <div><span>已铸造</span><strong>{mintSummary.minted ?? 0}</strong></div>
          <div><span>失败 / 待检查</span><strong>{mintSummary.failedOrInspection ?? 0}</strong></div>
          <div><span>Gas 总费用</span><strong>{formatEthCompact(mintSummary.totalFeeEth)} ETH</strong></div>
          <div><span>此前已铸造</span><strong>{mintSummary.alreadyMinted ?? 0}</strong></div>
          <div><span>演练就绪</span><strong>{mintSummary.dryRunReady ?? 0}</strong></div>
          <div><span>回执成功</span><strong>{mintSummary.receiptSuccess ?? 0}</strong></div>
          <div><span>含 Gas 记录</span><strong>{mintSummary.gasRows ?? 0}</strong></div>
        </div>
        {mintRows.length ? (
          <div className="tableWrap mintResultsTable">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>钱包</th>
                  <th>状态</th>
                  <th>交易</th>
                  <th>回执</th>
                  <th>Gas 用量</th>
                  <th>费用</th>
                  <th>错误</th>
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
                      <td><span className={`pill ${statusTone(row.status)}`}>{uiStatus(row.status)}</span></td>
                      <td>
                        {row.txHash ? (
                          <a href={txHref || "#"} target="_blank" rel="noreferrer">
                            <code>{shortAddress(row.txHash)}</code>
                          </a>
                        ) : <span className="muted">无</span>}
                      </td>
                      <td>
                        {receiptStatus ? <span className={`pill ${statusTone(receiptStatus)}`}>{uiStatus(receiptStatus)}</span> : <span className="muted">不适用</span>}
                        {row.receipt?.blockNumber ? <small className="subCell">#{row.receipt.blockNumber}</small> : null}
                      </td>
                      <td>{row.receipt?.gasUsed ? formatInteger(row.receipt.gasUsed) : <span className="muted">不适用</span>}</td>
                      <td>
                        {row.receipt?.feeEth ? (
                          <>
                            <span>{formatEthCompact(row.receipt.feeEth)} ETH</span>
                            <small className="subCell">{formatGwei(row.receipt.effectiveGasPriceGwei)} gwei</small>
                          </>
                        ) : <span className="muted">不适用</span>}
                      </td>
                      <td>{row.error || row.receipt?.error ? uiError(row.error || row.receipt?.error) : <span className="muted">无</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState"><Activity size={18} />暂无铸造交易记录</div>
        )}
      </div>

      <div className="scriptGrid">
        <div className="operationForm">
          <h2>RPC 延迟</h2>
          {rpcTest ? (
            <>
              <div className="runnerState">
                <div><span>成功</span><strong>{rpcTest.successCount}/{rpcTest.samples}</strong></div>
                <div><span>最小值</span><strong>{rpcTest.minMs ?? "不适用"} 毫秒</strong></div>
                <div><span>第 90 百分位</span><strong>{rpcTest.p90Ms ?? "不适用"} 毫秒</strong></div>
                <div><span>区块</span><strong>{rpcTest.latestBlock || "不适用"}</strong></div>
              </div>
              <div className="latencyRows">
                {rpcTest.results.map((item, index) => (
                  <span key={`${item.ms}-${index}`} className={item.ok ? "ok" : "bad"}>
                    {index + 1}: {item.ok ? `${item.ms} 毫秒` : uiError(item.error)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="emptyState"><RadioTower size={18} />暂无 RPC 样本</div>
          )}
        </div>

        <div className="operationForm">
          <h2>命令</h2>
          <div className="commandBox">
            <code>{status?.command || "无"}</code>
          </div>
        </div>
      </div>

      <div className="operationForm">
        <h2>日志</h2>
        {logs.length ? (
          <div className="logBox" role="log" aria-live="polite">
            {logs.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className={entry.stream}>
                <span>{new Date(entry.at).toLocaleTimeString()}</span>
                <strong>{entry.stream === "stdout" ? "标准输出" : entry.stream === "stderr" ? "错误输出" : "系统"}</strong>
                <code>{entry.line}</code>
              </div>
            ))}
          </div>
        ) : (
          <div className="emptyState"><Terminal size={18} />暂无运行日志</div>
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
          <h1>交易记录</h1>
          <p>最近 {transactions.length} 条记录</p>
        </div>
      </div>
      <div className="tableWrap">
        <table>
          <thead>
            <tr><th>状态</th><th>钱包</th><th>类型</th><th>哈希</th><th>摘要</th><th>时间</th></tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td><span className={`pill ${tx.status}`}>{uiStatus(tx.status)}</span></td>
                <td>{tx.walletId}</td>
                <td>{uiTransactionType(tx.type)}</td>
                <td>{tx.txHash ? <a href={explorerTx(tx.txHash, tx.chainId)} target="_blank" rel="noreferrer"><code>{shortAddress(tx.txHash)}</code></a> : <span className="muted">无</span>}</td>
                <td>{tx.error ? uiError(tx.error) : tx.summary || "—"}</td>
                <td>{new Date(tx.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
