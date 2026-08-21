import {
  AlertTriangle,
  Bell,
  Box,
  Blocks,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Edit3,
  ExternalLink,
  Flag,
  Flame,
  Globe2,
  Hash,
  Link2,
  ListFilter,
  Layers3,
  RadioTower,
  RefreshCcw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Twitter,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import AdvancedMintView from "./AdvancedMintView.jsx"
import { WalletGroupQuickSelect } from "./WalletTableSelector.jsx"
import { mergeSnapshotIntoEvent } from "./collection-snapshot.js"
import { liveFeedOrderSnapshot, visibleLiveFeedEvents } from "./live-feed.js"
import { mintQuantityFromEvent, validateQuickMintQuantity } from "./live-mint-quantity.js"
import {
  TRENDING_WINDOWS,
  buildRadarAdvancedMintSeed,
  collectionsWithFlags,
  deployerRiskProfile,
  filterRadarDrops,
  formatRadarCountdown,
  formatRadarDateTime,
  radarDropTiming,
} from "./monitor-intelligence.js"
import { formatRelativeTime } from "./relative-time.js"
import { uiError, uiStatus } from "./ui-text.js"

const FILTER_KEY = "611nft:live-mint-filters"
const EMPTY_FILTERS = {
  keyword: "",
  blockedKeywords: "",
  blockedPlatforms: "",
  hideFree: false,
  hidePaid: false,
  hideAirdrop: false,
  hideErc1155: false,
  hideHighGas: false,
  hideUnknownSupply: false,
  pendingOnly: false,
  showFlagged: false,
}

function initialFilters() {
  try {
    return { ...EMPTY_FILTERS, ...JSON.parse(localStorage.getItem(FILTER_KEY) || "{}") }
  } catch {
    return EMPTY_FILTERS
  }
}

function short(value, head = 6, tail = 4) {
  return value ? `${value.slice(0, head)}...${value.slice(-tail)}` : "—"
}

function normalizeUrl(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^\/\//.test(raw)) return `https:${raw}`
  if (/^(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(raw)) return `https://${raw}`
  return ""
}

function linkItems(event, { explorerTx, explorerContract, explorerBlock }) {
  return [
    { key: "x", label: "X", title: "X 项目主页", href: normalizeUrl(event.twitter || event.x || event.twitterUrl || event.xUrl), Icon: Twitter },
    { key: "website", label: "官网", title: "官方网站", href: normalizeUrl(event.website || event.websiteUrl), Icon: Link2 },
    { key: "opensea", label: "OpenSea", title: "OpenSea", href: event.openseaVerified || event.opensea_verified ? normalizeUrl(event.opensea_url || event.openseaUrl || event.opensea) : "", Icon: ShoppingBag },
    { key: "contract", label: "合约", title: "查看合约", href: explorerContract?.(event.address, event.chainId), Icon: Globe2 },
    { key: "block", label: "区块", title: "查看区块", href: explorerBlock?.(event.blockNumber || event.contractCreatedBlock, event.chainId), Icon: Hash },
    { key: "tx", label: "交易", title: "查看交易", href: explorerTx?.(event.txHash, event.chainId), Icon: ExternalLink },
  ].filter((item) => item.href)
}

function integer(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : String(value)
}

function compactNative(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  if (number === 0) return "0"
  if (number < 0.000001) return number.toExponential(2)
  return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
}

function createdLabel(value) {
  if (!value) return "创建：未知"
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return "创建：未知"
  return `创建：${formatRelativeTime(timestamp / 1000, "zh")}`
}

function pendingLabel(event, compact = false) {
  const coverage = event.pendingCoverage || event.pending_coverage || event.collection_snapshot?.pending_coverage
  const count = event.pendingCount ?? event.pending_count ?? event.collection_snapshot?.pending_token_count
  const unknown = Number(event.pendingUnknownTxCount ?? event.pending_unknown_tx_count ?? event.collection_snapshot?.pending_unknown_tx_count ?? 0)
  if (coverage === "unavailable" || count === null || count === undefined) return compact ? "未知" : "待确认 —"
  const partial = coverage === "partial"
  const prefix = partial || unknown > 0 ? "至少 " : ""
  const details = [
    ...(unknown > 0 ? [`另有 ${unknown} 笔数量未知`] : []),
    ...(partial ? ["部分来源"] : coverage === "observed" ? ["已观测来源"] : []),
  ]
  const suffix = details.length ? `，${details.join("，")}` : ""
  return compact ? `${prefix}${integer(count)} 个${suffix}` : `${prefix}${integer(count)} 个待确认${suffix}`
}

function tokenRangeLabel(event) {
  const start = event.tokenIdRange?.start
  const end = event.tokenIdRange?.end
  if (start === null || start === undefined || start === "") return ""
  if (end === null || end === undefined || end === "" || String(start) === String(end)) return `#${start}`
  return `#${start}–#${end}`
}

function RealtimeSparkline({ samples }) {
  const values = (samples || []).map(Number).filter(Number.isFinite).slice(-60)
  if (!values.length) return <span className="liveRateSparkline empty" aria-label="等待速率样本" />
  const width = 124
  const height = 24
  const maximum = Math.max(...values)
  const minimum = Math.min(...values)
  const range = maximum - minimum || 1
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width
    const y = height - 2 - ((value - minimum) / range) * (height - 4)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(" ")
  return (
    <svg className="liveRateSparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`最近 ${values.length} 个真实 MINT/S 样本`} preserveAspectRatio="none">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function RealtimeMeter({ realtime }) {
  const rate = Number(realtime?.mintRate)
  const latency = Number(realtime?.latencyMs)
  const hasRate = realtime?.mintRate !== null && realtime?.mintRate !== undefined && Number.isFinite(rate)
  const hasLatency = realtime?.latencyMs !== null && realtime?.latencyMs !== undefined && Number.isFinite(latency)
  const source = String(realtime?.source || "")
  return (
    <div className="liveRateMeter" title={source || "等待实时数据源"}>
      <span><small>MINT/S</small><strong>{hasRate ? rate.toFixed(2) : "—"}</strong></span>
      <RealtimeSparkline samples={realtime?.rateSamples} />
      <span className="liveRateHealth"><small>{hasLatency ? `${Math.round(latency)} ms` : "— ms"}</small><strong>{source || "等待数据源"}</strong></span>
    </div>
  )
}

function tagsFor(event) {
  const values = [
    ...(event.fundingTags || []).map((label) => ({ label, type: "funding" })),
    ...(event.platformTags || []).map((label) => ({ label, type: "platform" })),
    ...(event.statusTags || []).map((label) => ({ label, type: "status" })),
  ]
  if (event.platform && !values.some((item) => item.label.toLowerCase() === event.platform.toLowerCase())) {
    values.push({ label: event.platform, type: "platform" })
  }
  return values.filter((item, index) => values.findIndex((candidate) => candidate.label === item.label) === index)
}

function eventMatches(event, filters) {
  const search = filters.keyword.trim().toLowerCase()
  const haystack = `${event.name || ""} ${event.tokenName || ""} ${event.address || ""} ${event.methodName || ""}`.toLowerCase()
  if (search && !haystack.includes(search)) return false
  const blockedWords = filters.blockedKeywords.split(/[,，\n]/).map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (blockedWords.some((word) => haystack.includes(word))) return false
  const eventPlatforms = tagsFor(event).filter((tag) => tag.type === "platform").map((tag) => tag.label.toLowerCase())
  const blockedPlatforms = filters.blockedPlatforms.split(/[,，\n]/).map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (blockedPlatforms.some((platform) => eventPlatforms.some((value) => value.includes(platform)))) return false
  if (filters.hideFree && event.isFree) return false
  if (filters.hidePaid && !event.isFree && event.mintValueWei !== null) return false
  if (filters.hideAirdrop && event.isAirdrop) return false
  if (filters.hideErc1155 && event.tokenStandard === "ERC1155") return false
  if (filters.hideHighGas && Number(event.gasLimit || 0) > 200000) return false
  if (filters.hideUnknownSupply && event.maxSupply == null) return false
  if (filters.pendingOnly && !(Number(event.pendingCount) > 0 || Number(event.pendingUnknownTxCount) > 0)) return false
  return true
}

function FallbackAvatar({ nested = false }) {
  return <span className={nested ? "liveMintAvatarFallback" : "liveMintAvatar liveMintAvatarFallback"} title="暂无可验证的项目标志"><Box size={15} aria-hidden="true" /></span>
}

function MintImageLoader({ event, sources }) {
  const [sourceIndex, setSourceIndex] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const imageRef = useRef(null)
  const source = sources[sourceIndex]
  const sourceKey = sources.join("\n")
  useEffect(() => {
    setSourceIndex(0)
    setLoaded(false)
  }, [sourceKey])
  useEffect(() => {
    if (imageRef.current?.complete && imageRef.current.naturalWidth > 0) setLoaded(true)
  }, [source, sourceKey])
  if (!source) return <FallbackAvatar event={event} />
  const advance = () => {
    setLoaded(false)
    setSourceIndex((index) => index + 1)
  }
  const projectName = event.name || event.tokenName || short(event.address)
  return <span className="liveMintAvatar liveMintAvatarMedia"><FallbackAvatar nested /><img ref={imageRef} key={source} className={loaded ? "loaded" : ""} src={source} alt={`${projectName} 项目标志`} loading="eager" fetchPriority="high" decoding="async" onLoad={() => setLoaded(true)} onError={advance} /></span>
}

function MintImage({ event }) {
  const sources = [...new Set([
    event.projectImageUrl,
    event.imageUrl,
    event.image_url,
    event.imageFallbackUrl,
    event.image_fallback_url,
  ].map((value) => String(value || "").trim()).filter(Boolean))]
  return <MintImageLoader key={sources.join("\n")} event={event} sources={sources} />
}

function Toggle({ checked, children, onChange }) {
  return <label className="liveFilterToggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{children}</span></label>
}

function ScreenSettings({ filters, setFilter, onReset, onClose }) {
  return (
    <div className="liveScreenSettings" role="dialog" aria-label="实时铸造屏蔽设置">
      <div className="liveScreenHeader"><strong>屏蔽设置</strong><button type="button" onClick={onClose} aria-label="关闭屏蔽设置"><X size={14} /></button></div>
      <div className="liveScreenToggles">
        <Toggle checked={filters.hideFree} onChange={(value) => setFilter("hideFree", value)}>隐藏免费</Toggle>
        <Toggle checked={filters.hidePaid} onChange={(value) => setFilter("hidePaid", value)}>隐藏付费</Toggle>
        <Toggle checked={filters.hideAirdrop} onChange={(value) => setFilter("hideAirdrop", value)}>隐藏空投</Toggle>
        <Toggle checked={filters.hideErc1155} onChange={(value) => setFilter("hideErc1155", value)}>隐藏 ERC-1155</Toggle>
        <Toggle checked={filters.hideHighGas} onChange={(value) => setFilter("hideHighGas", value)}>隐藏 Gas &gt; 20万</Toggle>
        <Toggle checked={filters.hideUnknownSupply} onChange={(value) => setFilter("hideUnknownSupply", value)}>隐藏未知总量</Toggle>
        <Toggle checked={filters.pendingOnly} onChange={(value) => setFilter("pendingOnly", value)}>仅看待处理</Toggle>
        <Toggle checked={filters.showFlagged} onChange={(value) => setFilter("showFlagged", value)}>显示个人标记</Toggle>
      </div>
      <label><span>屏蔽关键词</span><input value={filters.blockedKeywords} onChange={(event) => setFilter("blockedKeywords", event.target.value)} placeholder="名称、地址或方法，逗号分隔" /></label>
      <label><span>屏蔽平台</span><input value={filters.blockedPlatforms} onChange={(event) => setFilter("blockedPlatforms", event.target.value)} placeholder="平台标签，逗号分隔" /></label>
      <button className="liveScreenReset" type="button" onClick={onReset}>重置全部</button>
    </div>
  )
}

function StatusStrip({ chain, chains, chainId, onChainChange, monitor, realtime, streamStatus, onOpenSettings }) {
  const metrics = monitor.data?.chainMetrics || {}
  const maxFee = metrics.maxFeeGwei || metrics.explorerGasGwei?.fast || metrics.gasPriceGwei
  const priority = metrics.priorityFeeGwei
  const base = metrics.baseFeeGwei
  const live = streamStatus === "connected" && ["live", "catching_up"].includes(monitor.data?.mode)
  return (
    <div className="liveStatusStrip">
      <span className={live ? "liveStreamState active" : "liveStreamState"}><i />{live ? "实时" : "同步"}</span>
      <span title="当前区块"><Box size={14} />{integer(metrics.blockNumber || monitor.data?.chainHeadBlock)}</span>
      <span title="链上最优 Gas"><Flame size={14} />最高费：{maxFee ?? "—"}</span>
      <span>优先费：{priority ?? "—"}{base ? `（基础费：${base}）` : ""}</span>
      <span title={`${chain?.nativeSymbol || "当前链币种"} 美元价格`}><CircleDollarSign size={14} />${metrics.coinPriceUsd ? Number(metrics.coinPriceUsd).toFixed(2) : "—"}</span>
      <RealtimeMeter realtime={realtime} />
      <label className="liveChainSelect"><select value={chainId} onChange={(event) => onChainChange(Number(event.target.value))}>{chains.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={13} /></label>
      <button className="liveSettingsButton" type="button" onClick={onOpenSettings}><SlidersHorizontal size={14} />屏蔽设置</button>
    </div>
  )
}

function DeployerRiskBadge({ value, detailed = false }) {
  const profile = deployerRiskProfile(value)
  if (!profile) return detailed ? <span className="deployerRiskBadge unknown"><ShieldAlert size={12} />部署者画像待回填</span> : null
  const age = profile.walletAgeDays === null ? "年龄未知" : `${integer(profile.walletAgeDays)} 天`
  const projects = profile.nftProjectCount === null ? "项目未知" : `${integer(profile.nftProjectCount)} 个 NFT 项目`
  return (
    <span className={`deployerRiskBadge ${profile.risky ? "risky" : "clear"}`} title={profile.reasons.join(" · ") || "未命中部署者风险阈值"}>
      {profile.risky ? <ShieldAlert size={12} /> : <CheckCircle2 size={12} />}
      {detailed ? <><code>{short(profile.address)}</code><b>{age}</b><b>{projects}</b></> : <span>{age} · {projects}</span>}
    </span>
  )
}

function PersonalFlagButton({ item, onToggleFlag, busyAddress = "" }) {
  const address = String(item?.address || item?.contract || "").toLowerCase()
  const active = Boolean(item?.personalFlag)
  return (
    <button
      className={`liveFlagButton ${active ? "active" : ""}`}
      type="button"
      onClick={() => void Promise.resolve(onToggleFlag?.(item)).catch(() => {})}
      disabled={!address || busyAddress === address}
      title={active ? "移除个人风险标记" : "标记并默认隐藏该合集"}
      aria-label={active ? "移除个人风险标记" : "添加个人风险标记"}
    >
      {busyAddress === address ? <RefreshCcw className="spin" size={13} /> : <Flag size={13} />}
    </button>
  )
}

function EventTags({ event }) {
  const tags = tagsFor(event)
  if (!tags.length) return null
  return <span className="liveEventIntelTags">{tags.map((tag) => <b className={tag.type} key={`${tag.type}-${tag.label}`}>{tag.label}</b>)}</span>
}

function LiveEventRow({ event, selected, chain, explorerTx, explorerContract, explorerBlock, onSelect, onToggleFlag, flagBusyAddress }) {
  const hotGas = Number(event.gasLimit || 0) > 200000
  const links = linkItems(event, { explorerTx, explorerContract, explorerBlock })
  const tokenRange = tokenRangeLabel(event)
  return (
    <article
      className={`${selected ? "liveEventRow selected" : "liveEventRow"}${hotGas ? " highGas" : ""}`}
      data-event-id={event.id}
      data-collection-version={event.collection_snapshot?.version ?? -1}
    >
      <button className="liveEventMain" type="button" onClick={() => onSelect(event)}>
        <span className="liveEventCreated"><span>{createdLabel(event.contractCreatedAt)}</span>{event.batchId ? <b className="liveBatchCount">×{integer(event.count)}</b> : null}{tokenRange ? <code className="liveTokenRange">{tokenRange}</code> : null}<small>每次铸造：{event.quantity || "—"}</small></span>
        <span className="liveEventIdentity"><MintImage event={event} /><span><strong>{event.name || event.tokenName || short(event.address)}</strong><code>{short(event.address)}</code></span></span>
        <span className="liveEventFacts">
          <b className={event.isFree ? "free" : "paid"}>{event.isFree ? "免费" : event.mintPrice || "付费"}</b>
          <span className={hotGas ? "gas hot" : "gas"}><Flame size={12} />{integer(event.gasLimit || event.gasUsed)}{event.gasFeeNative ? <small>≈{compactNative(event.gasFeeNative)} {event.nativeSymbol || chain?.nativeSymbol || "—"}</small> : null}</span>
          <strong className="method">{event.methodName || event.selector || "方法未知"}</strong>
          <span>{integer(event.currentSupply)} / {integer(event.maxSupply)}</span>
          <span className={Number(event.pendingCount) > 0 || Number(event.pendingUnknownTxCount) > 0 ? "pending active" : "pending"}>{pendingLabel(event)}</span>
          <DeployerRiskBadge value={event} />
        </span>
      </button>
      <aside className="liveEventLinks">
        <span className="liveExternalLinks">
          {links.map(({ key, label, title, href, Icon }) => <a key={key} href={href} target="_blank" rel="noreferrer" aria-label={title} title={title}><Icon size={13} /><span>{label}</span></a>)}
          <button type="button" onClick={() => onSelect(event)} title={Number(chain.id) === 4663 ? "OpenSea 铸造" : "载入链上情报"}><ShoppingBag size={13} /><span>铸造</span></button>
          <PersonalFlagButton item={event} onToggleFlag={onToggleFlag} busyAddress={flagBusyAddress} />
        </span>
        <EventTags event={event} />
        {event.txHash ? <code>{short(event.txHash, 4, 4)}</code> : null}
      </aside>
    </article>
  )
}

function WalletPicker({ wallets, selectedIds, onChange }) {
  const selected = new Set(selectedIds)
  const toggle = (id) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }
  return (
    <div className="quickMintWallets">
      <div className="quickMintGroups"><button type="button" onClick={() => onChange(wallets.map((wallet) => wallet.id))}>全部</button><button type="button" onClick={() => onChange([])}>清空</button></div>
      <WalletGroupQuickSelect wallets={wallets} selectedIds={selectedIds} onChange={onChange} label="钱包分组" compact />
      <div className="quickMintWalletList">{wallets.map((wallet) => <label className={selected.has(wallet.id) ? "selected" : ""} key={wallet.id}><input type="checkbox" checked={selected.has(wallet.id)} onChange={() => toggle(wallet.id)} /><span><strong>{wallet.label || wallet.id}</strong><code>{short(wallet.address)}</code></span><small>{wallet.group || "未分组"}</small></label>)}</div>
    </div>
  )
}

function QuickMintPanel({ event, chain, wallets, selectedIds, onSelectedIdsChange, mintForm, setMintForm, job, error, busy, onPreview, onMint, explorerContract, explorerTx, explorerBlock }) {
  const robinhood = Number(chain?.id) === 4663
  const [panelMode, setPanelMode] = useState(robinhood ? "quick" : "advanced")
  useEffect(() => setPanelMode(event?.radarDrop ? "advanced" : robinhood ? "quick" : "advanced"), [event?.id, event?.radarDrop, chain?.id, robinhood])
  if (!event) return <aside className="liveActionPanel empty"><RadioTower size={22} /><strong>选择一条实时铸造记录</strong><span>右侧显示真实链上情报与执行入口</span></aside>
  const walletIssues = (job?.wallets || []).filter((wallet) => wallet.reason || wallet.error)
  const links = linkItems(event, { explorerTx, explorerContract, explorerBlock })
  const contractLink = links.find((item) => item.key === "contract")
  const txLink = links.find((item) => item.key === "tx")
  const quantity = String(mintForm?.quantity ?? "")
  const maxPerWallet = String(event.maxPerWallet ?? event.max_per_wallet ?? "")
  const quantityValidation = validateQuickMintQuantity(quantity, maxPerWallet)
  const quantityIssue = quantityValidation.issue
  return (
    <aside className="liveActionPanel">
      <header><div><span>{event.tokenStandard || "NFT"}</span><strong>{event.name || event.tokenName || short(event.address)}</strong><code>{event.address}</code></div>{contractLink ? <a href={contractLink.href} target="_blank" rel="noreferrer" aria-label="查看合约" title="查看合约"><ExternalLink size={14} /></a> : null}</header>
      <div className="liveIntelSummary">
        <span><Clock3 size={13} /><small>创建</small><strong>{event.contractCreatedAt ? new Date(event.contractCreatedAt).toLocaleString() : "未知"}</strong></span>
        <span><Flame size={13} /><small>Gas 上限</small><strong className={Number(event.gasLimit || 0) > 200000 ? "hot" : ""}>{integer(event.gasLimit)}</strong></span>
        <span><Layers3 size={13} /><small>供应量</small><strong>{integer(event.currentSupply)} / {integer(event.maxSupply)}</strong></span>
        <span><Zap size={13} /><small>待确认</small><strong title={pendingLabel(event, true)}>{pendingLabel(event, true)}</strong></span>
      </div>
      <DeployerRiskBadge value={event} detailed />
      <EventTags event={event} />
      <div className="liveProjectLinks" aria-label="项目链接">
        {links.map(({ key, label, title, href, Icon }) => <a key={key} href={href} target="_blank" rel="noreferrer" title={title}><Icon size={13} /><span>{label}</span></a>)}
      </div>
      {event.radarDrop ? <div className="liveRadarExecutionNotice"><CalendarClock size={14} /><span>{event.advancedMintSeed?.notice}</span></div> : null}
      <div className="livePanelModeSwitch" role="tablist" aria-label="铸造模式">
        <button type="button" className={panelMode === "quick" ? "active" : ""} onClick={() => setPanelMode("quick")}><ShoppingBag size={13} />快速铸造</button>
        <button type="button" className={panelMode === "advanced" ? "active" : ""} onClick={() => setPanelMode("advanced")}><Blocks size={13} />高级铸造</button>
      </div>
      {panelMode === "advanced" ? (
        <div className="liveAdvancedEmbed">
          <AdvancedMintView
            key={`${chain.id}:${event.id || event.address}`}
            compact
            embedded
            chain={chain}
            wallets={wallets}
            selectedIds={selectedIds}
            onSelectedIdsChange={onSelectedIdsChange}
            initialContract={event.mintTarget || event.address}
            initialSeed={event.advancedMintSeed || null}
          />
        </div>
      ) : robinhood ? (
        <>
          <div className="quickMintTitle"><div><ShoppingBag size={15} /><span><strong>OpenSea 快速铸造</strong><small>每钱包 {quantity || "—"} 个</small></span></div><span>{selectedIds.length} 已选</span></div>
          <label className="quickMintQuantity"><span>每钱包铸造数量</span><input type="number" min="1" value={quantity} aria-invalid={Boolean(quantityIssue)} onChange={(event) => setMintForm("quantity", event.target.value)} inputMode="numeric" /><small>{quantityIssue || `所选交易每次铸造 ${mintQuantityFromEvent(event)} 个，可在预览前调整`}</small></label>
          <WalletPicker wallets={wallets} selectedIds={selectedIds} onChange={onSelectedIdsChange} />
          {error ? <div className="quickMintError"><ShieldAlert size={14} />{uiError(error)}</div> : null}
          {job ? <div className="quickMintPreview"><span><small>状态</small><strong>{uiStatus(job.status)}</strong></span><span><small>可执行</small><strong>{job.summary?.ready ?? job.summary?.eligible ?? 0}</strong></span><span><small>跳过</small><strong>{job.summary?.skipped ?? 0}</strong></span><span><small>失败</small><strong>{job.summary?.failed ?? 0}</strong></span></div> : null}
          {walletIssues.length ? <div className="quickMintIssues" role="status">{walletIssues.slice(0, 4).map((wallet) => <div key={wallet.walletId}><strong>{wallet.walletId}</strong><span>{uiError(wallet.reason || wallet.error)}</span></div>)}</div> : null}
          <div className="quickMintActions"><button type="button" onClick={onPreview} disabled={busy || !selectedIds.length || !quantityValidation.valid}>{busy ? <RefreshCcw className="spin" size={14} /> : <Settings2 size={14} />}预览</button><button className="primary" type="button" onClick={onMint} disabled={busy || !selectedIds.length || !quantityValidation.valid}><ShoppingBag size={14} />铸造</button></div>
        </>
      ) : (
        <div className="advancedMintHandoff"><AlertTriangle size={17} /><div><strong>当前链使用高级铸造</strong><span>切换到高级模式即可编辑 ABI / Hex、费用和执行策略。</span></div><button type="button" onClick={() => setPanelMode("advanced")}>打开高级铸造</button></div>
      )}
      {txLink && panelMode !== "advanced" ? <a className="liveTxLink" href={txLink.href} target="_blank" rel="noreferrer"><ExternalLink size={13} />{short(event.txHash, 10, 8)}</a> : null}
    </aside>
  )
}

const TRENDING_WINDOW_LABELS = {
  60: "1m",
  300: "5m",
  600: "10m",
  1800: "30m",
  3600: "1h",
  21600: "6h",
  43200: "12h",
  86400: "24h",
}

function trendingEvent(row, chainId) {
  const latest = row.latestEvent || {}
  const base = {
    ...latest,
    ...row,
    id: latest.id || `trending:${row.address}`,
    chainId: row.chainId || chainId,
    address: row.address,
    tokenName: row.name || latest.tokenName,
    projectImageUrl: row.imageUrl || latest.projectImageUrl,
    currentSupply: row.collection_snapshot?.current_supply ?? latest.currentSupply,
    maxSupply: row.collection_snapshot?.max_supply ?? latest.maxSupply,
    mintPrice: row.mintPrice ?? latest.mintPrice,
    deployerProfile: row.deployerProfile || row.deployer_profile || row.collection_snapshot?.deployer_profile || latest.deployerProfile,
    personalFlag: row.personalFlag || null,
  }
  return row.collection_snapshot ? mergeSnapshotIntoEvent(base, row.collection_snapshot) : base
}

function relativeMintTime(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return "—"
  return formatRelativeTime(number > 10_000_000_000 ? number / 1000 : number, "zh")
}

function TrendingPanel({ rows, chain, selectedEvent, onSelect, onToggleFlag, flagBusyAddress, loading, error }) {
  return (
    <div className="trendingTable" aria-label="Trending 多窗口排名">
      <div className="trendingHeader"><span>#</span><span>合集</span><span>铸造</span><span>钱包 / 交易</span><span>价格 / 地板</span><span>部署者风险</span><span>最近</span><span>操作</span></div>
      {rows.map((row) => {
        const event = trendingEvent(row, chain.id)
        return (
          <article className={selectedEvent?.address?.toLowerCase() === row.address?.toLowerCase() ? "trendingRow selected" : "trendingRow"} key={row.address}>
            <button type="button" className="trendingRank" onClick={() => onSelect(event)}>{row.rank}</button>
            <button type="button" className="trendingIdentity" onClick={() => onSelect(event)}><MintImage event={event} /><span><strong>{row.name || short(row.address)}</strong><code>{short(row.address)}</code></span></button>
            <strong className="trendingMints">+{integer(row.mintCount)}</strong>
            <span><b>{integer(row.uniqueMinters)}</b><small>{integer(row.txCount)} 笔</small></span>
            <span><b>{row.mintPrice || (row.mintValueWei === "0" ? "免费" : "—")}</b><small>{row.floorPriceEth == null ? "地板 —" : `地板 ${row.floorPriceEth}`}</small></span>
            <DeployerRiskBadge value={event} />
            <span><b>{relativeMintTime(row.lastMintAt)}</b><small>{row.tokenStandard || "NFT"}</small></span>
            <span className="trendingActions"><button type="button" onClick={() => onSelect(event)} title="载入铸造"><ShoppingBag size={13} /></button><PersonalFlagButton item={event} onToggleFlag={onToggleFlag} busyAddress={flagBusyAddress} /></span>
          </article>
        )
      })}
      {loading ? <div className="liveMintEmpty"><RefreshCcw className="spin" size={18} /><strong>正在读取真实排名</strong></div> : null}
      {!loading && error ? <div className="liveStreamNotice error"><ShieldAlert size={14} />{uiError(error)}</div> : null}
      {!loading && !error && !rows.length ? <div className="liveMintEmpty"><ListFilter size={20} /><strong>当前窗口暂无排名</strong></div> : null}
    </div>
  )
}

function nativeFromWei(value) {
  try {
    const wei = BigInt(value || 0)
    const weiPerNative = 1000000000000000000n
    const whole = wei / weiPerNative
    const fraction = (wei % weiPerNative).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "")
    return fraction ? `${whole}.${fraction}` : whole.toString()
  } catch {
    return "—"
  }
}

function RadarPanel({ radar, drops, filters, setFilters, nowMs, chain, onEligibility, onSchedule, onToggleFlag, flagBusyAddress, onRefresh }) {
  return (
    <div className="radarWorkspace">
      <div className="radarFilterBar">
        <div className="radarPriceFilter">{[["all", "全部"], ["free", "免费"], ["paid", "付费"]].map(([value, label]) => <button type="button" className={filters.price === value ? "active" : ""} key={value} onClick={() => setFilters((current) => ({ ...current, price: value }))}>{label}</button>)}</div>
        <Toggle checked={filters.publicOnly} onChange={(value) => setFilters((current) => ({ ...current, publicOnly: value }))}>仅公开阶段</Toggle>
        <Toggle checked={filters.liveOnly} onChange={(value) => setFilters((current) => ({ ...current, liveOnly: value }))}>仅进行中</Toggle>
        <button className="radarRefresh" type="button" onClick={() => void onRefresh().catch(() => {})} disabled={radar.loading}><RefreshCcw className={radar.loading ? "spin" : ""} size={13} />刷新雷达</button>
      </div>
      {radar.scanError ? <div className="liveStreamNotice"><RadioTower size={14} />{radar.scanError}</div> : null}
      {radar.error ? <div className="liveStreamNotice error"><ShieldAlert size={14} />{uiError(radar.error)}</div> : null}
      <div className="radarTableHeader"><span>阶段 / 时间</span><span>合集</span><span>价格</span><span>每钱包</span><span>资格</span><span>执行</span></div>
      {drops.map((drop) => {
        const timing = radarDropTiming(drop, nowMs)
        const countdown = timing.state === "live" ? "进行中" : timing.state === "ended" ? "已结束" : timing.state === "unscheduled" ? "待排期" : formatRadarCountdown(timing.remainingMs)
        return (
          <article className={`radarRow ${timing.state}`} key={drop.id || `${drop.contract}:${drop.stageKey}`}>
            <span><b className={`stage ${drop.stageType}`}>{drop.label || drop.stageType}</b><strong>{countdown}</strong><small>{formatRadarDateTime(drop.startTime)}</small></span>
            <span className="radarIdentity"><MintImage event={{ address: drop.contract, name: drop.name, projectImageUrl: drop.image }} /><span><strong>{drop.name || short(drop.contract)}</strong><code>{short(drop.contract)}</code></span></span>
            <span><strong>{drop.priceWei === null ? "—" : `${nativeFromWei(drop.priceWei)} ${chain.nativeSymbol || ""}`}</strong><small>{drop.feeBps ? `${drop.feeBps} bps` : "费用未公布"}</small></span>
            <span><strong>{drop.maxPerWallet || "—"}</strong><small>{drop.maxSupplyForStage ? `阶段 ${drop.maxSupplyForStage}` : "阶段上限未知"}</small></span>
            <span><strong>{drop.requiresCredentials ? "需要凭据" : "公开"}</strong><button type="button" onClick={() => onEligibility(drop)}><ShieldCheck size={13} />资格检查</button></span>
            <span className="radarActions"><button type="button" onClick={() => onSchedule(drop)}><CalendarClock size={13} />预约</button><PersonalFlagButton item={{ ...drop, address: drop.contract }} onToggleFlag={onToggleFlag} busyAddress={flagBusyAddress} /></span>
          </article>
        )
      })}
      {!radar.loading && !drops.length ? <div className="liveMintEmpty"><CalendarClock size={20} /><strong>当前筛选暂无 SeaDrop 阶段</strong></div> : null}
    </div>
  )
}

const EMPTY_ALERT_DRAFT = {
  type: "trending",
  name: "",
  window: "60",
  threshold: "10",
  address: "",
  leadMinutes: "10",
  cooldownSeconds: "60",
  enabled: true,
}

function alertDraft(rule) {
  if (!rule) return { ...EMPTY_ALERT_DRAFT }
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
  const params = draft.type === "trending"
    ? { window: Number(draft.window), threshold: Number(draft.threshold) }
    : draft.type === "seadrop_start"
      ? { leadMinutes: Number(draft.leadMinutes), ...(draft.address ? { address: draft.address } : {}) }
      : { address: draft.address }
  return { type: draft.type, name: draft.name, enabled: draft.enabled, cooldownSeconds: Number(draft.cooldownSeconds), params }
}

function alertTypeLabel(value) {
  return { trending: "趋势阈值", contract_mint: "合约开铸", seadrop_start: "SeaDrop 开售", wallet_activity: "钱包活动" }[value] || value
}

function alertRuleSummary(rule) {
  if (rule.type === "trending") return `${TRENDING_WINDOW_LABELS[rule.params.window] || rule.params.window} ≥ ${rule.params.threshold}`
  if (rule.type === "seadrop_start") return `提前 ${rule.params.leadMinutes} 分钟${rule.params.address ? ` · ${short(rule.params.address)}` : ""}`
  return short(rule.params.address)
}

function AlertsPanel({ alerts, history, preferences, onPreferenceChange, onCreate, onUpdate, onDelete, onTest, onRefresh }) {
  const [draft, setDraft] = useState(EMPTY_ALERT_DRAFT)
  const [editingId, setEditingId] = useState("")
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const submit = async (event) => {
    event.preventDefault()
    const input = alertInput(draft)
    const result = editingId ? await onUpdate(editingId, input) : await onCreate(input)
    if (result) {
      setEditingId("")
      setDraft({ ...EMPTY_ALERT_DRAFT })
    }
  }
  const edit = (rule) => {
    setEditingId(rule.id)
    setDraft(alertDraft(rule))
  }
  return (
    <div className="alertsWorkspace">
      <section className="alertPreferences">
        <div><Bell size={15} /><span><strong>浏览器报警</strong><small>{typeof Notification === "undefined" ? "桌面通知未支持" : `桌面权限：${Notification.permission}`}</small></span></div>
        <Toggle checked={preferences.sound} onChange={(value) => void onPreferenceChange("sound", value)}>{preferences.sound ? <Volume2 size={12} /> : <VolumeX size={12} />}声音</Toggle>
        <Toggle checked={preferences.desktop} onChange={(value) => void onPreferenceChange("desktop", value)}>桌面通知</Toggle>
        <span className={`notifierState ${alerts.notifier?.enabled ? "active" : ""}`}>Telegram {alerts.notifier?.enabled ? "已配置" : "未配置"}</span>
        <button type="button" onClick={() => void onTest().catch(() => {})} disabled={alerts.loading}><Bell size={13} />测试</button>
        <button type="button" onClick={() => void onRefresh().catch(() => {})} disabled={alerts.loading}><RefreshCcw className={alerts.loading ? "spin" : ""} size={13} />刷新</button>
      </section>
      {alerts.error ? <div className="liveStreamNotice error"><ShieldAlert size={14} />{uiError(alerts.error)}</div> : null}
      <div className="alertsLayout">
        <form className="alertRuleForm" onSubmit={(event) => void submit(event).catch(() => {})}>
          <header><strong>{editingId ? "编辑报警规则" : "新建报警规则"}</strong>{editingId ? <button type="button" onClick={() => { setEditingId(""); setDraft({ ...EMPTY_ALERT_DRAFT }) }}>结束编辑</button> : null}</header>
          <label><span>类型</span><select value={draft.type} onChange={(event) => set("type", event.target.value)}><option value="trending">趋势阈值</option><option value="contract_mint">合约开铸</option><option value="seadrop_start">SeaDrop 开售</option><option value="wallet_activity">钱包活动</option></select></label>
          <label><span>名称</span><input value={draft.name} onChange={(event) => set("name", event.target.value)} placeholder={alertTypeLabel(draft.type)} /></label>
          {draft.type === "trending" ? <div className="alertFields"><label><span>窗口</span><select value={draft.window} onChange={(event) => set("window", event.target.value)}>{TRENDING_WINDOWS.map((window) => <option value={window} key={window}>{TRENDING_WINDOW_LABELS[window]}</option>)}</select></label><label><span>铸造阈值</span><input type="number" min="1" value={draft.threshold} onChange={(event) => set("threshold", event.target.value)} /></label></div> : null}
          {["contract_mint", "wallet_activity", "seadrop_start"].includes(draft.type) ? <label><span>{draft.type === "wallet_activity" ? "钱包地址" : "合约地址"}{draft.type === "seadrop_start" ? "（可选）" : ""}</span><input value={draft.address} onChange={(event) => set("address", event.target.value)} placeholder="0x..." spellCheck="false" /></label> : null}
          {draft.type === "seadrop_start" ? <label><span>提前分钟</span><input type="number" min="0" value={draft.leadMinutes} onChange={(event) => set("leadMinutes", event.target.value)} /></label> : null}
          <div className="alertFields"><label><span>冷却秒数</span><input type="number" min="0" value={draft.cooldownSeconds} onChange={(event) => set("cooldownSeconds", event.target.value)} /></label><Toggle checked={draft.enabled} onChange={(value) => set("enabled", value)}>立即启用</Toggle></div>
          <button className="primary" type="submit" disabled={alerts.loading}><Bell size={13} />{editingId ? "保存修改" : "创建规则"}</button>
        </form>
        <section className="alertRuleList">
          <div className="alertListHeader"><strong>规则</strong><span>{alerts.rules.filter((rule) => rule.enabled).length}/{alerts.rules.length} 启用</span></div>
          {alerts.rules.map((rule) => <article className="alertRuleRow" key={rule.id}><span className={`statusDot ${rule.enabled ? "ready" : ""}`} /><span><strong>{rule.name}</strong><small>{alertTypeLabel(rule.type)} · {alertRuleSummary(rule)}</small></span><span><small>冷却</small><strong>{rule.cooldownSeconds}s</strong></span><button type="button" onClick={() => void onUpdate(rule.id, { enabled: !rule.enabled }).catch(() => {})}>{rule.enabled ? "暂停" : "启用"}</button><button type="button" onClick={() => edit(rule)} aria-label={`编辑 ${rule.name}`}><Edit3 size={13} /></button><button type="button" onClick={() => { if (window.confirm(`删除报警规则“${rule.name}”？`)) void onDelete(rule.id).catch(() => {}) }} aria-label={`删除 ${rule.name}`}><Trash2 size={13} /></button></article>)}
          {!alerts.rules.length && !alerts.loading ? <div className="liveMintEmpty"><Bell size={20} /><strong>暂无报警规则</strong></div> : null}
        </section>
      </div>
      <section className="alertHistory"><header><strong>最近报警</strong><span>{history.length}</span></header>{history.map((alert) => <article key={alert.id}><Bell size={13} /><span><strong>{alert.title}</strong><small>{alert.message}</small></span><time>{alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleTimeString() : "刚刚"}</time></article>)}{!history.length ? <div className="miniEmpty">当前会话暂无报警</div> : null}</section>
    </div>
  )
}

export default function LiveMintView({
  initialView = "live",
  chain, chains, chainId, onChainChange, wallets, selectedIds, onSelectedIdsChange,
  monitor, monitorWindow, setMonitorWindow, liveEvents, realtime, streamStatus, explorerTx, explorerContract, explorerBlock,
  trending, onLoadTrending, radar, onRefreshRadar, flags, onToggleFlag,
  alerts, alertHistory, alertPreferences, onAlertPreferenceChange, onCreateAlert, onUpdateAlert, onDeleteAlert, onTestAlert, onRefreshAlerts,
  onSelectCollection, mintForm, setMintForm, job, error, busy, onPreview, onMint,
}) {
  const [filters, setFilters] = useState(initialFilters)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState(initialView)
  const [trendingWindow, setTrendingWindow] = useState(60)
  const [radarFilters, setRadarFilters] = useState({ price: "all", publicOnly: false, liveOnly: false })
  const [nowMs, setNowMs] = useState(Date.now)
  const [selectedSnapshot, setSelectedSnapshot] = useState(null)
  const [pausedOrder, setPausedOrder] = useState(null)
  const pause = useRef({ hover: false, focus: false })
  const overviewMetadata = useMemo(() => {
    const rows = Object.values(monitor.data?.windows || {}).flat()
    return new Map(rows.filter((row) => row?.address).map((row) => [row.address.toLowerCase(), row]))
  }, [monitor.data?.windows])
  const enrichedLiveEvents = useMemo(() => liveEvents.map((event) => {
    const row = overviewMetadata.get(String(event.address || "").toLowerCase())
    if (!row) return event
    const preview = (row.recent_mint_preview || []).find((item) => item.tx_hash === event.txHash) || {}
    const merged = {
      ...event,
      name: event.name && !/^ERC\d+\s/i.test(event.name) ? event.name : row.name || event.name,
      tokenName: event.tokenName || row.name || "",
      projectImageUrl: row.image_url || event.projectImageUrl || "",
      imageFallbackUrl: row.image_fallback_url || event.imageUrl || event.image_url || preview.image_url || "",
      website: row.website || event.website || "",
      twitter: row.twitter || event.twitter || "",
      opensea_url: row.opensea_verified ? row.opensea_url || "" : "",
      openseaVerified: Boolean(row.opensea_verified),
      discord_url: row.discord_url || event.discord_url || "",
      blockNumber: event.blockNumber || preview.block_number || row.contract_created_block || "",
      contractCreatedAt: event.contractCreatedAt || row.contract_created_at || null,
      contractCreatedBlock: event.contractCreatedBlock || row.contract_created_block || null,
      currentSupply: row.current_supply ?? event.currentSupply,
      maxSupply: row.max_supply ?? event.maxSupply,
      pendingCount: row.pending_count ?? event.pendingCount,
      pendingUnknownTxCount: row.pending_unknown_tx_count ?? event.pendingUnknownTxCount ?? 0,
      pendingTransactionCount: row.pending_transaction_count ?? event.pendingTransactionCount ?? null,
      pendingCoverage: row.pending_coverage || event.pendingCoverage || "unavailable",
      fundingTags: row.funding_tags || event.fundingTags || [],
      platformTags: row.platform_tags || event.platformTags || [],
      statusTags: row.status_tags || event.statusTags || [],
      deployerProfile: row.deployer_profile || event.deployerProfile || null,
    }
    return row.collection_snapshot ? mergeSnapshotIntoEvent(merged, row.collection_snapshot) : merged
  }), [liveEvents, overviewMetadata])
  const selectedRow = overviewMetadata.get(String(selectedSnapshot?.address || "").toLowerCase())
  const resolvedSelectedEvent = enrichedLiveEvents.find((event) => event.id === selectedSnapshot?.id)
    || (selectedSnapshot && selectedRow?.collection_snapshot ? mergeSnapshotIntoEvent(selectedSnapshot, selectedRow.collection_snapshot) : selectedSnapshot)
  const selectedEvent = resolvedSelectedEvent ? collectionsWithFlags([resolvedSelectedEvent], flags.items, { showFlagged: true })[0] : null
  const filteredEvents = collectionsWithFlags(
    visibleLiveFeedEvents(enrichedLiveEvents, chain?.id, pausedOrder),
    flags.items,
    { showFlagged: filters.showFlagged },
  ).filter((event) => eventMatches(event, filters))
  const overviewRows = collectionsWithFlags(
    monitor.data?.windows?.[String(monitorWindow)] || [],
    flags.items,
    { showFlagged: filters.showFlagged },
  ).filter((row) => eventMatches({
    ...row,
    name: row.name,
    address: row.address,
    isFree: row.mint_price_raw === "0",
    mintValueWei: row.mint_price_raw,
    isAirdrop: row.is_airdrop,
    tokenStandard: row.token_standard,
    maxSupply: row.max_supply,
    pendingCount: row.pending_count,
    fundingTags: row.funding_tags,
    platformTags: row.platform_tags,
    statusTags: row.status_tags,
  }, filters))
  const trendingRows = collectionsWithFlags(
    trending.windows?.[String(trendingWindow)] || [],
    flags.items,
    { showFlagged: filters.showFlagged },
  ).filter((row) => {
    const query = filters.keyword.trim().toLowerCase()
    return !query || `${row.name || ""} ${row.address || ""} ${row.symbol || ""}`.toLowerCase().includes(query)
  })
  const radarDrops = collectionsWithFlags(
    filterRadarDrops(radar.drops, { ...radarFilters, query: filters.keyword }, nowMs),
    flags.items,
    { showFlagged: filters.showFlagged },
  )

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters))
  }, [filters])

  useEffect(() => {
    setSelectedSnapshot(null)
    setPausedOrder(null)
    setTrendingWindow(60)
  }, [chainId])

  useEffect(() => {
    if (view !== "radar") return undefined
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [view])

  useEffect(() => {
    if (!selectedSnapshot || selectedSnapshot.radarDrop || selectedSnapshot.intelligenceSource === "trending" || String(selectedSnapshot.id || "").startsWith("overview:")) return
    if (!enrichedLiveEvents.some((event) => event.id === selectedSnapshot.id)) setSelectedSnapshot(null)
  }, [enrichedLiveEvents, selectedSnapshot])

  function setFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function setPaused(reason, value) {
    pause.current[reason] = value
    if (value) setPausedOrder((current) => current || liveFeedOrderSnapshot(enrichedLiveEvents, chain?.id))
    else if (!pause.current.hover && !pause.current.focus) setPausedOrder(null)
  }

  function selectEvent(event) {
    setSelectedSnapshot(event)
    setMintForm("contractAddress", event.address)
    setMintForm("quantity", mintQuantityFromEvent(event))
    setMintForm("tokenId", "0")
    onSelectCollection(event)
  }

  function changeView(next) {
    setView(next)
    if (next === "trending" && !trending.windows?.[String(trendingWindow)]) void onLoadTrending(trendingWindow).catch(() => {})
    if (next === "radar") void onRefreshRadar().catch(() => {})
    if (next === "alerts") void onRefreshAlerts({ quiet: true }).catch(() => {})
  }

  function changeTrendingWindow(seconds) {
    setTrendingWindow(seconds)
    void onLoadTrending(seconds).catch(() => {})
  }

  function selectRadarDrop(drop) {
    const advancedMintSeed = buildRadarAdvancedMintSeed(drop)
    const event = {
      id: `radar:${drop.id || `${drop.contract}:${drop.stageKey}`}`,
      radarDrop: true,
      chainId: chain?.id,
      address: drop.contract,
      mintTarget: drop.dropAddress || drop.contract,
      name: drop.name || "SeaDrop 阶段",
      tokenName: drop.name || "SeaDrop 阶段",
      tokenStandard: "SeaDrop",
      projectImageUrl: drop.image || "",
      maxPerWallet: drop.maxPerWallet,
      mintPrice: drop.priceWei === null ? "—" : `${nativeFromWei(drop.priceWei)} ${chain?.nativeSymbol || ""}`,
      isFree: drop.priceWei === "0",
      requiresCredentials: Boolean(drop.requiresCredentials),
      stageType: drop.stageType,
      startTime: drop.startTime,
      advancedMintSeed,
      personalFlag: drop.personalFlag || null,
    }
    setSelectedSnapshot(event)
    setMintForm("contractAddress", drop.contract)
    setMintForm("quantity", "1")
    setMintForm("tokenId", "0")
  }

  function openEligibility(drop) {
    const message = drop.requiresCredentials
      ? "该阶段需要签名或白名单材料，雷达快照仅含阶段参数。打开项目破签并补入真实交易 calldata 后执行逐钱包预检？"
      : "雷达快照不含 feeRecipient 与铸造 calldata。打开项目破签并补入真实交易参数后执行逐钱包预检？"
    if (!window.confirm(message)) return
    const params = new URLSearchParams({ contractAddress: drop.contract })
    if (window.top && window.top !== window) window.top.location.assign(`/tool/highHexMint/signTask?${params.toString()}`)
    else window.location.assign(`/opensea/?module=sign&${params.toString()}`)
  }

  const overviewWindows = [[60, "1 分钟"], [300, "5 分钟"], [1800, "30 分钟"], [3600, "1 小时"]]

  return (
    <div className="liveMintWorkspace">
      <section className="liveMintStream">
        <StatusStrip chain={chain} chains={chains} chainId={chainId} onChainChange={onChainChange} monitor={monitor} realtime={realtime} streamStatus={streamStatus} onOpenSettings={() => setSettingsOpen((value) => !value)} />
        <div className="liveMintToolbar">
          <div className="liveMintTabs"><button className={view === "live" ? "active" : ""} type="button" onClick={() => changeView("live")}>实时</button><button className={view === "trending" ? "active" : ""} type="button" onClick={() => changeView("trending")}>趋势</button><button className={view === "overview" ? "active" : ""} type="button" onClick={() => changeView("overview")}>概览</button><button className={view === "radar" ? "active" : ""} type="button" onClick={() => changeView("radar")}>即将开售</button><button className={view === "alerts" ? "active" : ""} type="button" onClick={() => changeView("alerts")}>报警</button></div>
          {view !== "alerts" ? <label className="liveMintSearch"><Search size={14} /><input value={filters.keyword} onChange={(event) => setFilter("keyword", event.target.value)} placeholder="搜索名称、合约或方法" /></label> : <span />}
          {view === "trending" ? <div className="liveMintWindows trendingWindows">{TRENDING_WINDOWS.map((seconds) => <button className={trendingWindow === seconds ? "active" : ""} type="button" key={seconds} onClick={() => changeTrendingWindow(seconds)}>{TRENDING_WINDOW_LABELS[seconds]}</button>)}</div> : ["live", "overview"].includes(view) ? <div className="liveMintWindows">{overviewWindows.map(([seconds, label]) => <button className={monitorWindow === seconds ? "active" : ""} type="button" key={seconds} onClick={() => setMonitorWindow(seconds)}>{label}</button>)}</div> : <span />}
          {settingsOpen ? <ScreenSettings filters={filters} setFilter={setFilter} onReset={() => setFilters(EMPTY_FILTERS)} onClose={() => setSettingsOpen(false)} /> : null}
        </div>
        {monitor.error ? <div className="liveStreamNotice error"><ShieldAlert size={14} />{uiError(monitor.error)}</div> : null}
        {flags.error ? <div className="liveStreamNotice error"><Flag size={14} />{uiError(flags.error)}</div> : null}
        {monitor.data?.providerError && ["live", "overview"].includes(view) ? <div className="liveStreamNotice"><RadioTower size={14} />第三方源未响应，当前由所选链 RPC 实时扫描。</div> : null}
        <div className={`liveMintRows ${view}`} role={view === "live" ? "log" : undefined} onPointerEnter={() => setPaused("hover", true)} onPointerLeave={() => setPaused("hover", false)} onFocusCapture={() => setPaused("focus", true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused("focus", false) }}>
          {view === "live" ? filteredEvents.map((event) => <LiveEventRow key={event.id} event={event} selected={event.id === selectedEvent?.id} chain={chain} explorerTx={explorerTx} explorerContract={explorerContract} explorerBlock={explorerBlock} onSelect={selectEvent} onToggleFlag={onToggleFlag} flagBusyAddress={flags.busyAddress} />) : null}
          {view === "overview" ? overviewRows.map((row) => {
            const preview = row.recent_mint_preview?.[0] || {}
            const baseEvent = { ...row, id: `overview:${row.address}`, chainId: row.chainId || chain?.id, txHash: preview.tx_hash || "", blockNumber: preview.block_number || row.contract_created_block || "", currentSupply: row.current_supply, maxSupply: row.max_supply, pendingCount: row.pending_count, pendingUnknownTxCount: row.pending_unknown_tx_count || 0, pendingTransactionCount: row.pending_transaction_count ?? null, pendingCoverage: row.pending_coverage || "unavailable", contractCreatedAt: row.contract_created_at, contractCreatedBlock: row.contract_created_block, mintPrice: row.mint_price, mintValueWei: row.mint_price_raw, isFree: row.mint_price_raw === "0", fundingTags: row.funding_tags, platformTags: row.platform_tags, statusTags: row.status_tags, quantity: preview.quantity || "1", tokenStandard: row.token_standard, projectImageUrl: row.image_url, imageFallbackUrl: row.image_fallback_url, website: row.website, twitter: row.twitter, opensea_url: row.opensea_verified ? row.opensea_url || "" : "", openseaVerified: Boolean(row.opensea_verified), deployerProfile: row.deployer_profile, personalFlag: row.personalFlag }
            const event = row.collection_snapshot ? mergeSnapshotIntoEvent(baseEvent, row.collection_snapshot) : baseEvent
            return <LiveEventRow key={row.address} event={event} selected={event.id === selectedEvent?.id} chain={chain} explorerTx={explorerTx} explorerContract={explorerContract} explorerBlock={explorerBlock} onSelect={selectEvent} onToggleFlag={onToggleFlag} flagBusyAddress={flags.busyAddress} />
          }) : null}
          {view === "trending" ? <TrendingPanel rows={trendingRows} chain={chain || {}} selectedEvent={selectedEvent} onSelect={(event) => selectEvent({ ...event, intelligenceSource: "trending" })} onToggleFlag={onToggleFlag} flagBusyAddress={flags.busyAddress} loading={trending.loading} error={trending.error} /> : null}
          {view === "radar" ? <RadarPanel radar={radar} drops={radarDrops} filters={radarFilters} setFilters={setRadarFilters} nowMs={nowMs} chain={chain || {}} onEligibility={openEligibility} onSchedule={selectRadarDrop} onToggleFlag={onToggleFlag} flagBusyAddress={flags.busyAddress} onRefresh={onRefreshRadar} /> : null}
          {view === "alerts" ? <AlertsPanel alerts={alerts} history={alertHistory} preferences={alertPreferences} onPreferenceChange={onAlertPreferenceChange} onCreate={onCreateAlert} onUpdate={onUpdateAlert} onDelete={onDeleteAlert} onTest={onTestAlert} onRefresh={onRefreshAlerts} /> : null}
          {view === "live" && !filteredEvents.length ? <div className="liveMintEmpty"><RadioTower size={21} /><strong>等待符合条件的链上铸造记录</strong></div> : null}
          {view === "overview" && !overviewRows.length ? <div className="liveMintEmpty"><RadioTower size={21} /><strong>当前窗口暂无合集</strong></div> : null}
        </div>
      </section>
      <QuickMintPanel event={selectedEvent} chain={chain} wallets={wallets} selectedIds={selectedIds} onSelectedIdsChange={onSelectedIdsChange} mintForm={mintForm} setMintForm={setMintForm} job={job} error={error} busy={busy} onPreview={onPreview} onMint={onMint} explorerContract={explorerContract} explorerTx={explorerTx} explorerBlock={explorerBlock} />
    </div>
  )
}
