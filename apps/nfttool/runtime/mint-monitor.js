import { api, currentChain, escapeHtml, networkBar, shortAddress } from './core.js';
import { renderMintActionPanel } from './mint-action-panel.js';
import { createMonitorCache } from './mint-monitor-cache.js';
import { createRegionSignatures, createRenderScheduler } from './mint-monitor-renderer.js';
import { createMonitorStore } from './mint-monitor-store.js';
import { createMonitorStreamCoordinator } from './mint-monitor-stream.js';
import { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import {
  DEFAULT_FILTERS,
  DEFAULT_RADAR_FILTERS,
  OVERVIEW_WINDOWS,
  OVERVIEW_WINDOW_LABELS,
  TRENDING_WINDOWS,
  TRENDING_WINDOW_LABELS,
  alertDraftFromRule,
  applyCollectionUpdate,
  buildAlertPayload,
  collectionsWithFlags,
  createRealtimeState,
  enrichRealtimeEvents,
  eventKey,
  eventMatches,
  eventTags,
  filterRadarDrops,
  formatRadarCountdown,
  formatRadarDateTime,
  imageSources,
  integer,
  mergeCollectionDetailIntoEvent,
  mergeSnapshotIntoRow,
  normalizeOverviewEvent,
  normalizeRadarEvent,
  normalizeTrendingEvent,
  normalizeVisibleCount,
  radarTiming,
  readAlertPreferences,
  reduceRealtimeState,
  rememberAlertId,
  replaceRealtimeOverview,
  short,
  stableRealtimeOrder,
  writeAlertPreferences,
} from './mint-monitor-data.js';

const FILTER_KEY = 'nfttool:live-mint-filters';
const VIEW_LABELS = Object.freeze({ live: '实时', trending: '趋势', overview: '概览', radar: '即将开售', alerts: '报警' });
const ALERT_TYPE_LABELS = Object.freeze({ trending: '趋势阈值', contract_mint: '合约开铸', seadrop_start: 'SeaDrop 开售', wallet_activity: '钱包活动' });
const PREFETCH_LIMIT = 48;
const PREFETCH_CACHE_LIMIT = 256;
const PREFETCH_TTL_MS = 10 * 60 * 1000;
const prefetchedImageUrls = new Map();

function storedFilters(storage = globalThis.localStorage) {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(storage?.getItem(FILTER_KEY) || '{}') }; }
  catch { return { ...DEFAULT_FILTERS }; }
}

function persistFilters(form) {
  try { globalThis.localStorage?.setItem(FILTER_KEY, JSON.stringify(form.filters)); }
  catch { /* The active page remains usable when storage is unavailable. */ }
}

function createMonitorForm(chainId) {
  const diagnostics = createRuntimeDiagnostics();
  const store = createMonitorStore({ chainId, overviewWindow: 1800 });
  const cache = createMonitorCache({ diagnostics });
  return {
    chainId: Number(chainId), view: 'live', overviewWindow: 1800, trendingWindow: 60,
    data: null, monitorStatus: null, realtime: createRealtimeState(),
    trending: { windows: {}, loading: false, error: '', snapshotId: '', generatedAt: null },
    radar: { drops: [], loading: false, error: '', scanError: '', snapshotId: '', generatedAt: null },
    radarFilters: { ...DEFAULT_RADAR_FILTERS }, flags: { items: [], loading: false, error: '', busyAddress: '' },
    alerts: { rules: [], notifier: null, loading: false, error: '' }, alertDraft: alertDraftFromRule(), editingAlertId: '',
    alertHistory: [], alertIds: [], alertPreferences: readAlertPreferences(),
    detail: { address: '', collection: null, loading: false, error: '', requestId: 0, controller: null },
    loading: false, loaded: false, requestId: 0, error: '', filters: storedFilters(), filtersOpen: false,
    stream: null, streamState: 'offline', refreshTimer: null, renderTimer: null, radarTimer: null,
    streamCoordinator: null, store, cache, diagnostics, cacheLoaded: false, cacheSaveTimer: null,
    snapshotConfirmed: false, renderScheduler: null, renderRevision: 0,
    selectedEventId: '', selectedEvent: null, frozenOrder: null, freeze: { hover: false, focus: false },
    nowMs: Date.now(), replayNotice: '', disposed: false,
  };
}

function disposeMonitorForm(form) {
  if (!form) return;
  form.disposed = true;
  form.streamCoordinator?.stop(); form.stream?.close?.(); form.detail?.controller?.abort();
  if (form.refreshTimer) window.clearTimeout(form.refreshTimer);
  if (form.renderTimer) window.clearTimeout(form.renderTimer);
  if (form.radarTimer) window.clearInterval(form.radarTimer);
  if (form.cacheSaveTimer) window.clearTimeout(form.cacheSaveTimer);
  form.renderScheduler?.cancelAllIdle?.(); form.renderScheduler?.cancelFrame?.();
}

function relativeTime(value) {
  if (!value) return '未知';
  const parsed = typeof value === 'number' ? value * (value > 10_000_000_000 ? 1 : 1000) : Date.parse(value);
  if (!Number.isFinite(parsed)) return '未知';
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function compactNative(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number === 0) return '0';
  if (number < 0.000001) return number.toExponential(2);
  return number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function browserUrl(value, { relative = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const base = relative ? globalThis.location?.origin || 'http://127.0.0.1' : undefined;
    const candidate = /^\/{2}/.test(raw) ? `https:${raw}` : raw;
    const url = base ? new URL(candidate, base) : new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function explorerUrl(chain, type, value) {
  if (!chain?.explorer || value === null || value === undefined || value === '') return '';
  return `${String(chain.explorer).replace(/\/$/, '')}/${type}/${value}`;
}

function eventLinks(event, chain) {
  const openSea = event.openseaVerified || event.opensea_verified ? browserUrl(event.openseaUrl || event.opensea_url) : '';
  return [
    ['官网', '官方网站', browserUrl(event.website || event.websiteUrl)],
    ['X', 'X 项目主页', browserUrl(event.twitter || event.twitterUrl || event.x || event.xUrl)],
    ['OpenSea', 'OpenSea 合集', openSea],
    ['合约', '查看合约', explorerUrl(chain, 'address', event.address)],
    ['区块', '查看区块', explorerUrl(chain, 'block', event.blockNumber || event.contractCreatedBlock)],
    ['交易', '查看交易', explorerUrl(chain, 'tx', event.txHash)],
  ].filter(([, , href]) => href);
}

function imageCandidates(event) {
  return [...new Set(imageSources(event).map((source) => browserUrl(source, { relative: true })).filter(Boolean))];
}

function eventImage(event) {
  const sources = imageCandidates(event);
  const name = event.name || event.tokenName || shortAddress(event.address) || 'NFT';
  if (!sources.length) return '<span class="live-project-image empty" title="暂无可验证的项目标志">无图</span>';
  return `<span class="live-project-image"><span>无图</span><img src="${escapeHtml(sources[0])}" data-image-index="0" data-image-sources="${escapeHtml(JSON.stringify(sources))}" alt="${escapeHtml(name)} 项目标志" loading="eager" decoding="async"></span>`;
}

function pendingLabel(event, compact = false) {
  const coverage = event.pendingCoverage || event.pending_coverage || event.collection_snapshot?.pending_coverage;
  const count = event.pendingCount ?? event.pending_count ?? event.collection_snapshot?.pending_token_count;
  const unknown = Number(event.pendingUnknownTxCount ?? event.pending_unknown_tx_count ?? event.collection_snapshot?.pending_unknown_tx_count ?? 0);
  if (coverage === 'unavailable' || count === null || count === undefined) return compact ? '未知' : '待确认 —';
  const partial = coverage === 'partial' || unknown > 0;
  const details = [ ...(unknown > 0 ? [`另有 ${unknown} 笔数量未知`] : []), ...(coverage === 'partial' ? ['部分来源'] : coverage === 'observed' ? ['已观测来源'] : []) ];
  const suffix = details.length ? `，${details.join('，')}` : '';
  return compact ? `${partial ? '至少 ' : ''}${integer(count)} 个${suffix}` : `${partial ? '至少 ' : ''}${integer(count)} 个待确认${suffix}`;
}

function tokenRangeLabel(event) {
  const start = event.tokenIdRange?.start ?? event.tokenIds?.[0];
  const end = event.tokenIdRange?.end ?? event.tokenIds?.at?.(-1);
  if (start === null || start === undefined || start === '') return '';
  if (end === null || end === undefined || end === '' || String(start) === String(end)) return `#${start}`;
  return `#${start}-#${end}`;
}

function deployerProfile(value) {
  const profile = value?.deployerProfile || value?.deployer_profile || value?.collection_snapshot?.deployer_profile;
  if (!profile || typeof profile !== 'object') return null;
  const reasons = Array.isArray(profile.risk?.reasons) ? profile.risk.reasons.map(String) : Array.isArray(profile.reasons) ? profile.reasons.map(String) : [];
  return { address: profile.address || '', walletAgeDays: profile.walletAgeDays ?? profile.wallet_age_days ?? null, nftProjectCount: profile.nftProjectCount ?? profile.nft_project_count ?? null, risky: Boolean(profile.risk?.risky ?? profile.risky ?? reasons.length), reasons };
}

function deployerBadge(event, detailed = false) {
  const profile = deployerProfile(event);
  if (!profile) return detailed ? '<span class="live-deployer-risk unknown">部署者画像待回填</span>' : '';
  const age = profile.walletAgeDays === null ? '年龄未知' : `${integer(profile.walletAgeDays)} 天`;
  const projects = profile.nftProjectCount === null ? '项目未知' : `${integer(profile.nftProjectCount)} 个 NFT 项目`;
  return `<span class="live-deployer-risk ${profile.risky ? 'risky' : 'clear'}" title="${escapeHtml(profile.reasons.join(' · ') || '未命中部署者风险阈值')}">${detailed && profile.address ? `<code>${escapeHtml(short(profile.address))}</code>` : ''}<b>${escapeHtml(age)}</b><span>${escapeHtml(projects)}</span></span>`;
}

function tagBadges(event) {
  const tags = eventTags(event);
  return tags.length ? `<span class="live-row-tags">${tags.map((tag) => `<span class="${escapeHtml(tag.type)}">${escapeHtml(tag.label)}</span>`).join('')}</span>` : '';
}

function flagButton(event, form) {
  const address = String(event.address || event.contract || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return '';
  const active = Boolean(event.personalFlag);
  const busy = form.flags.busyAddress === address;
  const label = active ? '移除个人标记' : '添加个人标记';
  return `<button class="live-flag-button ${active ? 'active' : ''}" data-flag-address="${escapeHtml(address)}" type="button" title="${label}" aria-label="${label}" ${busy ? 'disabled' : ''}>${busy ? '…' : '⚑'}</button>`;
}

function linkBar(event, chain) {
  const links = eventLinks(event, chain);
  return links.length ? `<span class="live-links">${links.map(([label, title, href]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${escapeHtml(label)}</a>`).join('')}</span>` : '';
}

function renderEvent(event, chain, form, selected = false, mode = 'live') {
  const currentSupply = event.currentSupply ?? event.current_supply ?? event.collection_snapshot?.current_supply;
  const maxSupply = event.maxSupply ?? event.max_supply ?? event.collection_snapshot?.max_supply;
  const gas = event.gasLimit || event.gasUsed || '未知';
  const highGas = Number(gas || 0) > 200000;
  const method = event.methodName || event.method_name || event.selector || '方法未知';
  const tokenRange = tokenRangeLabel(event);
  const id = eventKey(event);
  const price = event.isFree ? '免费' : event.mintPrice || event.mint_price || '付费';
  const name = event.name || event.tokenName || event.symbol || shortAddress(event.address);
  const tokenStandard = event.tokenStandard || event.token_standard || 'NFT';
  const created = event.contractCreatedAt || event.contract_created_at;
  const quantity = event.quantity || event.mintQuantity || event.mint_quantity || '—';
  return `
    <article class="live-mint-row ${selected ? 'selected' : ''} ${highGas ? 'high-gas' : ''}" data-event-id="${escapeHtml(id)}" data-view-row="${escapeHtml(mode)}">
      <div class="live-row-top"><span>创建：${escapeHtml(relativeTime(created))}</span><span>每次铸造：${escapeHtml(quantity)}</span>${event.batchId ? `<b class="live-batch-count">x${escapeHtml(integer(event.count))}</b>` : ''}${tokenRange ? `<code class="live-token-range">${escapeHtml(tokenRange)}</code>` : ''}<span class="live-links">${linkBar(event, chain)}</span></div>
      <div class="live-row-main">
        ${eventImage(event)}
        <button class="live-project-copy" data-select-event="${escapeHtml(id)}" data-event-id="${escapeHtml(id)}" type="button"><strong>${escapeHtml(name)}</strong><span><code title="${escapeHtml(event.address || '')}">${escapeHtml(shortAddress(event.address))}</code></span><span class="live-project-facts"><b class="${event.isFree ? 'free' : 'paid'}">${escapeHtml(event.isFree ? '免费' : price)}</b><span>${escapeHtml(method)}</span><span>${escapeHtml(integer(currentSupply))} / ${escapeHtml(integer(maxSupply))}</span><span class="${Number(event.pendingCount) > 0 || Number(event.pendingUnknownTxCount) > 0 ? 'pending active' : 'pending'}">${escapeHtml(pendingLabel(event, true))}</span></span></button>
        <div class="live-row-meta"><span class="${highGas ? 'gas-warning' : ''}">Gas ${escapeHtml(integer(gas))}${event.gasFeeNative ? `<small>约 ${escapeHtml(compactNative(event.gasFeeNative))} ${escapeHtml(event.nativeSymbol || chain.nativeSymbol || '')}</small>` : ''}</span><span>${escapeHtml(tokenStandard)}</span>${deployerBadge(event)}</div>
        <button class="button primary select-mint-event" data-select-event="${escapeHtml(id)}" data-event-id="${escapeHtml(id)}" type="button">载入铸造</button>
      </div>
      <div class="live-row-actions"><span class="live-row-commands">${flagButton(event, form)}</span>${tagBadges(event)}${event.txHash ? `<code title="${escapeHtml(event.txHash)}">${escapeHtml(short(event.txHash, 6, 5))}</code>` : ''}</div>
    </article>
  `;
}

function sparkline(samples) {
  const values = (samples || []).map(Number).filter(Number.isFinite).slice(-60);
  if (!values.length) return '<span class="live-rate-sparkline empty" aria-label="等待速率样本"></span>';
  const width = 124; const height = 24; const maximum = Math.max(...values); const minimum = Math.min(...values); const range = maximum - minimum || 1;
  const points = values.map((value, index) => `${(values.length === 1 ? width : (index / (values.length - 1)) * width).toFixed(2)},${(height - 2 - ((value - minimum) / range) * (height - 4)).toFixed(2)}`).join(' ');
  return `<svg class="live-rate-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近 ${values.length} 个真实 MINT/S 样本" preserveAspectRatio="none"><polyline points="${points}" fill="none" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

function metricsStrip(form, state) {
  const data = form.data || {}; const metrics = data.chainMetrics || form.monitorStatus?.chainMetrics || {}; const chain = currentChain(state);
  const maxFee = metrics.maxFeeGwei ?? metrics.explorerGasGwei?.fast ?? metrics.gasPriceGwei ?? '—'; const priority = metrics.priorityFeeGwei ?? '—'; const base = metrics.baseFeeGwei ?? '—'; const block = metrics.blockNumber || data.chainHeadBlock || data.latestBlock || '—';
  const live = form.streamState === 'connected' && ['live', 'catching_up'].includes(data.mode || form.monitorStatus?.mode); const rate = Number(form.realtime.mintRate); const latency = Number(form.realtime.latencyMs);
  return `<section class="live-status-strip"><span class="live-state ${live ? 'active' : ''}"><i></i>${live ? '实时' : form.loading ? '连接中' : form.streamState === 'offline' ? '已断线' : '同步'}</span><span>区块 ${escapeHtml(integer(block))}</span><span>最高费 ${escapeHtml(maxFee)}</span><span>优先费 ${escapeHtml(priority)}（基础费 ${escapeHtml(base)}）</span><span>${escapeHtml(chain.nativeSymbol)} $${escapeHtml(metrics.coinPriceUsd ? Number(metrics.coinPriceUsd).toFixed(2) : '—')}</span><span class="live-rate-meter" title="${escapeHtml(form.realtime.source || '等待实时数据源')}"><small>MINT/S</small><strong>${form.realtime.mintRate !== null && Number.isFinite(rate) ? rate.toFixed(2) : '—'}</strong>${sparkline(form.realtime.rateSamples)}<span><small>${form.realtime.latencyMs !== null && Number.isFinite(latency) ? `${Math.round(latency)} ms` : '— ms'}</small><b>${escapeHtml(form.realtime.source || data.source || '等待数据源')}</b></span></span><button class="button secondary" id="open-live-filters" type="button">屏蔽设置</button><button class="icon-button live-refresh" id="refresh-live" type="button" title="刷新当前视图" aria-label="刷新当前视图">↻</button></section>`;
}

function toolbar(form, count) {
  const windows = form.view === 'trending' ? TRENDING_WINDOWS : OVERVIEW_WINDOWS; const active = form.view === 'trending' ? form.trendingWindow : form.overviewWindow; const labels = form.view === 'trending' ? TRENDING_WINDOW_LABELS : OVERVIEW_WINDOW_LABELS;
  const visible = normalizeVisibleCount(count);
  return `<section class="live-toolbar"><nav class="live-view-tabs" role="tablist" aria-label="NFT 盯盘视图">${Object.entries(VIEW_LABELS).map(([key, label]) => `<button type="button" role="tab" data-live-view="${key}" aria-selected="${String(form.view === key)}" class="${form.view === key ? 'active' : ''}">${label}</button>`).join('')}</nav>${form.view === 'alerts' ? '<span class="live-toolbar-spacer"></span>' : `<label class="live-search"><span>搜索</span><input name="keyword" value="${escapeHtml(form.filters.keyword)}" placeholder="名称、合约或方法" aria-label="搜索名称、合约或方法"></label>`}${['live', 'trending', 'overview'].includes(form.view) ? `<nav class="live-window-tabs" aria-label="时间窗口">${windows.map((seconds) => `<button type="button" data-live-window="${seconds}" class="${active === seconds ? 'active' : ''}">${labels[seconds]}</button>`).join('')}</nav>` : '<span></span>'}<span class="live-visible-count">${form.view === 'alerts' ? `${form.alerts.rules.length} 条规则` : `${visible} 条`}</span></section>`;
}

function filterPanel(form) {
  const toggles = [['hideFree', '隐藏免费'], ['hidePaid', '隐藏付费'], ['hideAirdrop', '隐藏空投'], ['hideErc1155', '隐藏 ERC1155'], ['hideHighGas', '隐藏 Gas > 20万'], ['hideUnknownSupply', '隐藏未知总量'], ['pendingOnly', '仅看待确认'], ['showFlagged', '显示个人标记']];
  return `<aside class="live-filter-panel ${form.filtersOpen ? '' : 'is-hidden'}" aria-label="实时铸造屏蔽设置"><header><strong>屏蔽设置</strong><button class="icon-button" id="close-live-filters" type="button" aria-label="关闭屏蔽设置" title="关闭">×</button></header><label class="field"><span>屏蔽关键词</span><input name="blockedKeywords" value="${escapeHtml(form.filters.blockedKeywords)}" placeholder="名称、地址或方法，逗号分隔"></label><label class="field"><span>屏蔽平台</span><input name="blockedPlatforms" value="${escapeHtml(form.filters.blockedPlatforms)}" placeholder="平台标签，逗号分隔"></label><div class="live-filter-checks">${toggles.map(([name, label]) => `<label class="toggle"><input name="${name}" type="checkbox" ${form.filters[name] ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div><button class="button secondary" id="reset-live-filters" type="button">重置全部</button></aside>`;
}

function viewNotices(form) {
  const notices = []; if (form.error) notices.push(`<div class="inline-alert">${escapeHtml(form.error)}</div>`); if (form.flags.error) notices.push(`<div class="inline-alert">个人标记：${escapeHtml(form.flags.error)}</div>`); if (form.replayNotice) notices.push(`<div class="live-stream-notice">${escapeHtml(form.replayNotice)}</div>`);
  if ((form.data?.providerError || form.data?.scanError) && ['live', 'overview'].includes(form.view)) notices.push(`<div class="live-stream-notice">第三方源未响应，当前使用所选链 RPC 实时扫描。${escapeHtml(form.data.providerError || form.data.scanError)}</div>`);
  if (form.streamState === 'offline' && form.loaded) notices.push('<div class="live-stream-notice error">实时连接已断开，浏览器正在自动重连；当前列表保留最近一次真实快照。</div>');
  return notices.join('');
}

function renderCollectionDetail(form, chain, selected) {
  if (!selected) return ''; const detail = form.detail.collection; const recent = detail?.recent_mints || selected.recentMints || [];
  return `<section class="live-detail-strip" aria-label="所选合集详情"><header><span><strong>${escapeHtml(selected.name || selected.tokenName || shortAddress(selected.address))}</strong><code>${escapeHtml(shortAddress(selected.address))}</code></span>${form.detail.loading ? '<small>正在读取合集详情</small>' : form.detail.error ? `<small class="error">${escapeHtml(form.detail.error)}</small>` : '<small>合集详情</small>'}</header><div class="live-detail-stats"><span><small>供应量</small><strong>${escapeHtml(integer(selected.currentSupply))} / ${escapeHtml(integer(selected.maxSupply))}</strong></span><span><small>待确认</small><strong>${escapeHtml(pendingLabel(selected, true))}</strong></span><span><small>独立铸造者</small><strong>${escapeHtml(integer(detail?.unique_minters ?? selected.uniqueMinters))}</strong></span><span><small>地板价</small><strong>${escapeHtml(detail?.floor_price_eth ?? selected.floorPriceEth ?? '—')} ${escapeHtml(chain.nativeSymbol || '')}</strong></span>${deployerBadge(selected, true)}</div>${recent.length ? `<div class="live-detail-recent"><strong>最近铸造</strong>${recent.slice(0, 4).map((mint) => { const hash = mint.tx_hash || mint.txHash || ''; const href = explorerUrl(chain, 'tx', hash); return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="查看交易">${escapeHtml(short(hash, 6, 5))}<small>${escapeHtml(mint.quantity || '1')} 个</small></a>` : ''; }).join('')}</div>` : ''}</section>`;
}

function renderTrending(rows, chain, form, selected) {
  return `<div class="table-scroll live-intel-table" aria-label="Trending 多窗口排名"><table><thead><tr><th>#</th><th>合集</th><th>铸造</th><th>钱包 / 交易</th><th>价格 / 地板</th><th>部署者风险</th><th>最近</th><th>操作</th></tr></thead><tbody>${rows.map((row, index) => {
    const event = normalizeTrendingEvent(row, chain.id); const id = eventKey(event); const active = String(selected?.address || '').toLowerCase() === String(row.address || '').toLowerCase();
    return `<tr class="${active ? 'selected' : ''}"><td><button class="table-link" data-select-event="${escapeHtml(id)}" type="button">${escapeHtml(row.rank || index + 1)}</button></td><td><button class="live-table-identity" data-select-event="${escapeHtml(id)}" type="button">${eventImage(event)}<span><strong>${escapeHtml(row.name || shortAddress(row.address))}</strong><code>${escapeHtml(shortAddress(row.address))}</code></span></button></td><td class="positive">+${escapeHtml(integer(row.mintCount))}</td><td><strong>${escapeHtml(integer(row.uniqueMinters))}</strong><small>${escapeHtml(integer(row.txCount))} 笔</small></td><td><strong>${escapeHtml(row.mintPrice || (row.mintValueWei === '0' ? '免费' : '—'))}</strong><small>地板 ${escapeHtml(row.floorPriceEth ?? '—')}</small></td><td>${deployerBadge(event) || '—'}</td><td><strong>${escapeHtml(relativeTime(row.lastMintAt))}</strong><small>${escapeHtml(row.tokenStandard || 'NFT')}</small></td><td><span class="table-actions"><button class="button secondary" data-select-event="${escapeHtml(id)}" type="button">载入</button>${flagButton(event, form)}</span></td></tr>`;
  }).join('') || `<tr><td colspan="8" class="empty-cell">${form.trending.loading ? '正在读取真实排名' : form.trending.error ? escapeHtml(form.trending.error) : '当前窗口暂无排名'}</td></tr>`}</tbody></table></div>`;
}

function renderRadar(rows, chain, form, selected) {
  return `<div class="radar-filter-bar"><nav class="radar-price-filter" aria-label="价格筛选">${[['all', '全部'], ['free', '免费'], ['paid', '付费']].map(([value, label]) => `<button data-radar-price="${value}" class="${form.radarFilters.price === value ? 'active' : ''}" type="button">${label}</button>`).join('')}</nav><label class="toggle"><input name="radarPublicOnly" type="checkbox" ${form.radarFilters.publicOnly ? 'checked' : ''}><span>仅公开阶段</span></label><label class="toggle"><input name="radarLiveOnly" type="checkbox" ${form.radarFilters.liveOnly ? 'checked' : ''}><span>仅进行中</span></label><button class="button secondary" id="refresh-radar" type="button" ${form.radar.loading ? 'disabled' : ''}>刷新雷达</button></div>${form.radar.scanError ? `<div class="live-stream-notice">扫描状态：${escapeHtml(form.radar.scanError)}</div>` : ''}${form.radar.error ? `<div class="live-stream-notice error">${escapeHtml(form.radar.error)}</div>` : ''}<div class="table-scroll live-intel-table radar-table" aria-label="SeaDrop 即将开售"><table><thead><tr><th>阶段 / 时间</th><th>合集</th><th>价格</th><th>每钱包</th><th>资格</th><th>执行</th></tr></thead><tbody>${rows.map((drop) => {
    const timing = radarTiming(drop, form.nowMs); const countdown = timing.state === 'live' ? '进行中' : timing.state === 'ended' ? '已结束' : timing.state === 'unscheduled' ? '待排期' : formatRadarCountdown(timing.remainingMs); const event = normalizeRadarEvent(drop, chain); const id = eventKey(event); const active = String(selected?.id || '') === id;
    return `<tr class="radar-${timing.state} ${active ? 'selected' : ''}"><td><b class="radar-stage">${escapeHtml(drop.label || drop.stageType || '阶段')}</b><strong>${escapeHtml(countdown)}</strong><small>${escapeHtml(formatRadarDateTime(drop.startTime))}</small></td><td><button class="live-table-identity" data-select-event="${escapeHtml(id)}" type="button">${eventImage(event)}<span><strong>${escapeHtml(drop.name || shortAddress(drop.contract))}</strong><code>${escapeHtml(shortAddress(drop.contract))}</code></span></button></td><td><strong>${escapeHtml(event.mintPrice || '—')}</strong><small>${drop.feeBps ? `${escapeHtml(drop.feeBps)} bps` : '费用未公布'}</small></td><td><strong>${escapeHtml(drop.maxPerWallet || '—')}</strong><small>${drop.maxSupplyForStage ? `阶段 ${escapeHtml(drop.maxSupplyForStage)}` : '阶段上限未知'}</small></td><td><strong>${drop.requiresCredentials ? '需要凭据' : '公开'}</strong><a href="/tool/highHexMint/signTask?contractAddress=${encodeURIComponent(drop.contract || '')}" target="_top">资格检查</a></td><td><span class="table-actions"><button class="button secondary" data-select-event="${escapeHtml(id)}" type="button">载入</button>${flagButton(event, form)}</span></td></tr>`;
  }).join('') || `<tr><td colspan="6" class="empty-cell">${form.radar.loading ? '正在读取真实 SeaDrop 阶段' : '当前筛选暂无 SeaDrop 阶段'}</td></tr>`}</tbody></table></div>`;
}

function alertRuleSummary(rule) {
  if (rule.type === 'trending') return `${TRENDING_WINDOW_LABELS[rule.params?.window] || rule.params?.window} ≥ ${rule.params?.threshold}`;
  if (rule.type === 'seadrop_start') return `提前 ${rule.params?.leadMinutes} 分钟${rule.params?.address ? ` · ${short(rule.params.address)}` : ''}`;
  return short(rule.params?.address);
}

function notificationPermission() {
  return typeof Notification === 'undefined' ? '不支持' : ({ granted: '已允许', denied: '已拒绝', default: '未询问' }[Notification.permission] || Notification.permission);
}

function renderAlertFields(draft) {
  if (draft.type === 'trending') return `<div class="alert-form-pair"><label><span>窗口</span><select name="window">${TRENDING_WINDOWS.map((value) => `<option value="${value}" ${String(value) === String(draft.window) ? 'selected' : ''}>${TRENDING_WINDOW_LABELS[value]}</option>`).join('')}</select></label><label><span>铸造阈值</span><input name="threshold" type="number" min="1" value="${escapeHtml(draft.threshold)}"></label></div>`;
  const label = draft.type === 'wallet_activity' ? '钱包地址' : `合约地址${draft.type === 'seadrop_start' ? '（可选）' : ''}`;
  return `<label><span>${label}</span><input name="address" value="${escapeHtml(draft.address)}" placeholder="0x..." spellcheck="false"></label>${draft.type === 'seadrop_start' ? `<label><span>提前分钟</span><input name="leadMinutes" type="number" min="0" value="${escapeHtml(draft.leadMinutes)}"></label>` : ''}`;
}

function renderAlerts(form) {
  const draft = form.alertDraft; const enabled = form.alerts.rules.filter((rule) => rule.enabled).length;
  return `<div class="alerts-workspace"><section class="alert-preferences"><span><strong>浏览器报警</strong><small>桌面权限：${escapeHtml(notificationPermission())}</small></span><label class="toggle"><input name="alertSound" type="checkbox" ${form.alertPreferences.sound ? 'checked' : ''}><span>声音</span></label><label class="toggle"><input name="alertDesktop" type="checkbox" ${form.alertPreferences.desktop ? 'checked' : ''}><span>桌面通知</span></label><span class="notifier-state ${form.alerts.notifier?.enabled ? 'active' : ''}">Telegram ${form.alerts.notifier?.enabled ? '已配置' : '未配置'}</span><button class="button secondary" id="test-alert" type="button" ${form.alerts.loading ? 'disabled' : ''}>测试</button><button class="button secondary" id="refresh-alerts" type="button" ${form.alerts.loading ? 'disabled' : ''}>刷新</button></section>${form.alerts.error ? `<div class="live-stream-notice error">${escapeHtml(form.alerts.error)}</div>` : ''}<div class="alerts-layout"><form class="alert-rule-form" id="alert-rule-form"><header><strong>${form.editingAlertId ? '编辑报警规则' : '新建报警规则'}</strong>${form.editingAlertId ? '<button class="table-link" id="cancel-alert-edit" type="button">结束编辑</button>' : ''}</header><label><span>类型</span><select name="type">${Object.entries(ALERT_TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${draft.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>名称</span><input name="name" value="${escapeHtml(draft.name)}" placeholder="${escapeHtml(ALERT_TYPE_LABELS[draft.type] || '报警规则')}"></label>${renderAlertFields(draft)}<div class="alert-form-pair"><label><span>冷却秒数</span><input name="cooldownSeconds" type="number" min="0" value="${escapeHtml(draft.cooldownSeconds)}"></label><label class="toggle"><input name="enabled" type="checkbox" ${draft.enabled ? 'checked' : ''}><span>立即启用</span></label></div><button class="button primary" type="submit" ${form.alerts.loading ? 'disabled' : ''}>${form.editingAlertId ? '保存修改' : '创建规则'}</button></form><section class="alert-rule-list"><header><strong>规则</strong><span>${enabled}/${form.alerts.rules.length} 启用</span></header>${form.alerts.rules.map((rule) => `<article class="alert-rule-row"><i class="${rule.enabled ? 'active' : ''}"></i><span><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(ALERT_TYPE_LABELS[rule.type] || rule.type)} · ${escapeHtml(alertRuleSummary(rule))}</small></span><span><small>冷却</small><strong>${escapeHtml(rule.cooldownSeconds)}s</strong></span><button class="button secondary" data-alert-toggle="${escapeHtml(rule.id)}" data-alert-enabled="${String(!rule.enabled)}" type="button">${rule.enabled ? '暂停' : '启用'}</button><button class="icon-button" data-alert-edit="${escapeHtml(rule.id)}" type="button" title="编辑 ${escapeHtml(rule.name)}" aria-label="编辑 ${escapeHtml(rule.name)}">✎</button><button class="icon-button danger" data-alert-delete="${escapeHtml(rule.id)}" type="button" title="删除 ${escapeHtml(rule.name)}" aria-label="删除 ${escapeHtml(rule.name)}">×</button></article>`).join('') || `<div class="empty-state">${form.alerts.loading ? '正在读取报警规则' : '暂无报警规则'}</div>`}</section></div><section class="alert-history"><header><strong>最近报警</strong><span>${form.alertHistory.length}</span></header>${form.alertHistory.map((alert) => `<article><span><strong>${escapeHtml(alert.title || ALERT_TYPE_LABELS[alert.alertType] || '监控报警')}</strong><small>${escapeHtml(alert.message || '')}</small></span><time>${escapeHtml(alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleTimeString('zh-CN') : '刚刚')}</time></article>`).join('') || '<div class="empty-state">当前会话暂无报警</div>'}</section></div>`;
}

function rowsForView(form, chain) {
  const options = { showFlagged: form.filters.showFlagged };
  if (form.view === 'live') return collectionsWithFlags(stableRealtimeOrder(enrichRealtimeEvents(form.realtime.events, form.data), form.frozenOrder), form.flags.items, options).filter((event) => eventMatches(event, form.filters));
  if (form.view === 'overview') return collectionsWithFlags((form.data?.windows?.[String(form.overviewWindow)] || []).map((row) => normalizeOverviewEvent(row, form.overviewWindow)), form.flags.items, options).filter((event) => eventMatches(event, form.filters));
  if (form.view === 'trending') return collectionsWithFlags((form.trending.windows[String(form.trendingWindow)] || []).map((row) => normalizeTrendingEvent(row, chain.id)), form.flags.items, options).filter((event) => eventMatches(event, form.filters));
  if (form.view === 'radar') return collectionsWithFlags(filterRadarDrops(form.radar.drops, { ...form.radarFilters, query: form.filters.keyword }, form.nowMs), form.flags.items, options);
  return [];
}

function allSelectableEvents(form, chain) {
  const live = enrichRealtimeEvents(form.realtime.events, form.data);
  const overview = (form.data?.windows?.[String(form.overviewWindow)] || []).map((row) => normalizeOverviewEvent(row, form.overviewWindow));
  const trending = (form.trending.windows[String(form.trendingWindow)] || []).map((row) => normalizeTrendingEvent(row, chain.id));
  const radar = form.radar.drops.map((drop) => normalizeRadarEvent(drop, chain));
  return [...live, ...overview, ...trending, ...radar];
}

function selectedEvent(form, chain) {
  if (!form.selectedEventId) return null;
  const current = allSelectableEvents(form, chain).find((event) => eventKey(event) === form.selectedEventId) || form.selectedEvent;
  if (!current) return null;
  const detailed = mergeCollectionDetailIntoEvent(current, form.detail.collection);
  return collectionsWithFlags([detailed], form.flags.items, { showFlagged: true })[0] || detailed;
}

function renderView(form, rows, chain) {
  const selected = selectedEvent(form, chain);
  if (form.view === 'live' || form.view === 'overview') {
    const label = form.view === 'live' ? '实时 NFT 铸造列表' : 'NFT 铸造概览';
    const firstBatch = Number(globalThis.innerWidth || 1280) <= 760 ? 24 : 40;
    const visibleRows = rows.slice(0, firstBatch);
    const more = rows.length > firstBatch ? `<div class="live-feed-more" data-live-feed-more="${firstBatch}" aria-live="polite">正在准备更多记录（${rows.length - firstBatch}）</div>` : '';
    return `<section class="live-mint-list" data-live-feed aria-label="${label}">${visibleRows.map((event) => renderEvent(event, chain, form, eventKey(event) === form.selectedEventId, form.view)).join('') || `<div class="empty-state">${form.loading ? '正在同步真实链上数据' : form.view === 'live' ? '等待符合条件的链上铸造记录' : '当前窗口暂无合集'}</div>`}${more}</section>`;
  }
  if (form.view === 'trending') return renderTrending(rows, chain, form, selected);
  if (form.view === 'radar') return renderRadar(rows, chain, form, selected);
  return renderAlerts(form);
}

function scheduleRender(form, render) {
  if (form.disposed) return;
  if (!form.renderScheduler) form.renderScheduler = createRenderScheduler({ render: () => { if (!form.disposed) render(); } });
  form.renderRevision += 1;
  form.renderScheduler.invalidate('runtime', String(form.renderRevision));
}

function cachePayloadFor(form) {
  return {
    cursor: form.streamCoordinator?.status().lastEventId || form.store?.getState().cursor || null,
    overview: form.data,
    events: form.realtime?.events || [],
    trending: form.trending,
    radar: form.radar,
    flags: form.flags.items,
    status: form.monitorStatus,
  };
}

function scheduleCacheSave(form) {
  if (form.disposed || form.cacheSaveTimer) return;
  const save = () => {
    form.cacheSaveTimer = null;
    try { form.cache.save(form.chainId, form.overviewWindow, cachePayloadFor(form)); form.lastCacheSavedAt = Date.now(); form.diagnostics.record('cache', 'snapshot_saved', { chainId: form.chainId, overviewWindow: form.overviewWindow }); }
    catch (error) { form.diagnostics.record('cache', 'snapshot_save_failed', { message: error.message }); }
  };
  form.cacheSaveTimer = window.setTimeout(save, 5000);
}

function applyCachedPayload(form, cached, render) {
  if (!cached || form.disposed) return false;
  const overview = cached.overview || cached.data || (cached.partial ? cached : null);
  if (overview) form.data = overview;
  if (Array.isArray(cached.events)) form.realtime = replaceRealtimeOverview(form.realtime, cached.events);
  if (cached.trending) Object.assign(form.trending, cached.trending);
  if (cached.radar) Object.assign(form.radar, cached.radar);
  if (Array.isArray(cached.flags)) form.flags.items = cached.flags;
  form.monitorStatus = cached.status || form.monitorStatus;
  form.cacheSavedAt = cached.savedAt || null;
  form.snapshotConfirmed = false;
  form.store?.markCached(cached);
  form.diagnostics.record('cache', 'cache_applied', { chainId: form.chainId, overviewWindow: form.overviewWindow, savedAt: cached.savedAt || null });
  scheduleRender(form, render);
  return true;
}

function ensureStoreWindow(form, overviewWindow) {
  const target = Number(overviewWindow);
  if (form.store?.getState().overviewWindow === target) return;
  form.store = createMonitorStore({ chainId: form.chainId, overviewWindow: target });
  form.cacheLoaded = false;
  form.snapshotConfirmed = false;
  form.cacheSavedAt = null;
  if (form.cacheSaveTimer) { window.clearTimeout(form.cacheSaveTimer); form.cacheSaveTimer = null; }
}

function diagnosticsPanel(form) {
  const stream = form.streamCoordinator?.status() || {};
  const render = form.renderScheduler?.metrics() || {};
  const rpc = form.monitorStatus?.rpc || {};
  const lastMessage = stream.lastMessageAt ? relativeTime(stream.lastMessageAt) : '—';
  return `<details class="monitor-diagnostics"><summary>本地诊断</summary><div class="monitor-diagnostics-grid"><span>缓存年龄<strong>${form.cacheSavedAt ? relativeTime(form.cacheSavedAt) : '无'}</strong></span><span>最后 Cursor<strong>${escapeHtml(stream.lastEventId || form.store?.getState().cursor || '—')}</strong></span><span>最后消息<strong>${escapeHtml(lastMessage)}</strong></span><span>重连次数<strong>${escapeHtml(stream.reconnects ?? 0)}</strong></span><span>渲染 P95<strong>${escapeHtml(render.p95Ms ?? 0)} ms</strong></span><span>长任务<strong>${escapeHtml(render.longTasks ?? 0)}</strong></span><span>RPC 状态<strong>${escapeHtml(rpc.state || '未探测')} ${escapeHtml(rpc.activeHost || '')}</strong></span></div><div class="monitor-diagnostics-actions"><button class="button secondary" id="export-monitor-diagnostics" type="button">导出诊断 JSON</button><button class="button secondary" id="clear-monitor-cache" type="button">清除监控缓存</button></div></details>`;
}

function prefetchImages(value) {
  if (typeof Image === 'undefined') return;
  const now = Date.now();
  for (const source of imageSources(value).slice(0, PREFETCH_LIMIT)) {
    const href = browserUrl(source, { relative: true });
    if (!href) continue;
    const lastSeen = prefetchedImageUrls.get(href);
    if (lastSeen && now - lastSeen < PREFETCH_TTL_MS) continue;
    prefetchedImageUrls.delete(href);
    prefetchedImageUrls.set(href, now);
    while (prefetchedImageUrls.size > PREFETCH_CACHE_LIMIT) prefetchedImageUrls.delete(prefetchedImageUrls.keys().next().value);
    const image = new Image();
    image.decoding = 'async';
    image.onload = image.onerror = () => { image.onload = null; image.onerror = null; };
    image.src = href;
  }
}

function applyTrending(form, payload) {
  if (!payload || !Number.isFinite(Number(payload.window))) return;
  form.trending.windows[String(Number(payload.window))] = payload.collections || [];
  form.trending.snapshotId = payload.snapshotId || form.trending.snapshotId;
  form.trending.generatedAt = payload.generatedAt || form.trending.generatedAt;
  form.trending.error = '';
}

function applyRadar(form, payload) {
  form.radar.drops = payload?.drops || [];
  form.radar.snapshotId = payload?.snapshotId || form.radar.snapshotId;
  form.radar.generatedAt = payload?.generatedAt || form.radar.generatedAt;
  form.radar.scanError = payload?.scanError || '';
  form.radar.error = '';
}

async function loadBootstrap(form, state, render) {
  ensureStoreWindow(form, form.overviewWindow);
  const requestId = ++form.requestId; const chainId = Number(state.chainId); form.loading = true; form.error = ''; form.snapshotConfirmed = false; form.store.beginSynchronizing('bootstrap'); render();
  if (!form.cacheLoaded) {
    form.cacheLoaded = true;
    try { applyCachedPayload(form, await form.cache.load(chainId, form.overviewWindow), render); }
    catch (error) { form.diagnostics.record('cache', 'cache_load_failed', { message: error.message }); }
  }
  try {
    const payload = await api(`/api/bootstrap?chainId=${chainId}&window=${Number(form.overviewWindow)}`);
    if (form.disposed || requestId !== form.requestId || chainId !== Number(state.chainId)) return;
    form.data = payload.overview || null; form.monitorStatus = payload.status || null; form.realtime = replaceRealtimeOverview(form.realtime, payload.overview?.events || []); applyTrending(form, payload.trending); applyRadar(form, payload.radar); form.flags.items = payload.flags || []; form.flags.error = ''; form.store.applySnapshot(payload, { cursor: payload.realtimeCursor, snapshotVersion: payload.snapshotVersion }); form.snapshotConfirmed = true; form.replayNotice = ''; prefetchImages(payload); form.diagnostics.record('snapshot', 'bootstrap_applied', { chainId, cursor: payload.realtimeCursor || null }); startStream(form, state, render); scheduleCacheSave(form);
  } catch (error) { if (!form.disposed && requestId === form.requestId) { form.error = error.message; form.streamState = 'offline'; form.store.setStatus(form.data ? 'degraded' : 'cold', 'bootstrap_failed'); form.diagnostics.record('snapshot', 'bootstrap_failed', { chainId, message: error.message }); startStream(form, state, render); } }
  finally { if (!form.disposed && requestId === form.requestId) { form.loading = false; render(); } }
}

async function loadOverview(form, state, render) {
  ensureStoreWindow(form, form.overviewWindow);
  const requestId = ++form.requestId; const chainId = Number(state.chainId); form.loading = true; form.error = ''; form.store.beginSynchronizing('overview_refresh'); render();
  try {
    const payload = await api(`/api/mint-monitor/overview?chainId=${chainId}&window=${Number(form.overviewWindow)}`);
    if (form.disposed || requestId !== form.requestId || chainId !== Number(state.chainId)) return;
    form.data = payload; form.realtime = replaceRealtimeOverview(form.realtime, payload.events || []); form.store.applySnapshot({ overview: payload }, { cursor: form.streamCoordinator?.status().lastEventId || form.store.getState().cursor }); form.snapshotConfirmed = true; form.replayNotice = ''; prefetchImages(payload); scheduleCacheSave(form);
  } catch (error) { if (!form.disposed && requestId === form.requestId) { form.error = error.message; form.store.setStatus(form.data ? 'degraded' : 'cold', 'overview_failed'); } }
  finally { if (!form.disposed && requestId === form.requestId) { form.loading = false; render(); } }
}

async function loadTrending(form, state, render, seconds = form.trendingWindow) {
  const windowSeconds = Number(seconds); form.trending.loading = true; form.trending.error = ''; render();
  try {
    const payload = await api(`/api/mint-monitor/trending?chainId=${Number(state.chainId)}&window=${windowSeconds}&limit=50`);
    if (form.disposed || windowSeconds !== Number(form.trendingWindow)) return;
    applyTrending(form, payload); prefetchImages(payload);
  } catch (error) { if (!form.disposed && windowSeconds === Number(form.trendingWindow)) form.trending.error = error.message; }
  finally { if (!form.disposed && windowSeconds === Number(form.trendingWindow)) { form.trending.loading = false; render(); } }
}

async function loadRadar(form, state, render) {
  form.radar.loading = true; form.radar.error = ''; render();
  try {
    const payload = await api(`/api/seadrop-radar?chainId=${Number(state.chainId)}&includeUnscheduled=true`);
    if (form.disposed) return;
    applyRadar(form, payload); prefetchImages(payload);
  } catch (error) { if (!form.disposed) form.radar.error = error.message; }
  finally { if (!form.disposed) { form.radar.loading = false; render(); } }
}

async function loadFlags(form, state, render) {
  form.flags.loading = true; form.flags.error = '';
  try {
    const payload = await api(`/api/collections/flags?chainId=${Number(state.chainId)}`);
    if (!form.disposed) form.flags.items = payload.flags || [];
  } catch (error) { if (!form.disposed) form.flags.error = error.message; }
  finally { if (!form.disposed) { form.flags.loading = false; render(); } }
}

async function loadAlerts(form, state, render, { quiet = false } = {}) {
  form.alerts.loading = true; form.alerts.error = ''; if (!quiet) render();
  try {
    const payload = await api(`/api/alerts?chainId=${Number(state.chainId)}`);
    if (form.disposed) return;
    form.alerts.rules = payload.rules || []; form.alerts.notifier = payload.notifier || null;
  } catch (error) { if (!form.disposed) form.alerts.error = error.message; }
  finally { if (!form.disposed) { form.alerts.loading = false; render(); } }
}

async function loadCollection(form, state, event, render) {
  const address = String(event?.address || '').trim().toLowerCase(); form.detail.controller?.abort(); const requestId = ++form.detail.requestId;
  if (!/^0x[a-f0-9]{40}$/.test(address) || event.radarDrop) { Object.assign(form.detail, { address, collection: null, loading: false, error: '', controller: null }); render(); return; }
  const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), 8000); Object.assign(form.detail, { address, collection: null, loading: true, error: '', controller }); render();
  try {
    const payload = await api(`/api/mint-monitor/collection/${encodeURIComponent(address)}?chainId=${Number(state.chainId)}`, { signal: controller.signal });
    if (form.disposed || requestId !== form.detail.requestId) return;
    form.detail.collection = payload.collection || null; prefetchImages(payload.collection);
  } catch (error) {
    if (!form.disposed && requestId === form.detail.requestId) form.detail.error = error.name === 'AbortError' ? '合集详情请求超时' : error.message;
  } finally { window.clearTimeout(timer); if (!form.disposed && requestId === form.detail.requestId) { form.detail.loading = false; form.detail.controller = null; render(); } }
}

async function toggleFlag(form, state, address, render) {
  const normalized = String(address || '').toLowerCase(); const active = form.flags.items.some((flag) => String(flag.address || '').toLowerCase() === normalized); form.flags.busyAddress = normalized; form.flags.error = ''; render();
  try {
    if (active) await api(`/api/collections/${encodeURIComponent(normalized)}/flag?chainId=${Number(state.chainId)}`, { method: 'DELETE' });
    else await api(`/api/collections/${encodeURIComponent(normalized)}/flag`, { method: 'POST', body: JSON.stringify({ chainId: Number(state.chainId), flag: 'scam', note: '' }) });
    await loadFlags(form, state, render);
  } catch (error) { form.flags.error = error.message; }
  finally { form.flags.busyAddress = ''; render(); }
}

function playAlertSound() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext; if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = 720; gain.gain.setValueAtTime(0.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.14); oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.15); oscillator.addEventListener('ended', () => void context.close());
  } catch { /* Browser autoplay policy may suppress the tone. */ }
}

function publishAlert(form, alert, render) {
  const memory = rememberAlertId(form.alertIds, alert?.id); form.alertIds = memory.ids; if (memory.duplicate) return false;
  form.alertHistory = [alert, ...form.alertHistory].slice(0, 20); if (form.alertPreferences.sound) playAlertSound();
  if (form.alertPreferences.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(alert.title || 'NFT 监控报警', { body: alert.message || '', tag: alert.id || undefined }); } catch { /* In-page history remains authoritative. */ }
  }
  render(); return true;
}

async function saveAlertRule(form, state, render) {
  form.alerts.loading = true; form.alerts.error = ''; render();
  try {
    const payload = buildAlertPayload(form.alertDraft, state.chainId);
    if (form.editingAlertId) await api(`/api/alerts/${encodeURIComponent(form.editingAlertId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/alerts', { method: 'POST', body: JSON.stringify(payload) });
    form.editingAlertId = ''; form.alertDraft = alertDraftFromRule(); await loadAlerts(form, state, render, { quiet: true });
  } catch (error) { form.alerts.error = error.message; }
  finally { form.alerts.loading = false; render(); }
}

async function updateAlertRule(form, state, id, patch, render) {
  form.alerts.loading = true; form.alerts.error = ''; render();
  try { await api(`/api/alerts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...patch, chainId: Number(state.chainId) }) }); await loadAlerts(form, state, render, { quiet: true }); }
  catch (error) { form.alerts.error = error.message; }
  finally { form.alerts.loading = false; render(); }
}

async function deleteAlertRule(form, state, id, render) {
  form.alerts.loading = true; form.alerts.error = ''; render();
  try { await api(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (form.editingAlertId === id) { form.editingAlertId = ''; form.alertDraft = alertDraftFromRule(); } await loadAlerts(form, state, render, { quiet: true }); }
  catch (error) { form.alerts.error = error.message; }
  finally { form.alerts.loading = false; render(); }
}

async function testAlert(form, state, render) {
  form.alerts.loading = true; form.alerts.error = ''; render();
  try {
    const payload = await api('/api/alerts/test', { method: 'POST', body: JSON.stringify({ chainId: Number(state.chainId), title: 'NFT TOOL 测试报警', message: '报警通道工作正常' }) });
    publishAlert(form, payload.alert || {}, render);
  } catch (error) { form.alerts.error = error.message; }
  finally { form.alerts.loading = false; render(); }
}

function applyMinterBackfill(form, value) {
  if (!form.data) return; const address = String(value.address || '').toLowerCase(); const update = { unique_minters: value.unique_minters, unique_minters_status: value.unique_minters_status, unique_minters_error: value.unique_minters_error, unique_minters_pages_scanned: value.unique_minters_pages_scanned, unique_minters_updated_at: value.unique_minters_updated_at };
  form.data = { ...form.data, windows: Object.fromEntries(Object.entries(form.data.windows || {}).map(([window, rows]) => [window, rows.map((row) => String(row.address || '').toLowerCase() === address ? { ...row, ...update } : row)])) };
  if (String(form.detail.collection?.address || '').toLowerCase() === address) form.detail.collection = { ...form.detail.collection, ...update };
}

function scheduleOverviewRefresh(form, state, render) {
  if (form.refreshTimer || form.disposed) return;
  form.refreshTimer = window.setTimeout(() => { form.refreshTimer = null; void loadOverview(form, state, render); }, 1000);
}

function applyStreamValue(form, state, value, render, cursor = null) {
  const previousStoreState = form.store?.getState();
  const accepted = form.store?.receive({ cursor, value });
  if (previousStoreState?.synchronizing && value?.type !== 'replay_reset') return;
  if (accepted && form.store) form.realtime = form.store.getState().realtime;
  const realtimeTypes = ['mint', 'mint_batch', 'mint_update', 'heartbeat', 'collection_update', 'collection_patch', 'discard', 'replay_reset', 'minter_backfill_update', 'monitor_status'];
  if (realtimeTypes.includes(value.type) && !accepted) form.realtime = reduceRealtimeState(form.realtime, value);
  if (['mint', 'mint_batch'].includes(value.type)) scheduleOverviewRefresh(form, state, render);
  else if (value.type === 'mint_update' && form.data) form.data = { ...form.data, events: (form.data.events || []).map((event) => event.id === value.id ? { ...event, ...value } : event) };
  else if (['collection_update', 'collection_patch'].includes(value.type)) {
    form.data = applyCollectionUpdate(form.data, value);
    if (String(form.detail.collection?.address || '').toLowerCase() === String(value.address || '').toLowerCase()) form.detail.collection = mergeSnapshotIntoRow(form.detail.collection, value.collection_snapshot);
  } else if (value.type === 'discard') {
    const discarded = new Set((value.eventIds || []).map(String)); if (form.data) form.data = { ...form.data, events: (form.data.events || []).filter((event) => !discarded.has(String(event.id || ''))) }; scheduleOverviewRefresh(form, state, render);
  } else if (value.type === 'replay_reset') { form.replayNotice = '实时回放已重置，正在重新同步当前窗口。'; form.snapshotConfirmed = false; void loadBootstrap(form, state, render); }
  else if (value.type === 'minter_backfill_update') applyMinterBackfill(form, value);
  else if (value.type === 'monitor_status') { form.monitorStatus = value; if (form.data) form.data = { ...form.data, ...value, mode: value.status || value.mode || form.data.mode }; }
  else if (value.type === 'trending_snapshot') applyTrending(form, value);
  else if (value.type === 'seadrop_radar') applyRadar(form, value);
  else if (value.type === 'monitor_alert') publishAlert(form, value, render);
  if (value.type === 'heartbeat') {
    const metrics = form.boundRoot?.querySelector('.live-status-strip');
    if (metrics) metrics.outerHTML = metricsStrip(form, state);
    form.diagnostics.record('render', 'heartbeat_metrics_only');
    return;
  }
  if (['mint', 'mint_batch', 'mint_update', 'collection_update', 'collection_patch', 'seadrop_radar'].includes(value.type)) prefetchImages(value);
  scheduleCacheSave(form);
  scheduleRender(form, render);
}

function startStream(form, state, render) {
  if (form.streamCoordinator || typeof EventSource === 'undefined') return;
  const coordinator = createMonitorStreamCoordinator({
    chainId: Number(state.chainId),
    getCursor: () => form.store?.getState().cursor || null,
    onState: (next) => { if (!form.disposed) { form.streamState = next.state === 'live' ? 'connected' : next.state === 'offline' ? 'offline' : next.state; form.diagnostics.record('stream', 'state', next); scheduleRender(form, render); } },
    onNeedSynchronize: (value) => { if (!form.disposed) { form.store.receive(value); form.realtime = form.store.getState().realtime; form.replayNotice = '实时回放已重置，正在重新同步当前窗口。'; void loadBootstrap(form, state, render); } },
    onMessage: ({ cursor, value }) => { if (!form.disposed) applyStreamValue(form, state, value, render, cursor); },
  });
  form.streamCoordinator = coordinator; form.stream = { close: () => coordinator.stop() }; coordinator.start();
}

function bindImages(root) {
  root.querySelectorAll('.live-project-image img').forEach((image) => {
    const markLoaded = () => image.classList.add('loaded'); image.addEventListener('load', markLoaded);
    image.addEventListener('error', () => { let sources = []; try { sources = JSON.parse(image.dataset.imageSources || '[]'); } catch { sources = []; } const next = Number(image.dataset.imageIndex || 0) + 1; image.classList.remove('loaded'); if (sources[next]) { image.dataset.imageIndex = String(next); image.src = sources[next]; } else image.remove(); });
    if (image.complete && image.naturalWidth > 0) markLoaded();
  });
}

function scheduleFeedContinuation(form, root, rows, chain) {
  const feed = root.querySelector('[data-live-feed]');
  if (!feed || rows.length <= Number(feed.querySelector('[data-live-feed-more]')?.dataset.liveFeedMore || rows.length)) return;
  const firstBatch = Number(feed.querySelector('[data-live-feed-more]')?.dataset.liveFeedMore || 40);
  form.renderScheduler?.scheduleIdle('feed-more', () => {
    const remaining = rows.slice(firstBatch, 250);
    const more = feed.querySelector('[data-live-feed-more]');
    if (more) more.remove();
    feed.insertAdjacentHTML('beforeend', remaining.map((event) => renderEvent(event, chain, form, eventKey(event) === form.selectedEventId, form.view)).join(''));
    bindImages(feed);
  });
}

function setFreeze(form, reason, active, sourceRows) {
  form.freeze[reason] = active; if (active && !form.frozenOrder) form.frozenOrder = sourceRows.map(eventKey); if (!form.freeze.hover && !form.freeze.focus) form.frozenOrder = null;
}

function selectById(form, state, id, chain, render) {
  const event = allSelectableEvents(form, chain).find((item) => eventKey(item) === String(id)); if (!event) return;
  form.selectedEventId = eventKey(event); form.selectedEvent = event; void loadCollection(form, state, event, render); render();
}

function bindAlertControls(root, form, state, render) {
  const alertForm = root.querySelector('#alert-rule-form');
  alertForm?.querySelectorAll('input, select').forEach((input) => {
    const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => { form.alertDraft[input.name] = input.type === 'checkbox' ? input.checked : input.value; if (input.name === 'type') render(); });
  });
  alertForm?.addEventListener('submit', (event) => { event.preventDefault(); void saveAlertRule(form, state, render); });
  root.querySelector('#cancel-alert-edit')?.addEventListener('click', () => { form.editingAlertId = ''; form.alertDraft = alertDraftFromRule(); render(); });
  root.querySelectorAll('[data-alert-edit]').forEach((button) => button.addEventListener('click', () => { const rule = form.alerts.rules.find((item) => item.id === button.dataset.alertEdit); if (!rule) return; form.editingAlertId = rule.id; form.alertDraft = alertDraftFromRule(rule); render(); }));
  root.querySelectorAll('[data-alert-toggle]').forEach((button) => button.addEventListener('click', () => { void updateAlertRule(form, state, button.dataset.alertToggle, { enabled: button.dataset.alertEnabled === 'true' }, render); }));
  root.querySelectorAll('[data-alert-delete]').forEach((button) => button.addEventListener('click', () => { const rule = form.alerts.rules.find((item) => item.id === button.dataset.alertDelete); if (rule && window.confirm(`删除报警规则“${rule.name}”？`)) void deleteAlertRule(form, state, rule.id, render); }));
  root.querySelector('#refresh-alerts')?.addEventListener('click', () => void loadAlerts(form, state, render));
  root.querySelector('#test-alert')?.addEventListener('click', () => void testAlert(form, state, render));
  root.querySelector('[name="alertSound"]')?.addEventListener('change', (event) => { form.alertPreferences = writeAlertPreferences(globalThis.localStorage, { ...form.alertPreferences, sound: event.target.checked }); if (event.target.checked) playAlertSound(); render(); });
  root.querySelector('[name="alertDesktop"]')?.addEventListener('change', async (event) => { let enabled = event.target.checked; if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') enabled = (await Notification.requestPermission()) === 'granted'; if (enabled && (typeof Notification === 'undefined' || Notification.permission !== 'granted')) enabled = false; form.alertPreferences = writeAlertPreferences(globalThis.localStorage, { ...form.alertPreferences, desktop: enabled }); if (event.target.checked && !enabled) form.alerts.error = '桌面通知权限未开启'; render(); });
}

function bindDiagnostics(root, form, render) {
  root.querySelector('#clear-monitor-cache')?.addEventListener('click', async () => {
    try { await form.cache.clearAll(); form.cacheSavedAt = null; form.diagnostics.record('cache', 'cache_cleared'); render(); }
    catch (error) { form.diagnostics.record('cache', 'cache_clear_failed', { message: error.message }); }
  });
  root.querySelector('#export-monitor-diagnostics')?.addEventListener('click', () => {
    const payload = form.diagnostics.exportJson({ chainId: form.chainId, overviewWindow: form.overviewWindow, stream: form.streamCoordinator?.status() || {}, render: form.renderScheduler?.metrics() || {} });
    try {
      const blob = new Blob([payload], { type: 'application/json' }); const href = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = href; link.download = `nfttool-monitor-diagnostics-v1-${form.chainId}.json`; link.click(); URL.revokeObjectURL(href);
    } catch { /* Download is optional; the diagnostics remain in memory. */ }
  });
}

function ensureRadarTimer(form, render) {
  if (form.view === 'radar' && !form.radarTimer) form.radarTimer = window.setInterval(() => { form.nowMs = Date.now(); scheduleRender(form, render); }, 1000);
  else if (form.view !== 'radar' && form.radarTimer) { window.clearInterval(form.radarTimer); form.radarTimer = null; }
}

function refreshCurrentView(form, state, render) {
  if (form.view === 'trending') return loadTrending(form, state, render);
  if (form.view === 'radar') return loadRadar(form, state, render);
  if (form.view === 'alerts') return loadAlerts(form, state, render);
  return loadOverview(form, state, render);
}

export function renderMintMonitor({ state, render }) {
  let form = state.page.mint;
  if (!form || Number(form.chainId) !== Number(state.chainId)) { disposeMonitorForm(form); form = createMonitorForm(state.chainId); state.page.mint = form; delete state.page.mintAction; }
  const chain = currentChain(state); const rows = rowsForView(form, chain); const selected = selectedEvent(form, chain); const actionPanel = renderMintActionPanel({ state, render, event: selected, readOnly: !form.snapshotConfirmed });
  form.lastRenderSignatures = createRegionSignatures({ metrics: [form.streamState, form.realtime.mintRate, form.realtime.latencyMs], toolbar: [form.view, rows.length, form.overviewWindow, form.trendingWindow], feed: rows.map(eventKey), detail: [selected?.address, form.detail.loading], actionPanel: [selected?.address, form.snapshotConfirmed] });
  return {
    html: `${metricsStrip(form, state)}${toolbar(form, rows.length)}${viewNotices(form)}<div class="mint-monitor-layout"><section class="mint-monitor-feed">${renderCollectionDetail(form, chain, selected)}<div class="live-view-content ${form.view}" data-live-view-content>${renderView(form, rows, chain)}</div></section>${actionPanel.html}</div>${diagnosticsPanel(form)}${filterPanel(form)}`,
    bind(root) {
      form.boundRoot = root;
      form.renderScheduler?.cancelAllIdle?.();
      if (!form.loaded && !form.loading) { form.loaded = true; void loadBootstrap(form, state, render); }
      ensureRadarTimer(form, render);
      root.querySelector('#refresh-live')?.addEventListener('click', () => void refreshCurrentView(form, state, render));
      root.querySelectorAll('[data-live-view]').forEach((button) => button.addEventListener('click', () => { form.view = button.dataset.liveView; if (form.view === 'trending' && !form.trending.windows[String(form.trendingWindow)]) void loadTrending(form, state, render); else if (form.view === 'radar') void loadRadar(form, state, render); else if (form.view === 'alerts') void loadAlerts(form, state, render, { quiet: true }); render(); }));
      root.querySelectorAll('[data-live-window]').forEach((button) => button.addEventListener('click', () => { const seconds = Number(button.dataset.liveWindow); if (form.view === 'trending') { form.trendingWindow = seconds; void loadTrending(form, state, render, seconds); } else { form.overviewWindow = seconds; void loadOverview(form, state, render); } }));
      root.querySelector('[name="keyword"]')?.addEventListener('input', (event) => { form.filters.keyword = event.target.value; persistFilters(form); render(); });
      root.querySelector('#open-live-filters')?.addEventListener('click', () => { form.filtersOpen = true; render(); }); root.querySelector('#close-live-filters')?.addEventListener('click', () => { form.filtersOpen = false; render(); });
      root.querySelector('#reset-live-filters')?.addEventListener('click', () => { form.filters = { ...DEFAULT_FILTERS }; persistFilters(form); render(); });
      for (const name of Object.keys(DEFAULT_FILTERS).filter((key) => key !== 'keyword')) { const input = root.querySelector(`.live-filter-panel [name="${name}"]`); input?.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => { form.filters[name] = input.type === 'checkbox' ? input.checked : input.value; persistFilters(form); render(); }); }
      const liveContent = root.querySelector('[data-live-view-content]'); const orderedSource = enrichRealtimeEvents(form.realtime.events, form.data); liveContent?.addEventListener('pointerenter', () => setFreeze(form, 'hover', true, orderedSource)); liveContent?.addEventListener('pointerleave', () => { setFreeze(form, 'hover', false, orderedSource); render(); }); liveContent?.addEventListener('focusin', () => setFreeze(form, 'focus', true, orderedSource)); liveContent?.addEventListener('focusout', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setFreeze(form, 'focus', false, orderedSource); render(); } });
      liveContent?.addEventListener('click', (event) => { const select = event.target.closest?.('[data-select-event]'); if (select) selectById(form, state, select.dataset.selectEvent, chain, render); const flag = event.target.closest?.('[data-flag-address]'); if (flag) void toggleFlag(form, state, flag.dataset.flagAddress, render); });
      root.querySelectorAll('[data-radar-price]').forEach((button) => button.addEventListener('click', () => { form.radarFilters.price = button.dataset.radarPrice; render(); })); root.querySelector('[name="radarPublicOnly"]')?.addEventListener('change', (event) => { form.radarFilters.publicOnly = event.target.checked; render(); }); root.querySelector('[name="radarLiveOnly"]')?.addEventListener('change', (event) => { form.radarFilters.liveOnly = event.target.checked; render(); }); root.querySelector('#refresh-radar')?.addEventListener('click', () => void loadRadar(form, state, render));
      if (form.view === 'alerts') bindAlertControls(root, form, state, render); bindDiagnostics(root, form, render); bindImages(root); scheduleFeedContinuation(form, root, rows, chain); actionPanel.bind?.(root);
    },
  };
}
