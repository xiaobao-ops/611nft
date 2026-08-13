import {resolveMintSupplyUpdate} from './supply-sync.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const messages = {
  en: {
    brandSub: 'multi-wallet mint', searchPlaceholder: 'Search by collection name or address', overviewTitle: 'Mints Overview',
    mainnet: 'Mainnet', bothChains: 'Both', hiddenCollections: 'Hidden Collections', selectCollection: 'Select a collection to view details',
    waitLiveMint: 'or wait for a live mint to appear', back: 'Back', copyAddress: 'Copy address', shareLink: 'Share collection link',
    refreshStats: 'Refresh stats', localSigner: 'LOCAL SIGNER', concurrency: 'Concurrency', concurrencyHint: '0 sends with all eligible wallets concurrently',
    selectAllWallets: 'Select all wallets', quantity: 'Qty:', confirmBroadcast: 'Confirm & broadcast', cancel: 'Cancel', recentMints: 'Recent Mints',
    hide: 'Hide', token: 'Token', to: 'To', transaction: 'Tx', time: 'Time', liveMints: 'Live Mints', live: 'Live', paused: '⏸ paused',
    overviewTab: 'Overview', detailTab: 'Detail', liveTab: 'Live', loadingWallets: 'Loading wallets…', liveFeed: 'Live feed', livePolling: 'Live polling',
    loadingCollections: 'Loading live collections…', connectingFeed: 'Connecting to live feed…', noMatch: 'No matching collection', waitingMints: 'Waiting for live mints…',
    manageHidden: ({count}) => `🚫 ${count} hidden — click to manage`, noHidden: 'No hidden collections', unhide: 'Unhide', walletConfig: 'Wallet config required',
    configureWallet: 'Enter one private key per line in .env', noWallets: 'No local wallets loaded', balanceUnavailable: 'Balance unavailable',
    walletsLoaded: ({total, chain, selected}) => `${total} wallet${total === 1 ? '' : 's'} loaded on ${chain} · ${selected} selected`,
    walletStatus: ({count}) => `⚡ ${count} local wallet${count === 1 ? '' : 's'}`, selectedCount: ({selected, total}) => `${selected} / ${total} selected`,
    previewWallets: ({count}) => `⚡ Preview with ${count} wallet${count === 1 ? '' : 's'}`, selectWallet: 'Select at least one wallet to preview this mint.',
    previewOnly: 'Only selected wallets will be previewed. Broadcasting always requires a second explicit confirmation.',
    loading: 'Loading…', unavailable: 'Collection unavailable', unknown: 'Unknown', airdrop: 'Airdrop', mintable: 'Mintable', mints: 'mints', unique: 'unique',
    totalMinted: 'Total Minted', maxSupply: 'Max Supply', uniqueMinters: 'Unique Minters', mintPrice: 'Mint Price', floor: 'Floor', maxWallet: 'Max Mint / Wallet', bestOffer: 'Best Offer',
    priceChanged: 'Mint price changed', supplyChanged: 'Max supply changed', lastMinted: 'Last minted', searchX: 'Search X', website: 'Website', noMints: 'No mints recorded yet',
    previewFirst: 'Preview first. Broadcasting always requires a second explicit confirmation.',
    preflighting: ({count}) => `⏳ Preflighting ${count} selected wallet${count === 1 ? '' : 's'}…`, checkingPlans: 'Fetching one OpenSea transaction plan and checking balance/gas for selected wallets.',
    previewFailed: '❌ Preview failed — retry', readyCopy: ({ready, skipped}) => `${ready} wallet${ready === 1 ? '' : 's'} ready${skipped ? `, ${skipped} skipped` : ''}. Confirm to sign and broadcast these exact previewed plans.`,
    previewReady: '✓ Preview ready', previewExpires: ({time}) => `Preview expires ${time}`, broadcasting: '⏳ Broadcasting…', signing: 'Wallets are signing and sending concurrently.',
    batchCompleted: '✅ Batch completed', batchPartial: '⚠️ Batch partially completed', batchFailed: '❌ Batch failed', sentFailed: ({sent, failed}) => `${sent} sent · ${failed} failed`,
    priceUpdated: '⚡ Price updated — preview again', priceUpdatedInfo: 'Live price changed after the previous preview. Generate a fresh per-wallet plan.',
    copied: ({label}) => `✓ Copied ${label}`, contract: 'contract', link: 'link', reported: '🚩 Reported', scam: '🚩 Scam', now: 'now', ago: 'ago',
    activityUpdate: 'activity update', wallet: 'Wallet', valuePending: 'value pending', signingTransaction: 'signing transaction', minted: 'Minted',
    free: 'Free', syncing: 'Syncing details', explorer: 'Explorer', walletUsed: 'Wallets used for mint', selectedWalletsAria: 'Selected wallets',
    checkingWallets: 'Checking local wallets…', loadingWalletAddresses: 'Loading wallet addresses…', previewMultiWallet: '⚡ Preview multi-wallet mint',
    disclaimer: '⚠️ DYOR — verify the contract, chain, price and every wallet preview before broadcasting. Private keys stay inside this local Node process.',
    overviewAria: 'Mints overview', detailAria: 'Collection details', liveAria: 'Live mints', mobilePanelsAria: 'Mobile panels', languageAria: 'Language',
    ready: 'ready', pending: 'pending', sent: 'sent', confirmed: 'confirmed', skipped: 'skipped', failed: 'failed',
    planDetails: ({to, value, gas, balance}) => `to ${to} · value ${value} ETH · gas ${gas} · balance ${balance} ETH`,
    quantityShort: 'Qty', txShort: 'tx', milestone: ({value}) => `${value}% Minted`,
  },
  'zh-CN': {
    brandSub: '多钱包 Mint', searchPlaceholder: '按合集名称或合约地址搜索', overviewTitle: 'Mint 概览', mainnet: '以太坊', bothChains: '全部',
    hiddenCollections: '已隐藏合集', selectCollection: '选择一个合集查看详情', waitLiveMint: '或等待实时 Mint 出现', back: '返回', copyAddress: '复制地址',
    shareLink: '分享合集链接', refreshStats: '刷新统计', localSigner: '本地签名器', concurrency: '并发数', concurrencyHint: '0 表示所有可用钱包同时发送',
    selectAllWallets: '全选钱包', quantity: '数量：', confirmBroadcast: '确认并广播', cancel: '取消', recentMints: '最近 Mint', hide: '隐藏',
    token: 'Token', to: '接收地址', transaction: '交易', time: '时间', liveMints: '实时 Mint', live: '实时', paused: '⏸ 已暂停', overviewTab: '概览', detailTab: '详情', liveTab: '实时',
    loadingWallets: '正在加载钱包…', liveFeed: '实时数据', livePolling: '轮询数据', loadingCollections: '正在加载实时合集…', connectingFeed: '正在连接实时数据…',
    noMatch: '没有匹配的合集', waitingMints: '等待实时 Mint…', manageHidden: ({count}) => `🚫 已隐藏 ${count} 个，点击管理`, noHidden: '没有隐藏的合集', unhide: '取消隐藏',
    walletConfig: '需要配置钱包', configureWallet: '请在 .env 中每行直接填写一个私钥', noWallets: '未加载本地钱包', balanceUnavailable: '余额读取失败',
    walletsLoaded: ({total, chain, selected}) => `${chain} 已加载 ${total} 个钱包 · 已选 ${selected} 个`, walletStatus: ({count}) => `⚡ ${count} 个本地钱包`,
    selectedCount: ({selected, total}) => `已选 ${selected} / ${total}`, previewWallets: ({count}) => `⚡ 使用 ${count} 个钱包预览 Mint`, selectWallet: '至少选择一个钱包后才能预览 Mint。',
    previewOnly: '仅预览已勾选的钱包；广播前仍需再次明确确认。', loading: '加载中…', unavailable: '合集暂不可用', unknown: '未知合集', airdrop: '空投', mintable: '可 Mint',
    mints: '次 Mint', unique: '个独立钱包', totalMinted: '已 Mint 总量', maxSupply: '最大供应量', uniqueMinters: '独立 Mint 钱包', mintPrice: 'Mint 价格', floor: '地板价',
    maxWallet: '单钱包 Mint 上限', bestOffer: '最高出价', priceChanged: 'Mint 价格已变更', supplyChanged: '最大供应量已变更', lastMinted: '最近 Mint', searchX: '搜索 X', website: '官网', noMints: '暂无 Mint 记录',
    previewFirst: '请先预览；广播始终需要第二次明确确认。', preflighting: ({count}) => `⏳ 正在预检 ${count} 个已选钱包…`, checkingPlans: '正在获取交易计划并逐钱包检查余额和 Gas。',
    previewFailed: '❌ 预览失败，点击重试', readyCopy: ({ready, skipped}) => `${ready} 个钱包已就绪${skipped ? `，${skipped} 个已跳过` : ''}。确认后将签名并广播这些预览计划。`,
    previewReady: '✓ 预览已就绪', previewExpires: ({time}) => `预览有效至 ${time}`, broadcasting: '⏳ 正在广播…', signing: '钱包正在并发签名和发送。',
    batchCompleted: '✅ 批次已完成', batchPartial: '⚠️ 批次部分完成', batchFailed: '❌ 批次失败', sentFailed: ({sent, failed}) => `已发送 ${sent} · 失败 ${failed}`,
    priceUpdated: '⚡ 价格已更新，请重新预览', priceUpdatedInfo: '实时 Mint 价格已变化，请生成新的逐钱包计划。', copied: ({label}) => `✓ 已复制${label}`, contract: '合约地址', link: '链接',
    reported: '🚩 已报告', scam: '🚩 风险', now: '刚刚', ago: '前', activityUpdate: '活动更新', wallet: '钱包', valuePending: '金额待定', signingTransaction: '正在签名交易', minted: '已 Mint',
    free: '免费', syncing: '正在同步详情', explorer: '区块浏览器', walletUsed: '用于 Mint 的钱包', selectedWalletsAria: '已选择的钱包', checkingWallets: '正在检查本地钱包…',
    loadingWalletAddresses: '正在加载钱包地址…', previewMultiWallet: '⚡ 预览多钱包 Mint',
    disclaimer: '⚠️ 请自行核验合约、链、价格以及每个钱包的预览，再进行广播。私钥仅保留在本地 Node 进程内。',
    overviewAria: 'Mint 概览', detailAria: '合集详情', liveAria: '实时 Mint', mobilePanelsAria: '移动端面板', languageAria: '语言',
    ready: '就绪', pending: '处理中', sent: '已发送', confirmed: '已确认', skipped: '已跳过', failed: '失败',
    planDetails: ({to, value, gas, balance}) => `目标 ${to} · 金额 ${value} ETH · Gas ${gas} · 余额 ${balance} ETH`,
    quantityShort: '数量', txShort: '交易', milestone: ({value}) => `已 Mint ${value}%`,
  },
};

function initialLanguage() {
  const saved = localStorage.getItem('611nft_lang');
  if (saved === 'en' || saved === 'zh-CN') return saved;
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

const state = {
  language: initialLanguage(),
  chains: {},
  allWindows: {},
  collections: [],
  chainFilter: localStorage.getItem('mintscan_chain') || 'hood',
  timeWindow: Number(localStorage.getItem('mintscan_window') || 1800),
  search: '',
  selectedAddress: null,
  selectedChain: null,
  selectedKey: null,
  detail: null,
  wallets: [],
  selectedWallets: new Set(),
  walletError: null,
  hidden: JSON.parse(localStorage.getItem('mintscan_hidden') || '{}'),
  feedIndex: new Map(),
  maxLive: 200,
  ws: null,
  reconnectTimer: null,
  selectedQuantity: 1,
  currentJob: null,
  currentJobTimer: null,
  detailRefreshTimer: null,
  detailRefreshRequest: 0,
};

function t(key, params = {}) {
  const value = messages[state.language]?.[key] ?? messages.en[key] ?? key;
  return typeof value === 'function' ? value(params) : value;
}

function applyStaticTranslations() {
  document.documentElement.lang = state.language;
  document.title = '611nft';
  $$('[data-i18n]').forEach((element) => {
    if (element.dataset.i18nDynamic === 'true') return;
    element.textContent = t(element.dataset.i18n);
  });
  $$('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  $$('[data-i18n-title]').forEach((element) => { element.title = t(element.dataset.i18nTitle); });
  $$('[data-i18n-aria]').forEach((element) => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
  $$('.language-option').forEach((button) => {
    const active = button.dataset.lang === state.language;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setLanguage(language, {persist = true} = {}) {
  if (!messages[language]) return;
  state.language = language;
  if (persist) localStorage.setItem('611nft_lang', language);
  applyStaticTranslations();
  updateHiddenUi();
  renderOverview();
  renderWalletSelection();
  updateWalletSelectionUi();
  const walletButton = $('#walletStatusBtn');
  if (walletButton) walletButton.textContent = state.wallets.length ? t('walletStatus', {count: state.wallets.length}) : t(state.walletError ? 'walletConfig' : 'loadingWallets');
  if (state.detail) renderDetail(state.detail);
  if (state.currentJob) renderJob(state.currentJob);
  else {
    updateMintPreviewButton();
    $('#mintInfo').textContent = state.detail
      ? (selectedWalletAddresses().length ? t('previewOnly') : t('selectWallet'))
      : t('previewFirst');
  }
  renderLiveFeedTranslations();
  const pill = $('#upstreamPill');
  if (pill) pill.lastChild.textContent = pill.dataset.status === 'connected' ? ` ${t('liveFeed')}` : ` ${t('livePolling')}`;
}

function chainOf(value) {
  return value?.chain === 'hood' ? 'hood' : 'ethereum';
}

function chainInfo(chain) {
  const fallback = {
    chain,
    label: chain === 'hood' ? 'Robinhood Chain' : 'Ethereum',
    emoji: chain === 'hood' ? '🏹' : '⟠',
    explorer: chain === 'hood' ? 'https://robinhoodchain.blockscout.com' : 'https://etherscan.io',
    opensea_chain: chain === 'hood' ? 'robinhood' : 'ethereum',
  };
  const configured = state.chains[chain] || {};
  return {
    ...fallback,
    ...configured,
    explorer: safeHttpUrl(configured.explorer) || fallback.explorer,
    opensea_chain: /^[a-z0-9_-]+$/i.test(configured.opensea_chain || '') ? configured.opensea_chain : fallback.opensea_chain,
  };
}

function collectionKey(chain, address) {
  return `${chain}:${String(address).toLowerCase()}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value), location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function safeImageUrl(value) {
  const url = safeHttpUrl(value);
  return url ? escapeHtml(url) : '';
}

function safeAddress(value) {
  const text = String(value || '');
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text : '';
}

function safeTransactionHash(value) {
  const text = String(value || '');
  return /^0x[0-9a-fA-F]{64}$/.test(text) ? text : '';
}

function shorten(value, left = 7, right = 5) {
  if (!value) return '—';
  return value.length <= left + right + 3 ? value : `${value.slice(0, left)}...${value.slice(-right)}`;
}

function timeAgo(timestamp) {
  if (!timestamp) return t('now');
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(timestamp)));
  if (seconds < 5) return t('now');
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function fullTimeAgo(timestamp) {
  return state.language === 'zh-CN' ? `${timeAgo(timestamp)}${t('ago')}` : `${timeAgo(timestamp)} ${t('ago')}`;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 1800);
}

async function copyText(value, label) {
  await navigator.clipboard.writeText(value);
  toast(t('copied', {label: t(label)}));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function switchMobileTab(panel) {
  const order = {left: 0, center: 1, right: 2};
  $$('.panel-left,.panel-center,.panel-right').forEach((node) => node.classList.remove('mobile-active'));
  $$('.mobile-tab').forEach((node) => node.classList.remove('active'));
  $(`.panel-${panel}`).classList.add('mobile-active');
  $$('.mobile-tab')[order[panel]]?.classList.add('active');
}

function chainPasses(chain) {
  return state.chainFilter === 'all' || state.chainFilter === chain;
}

function setChainFilter(chain) {
  state.chainFilter = chain;
  localStorage.setItem('mintscan_chain', chain);
  $$('.chain-filter').forEach((button) => button.classList.toggle('active', button.dataset.chain === chain));
  renderOverview();
  $$('#liveFeed .live-event').forEach((row) => {
    row.hidden = !chainPasses(row.dataset.chain || 'ethereum');
  });
}

function setTimeWindow(value) {
  state.timeWindow = Number(value);
  localStorage.setItem('mintscan_window', String(value));
  $$('.time-filter').forEach((button) => button.classList.toggle('active', Number(button.dataset.window) === state.timeWindow));
  state.collections = state.allWindows[String(state.timeWindow)] || [];
  renderOverview();
}

function overviewLinks(item) {
  const info = chainInfo(chainOf(item));
  const stop = 'onclick="event.stopPropagation()"';
  const links = [
    `<a href="${info.explorer}/address/${item.address}" target="_blank" rel="noopener" ${stop} title="${escapeHtml(t('explorer'))}">📄</a>`,
    `<a href="https://opensea.io/assets/${info.opensea_chain}/${item.address}" target="_blank" rel="noopener" ${stop} title="OpenSea">🌊</a>`,
  ];
  const website = safeHttpUrl(item.website);
  const twitter = safeHttpUrl(item.twitter);
  if (website) links.push(`<a href="${escapeHtml(website)}" target="_blank" rel="noopener" ${stop} title="${escapeHtml(t('website'))}">🌐</a>`);
  if (twitter) links.push(`<a href="${escapeHtml(twitter)}" target="_blank" rel="noopener" ${stop} title="X">𝕏</a>`);
  return links.join('');
}

function heatBars(heat = 0) {
  const count = Number.isFinite(Number(heat)) ? Number(heat) : 0;
  return Array.from({length: 5}, (_, index) => {
    const height = Math.min(20, Math.max(3, (count / 20) * 20 * (0.35 + index * 0.13)));
    return `<div class="bar" style="height:${height}px"></div>`;
  }).join('');
}

function renderOverview() {
  const list = $('#collectionList');
  const query = state.search.trim().toLowerCase();
  const rows = (state.collections || [])
    .filter((item) => chainPasses(chainOf(item)))
    .filter((item) => !state.hidden[collectionKey(chainOf(item), item.address)])
    .filter((item) => !query || `${item.name} ${item.full_name} ${item.address}`.toLowerCase().includes(query));

  if (!rows.length) {
    list.innerHTML = `<div class="loading-row">${query ? t('noMatch') : t('waitingMints')}</div>`;
    return;
  }
  list.innerHTML = rows.map((item, index) => {
    const chain = chainOf(item);
    const selected = state.selectedKey === collectionKey(chain, item.address);
    const address = safeAddress(item.address);
    const image = safeImageUrl(item.image_url);
    if (!address) return '';
    return `<article class="collection-row${selected ? ' active' : ''}" data-address="${address}" data-chain="${chain}" tabindex="0">
      <div class="collection-rank">${index + 1}</div>
      <div class="collection-thumb">${image ? `<img src="${image}" alt="" loading="lazy">` : '<span class="ph">🎨</span>'}</div>
      <div class="collection-info">
        <div class="collection-name">${escapeHtml(item.name || t('unknown'))}${item.verified ? ' ✓' : ''}<span class="chain-badge ${chain}">${chainInfo(chain).emoji} ${escapeHtml(chainInfo(chain).label)}</span></div>
        <div class="collection-meta"><span>${Number(item.recent_mints || 0).toLocaleString()} ${t('mints')}</span>${item.is_airdrop ? `<span class="badge-airdrop" title="${escapeHtml(t('airdrop'))}">🪂</span>` : ''}${item.is_mintable ? `<span class="badge-mintable">${t('mintable')}</span>` : ''}</div>
        <div class="ov-links">${overviewLinks(item)}</div>
      </div>
      <div class="collection-stats">
        <div class="heat-bar ${item.heat === 'none' ? '' : escapeHtml(item.heat || '')}">${heatBars(item.recent_mints)}</div>
        <button class="row-hide" type="button" title="${escapeHtml(t('hide'))}" data-hide="${address}">×</button>
      </div>
    </article>`;
  }).join('');

  $$('.collection-row', list).forEach((row) => {
    const open = () => selectCollection(row.dataset.address, row.dataset.chain);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
  });
  $$('[data-hide]', list).forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    hideCollection(button.closest('.collection-row').dataset.chain, button.dataset.hide);
  }));
}

function updateHiddenUi() {
  const entries = Object.entries(state.hidden);
  $('#hiddenCounter').hidden = entries.length === 0;
  $('#hiddenBar').hidden = entries.length === 0;
  $('#hiddenCounter').textContent = `🚫 ${entries.length}`;
  $('#hiddenBar').textContent = t('manageHidden', {count: entries.length});
  $('#hiddenList').innerHTML = entries.length ? entries.map(([key, name]) => {
    const [chain, address] = key.split(':');
    return `<div class="hidden-item"><div><strong>${escapeHtml(name)}</strong><br><code>${escapeHtml(chain)}:${escapeHtml(shorten(address))}</code></div><button class="unhide-btn" type="button" data-key="${escapeHtml(key)}">${t('unhide')}</button></div>`;
  }).join('') : `<div class="loading-row">${t('noHidden')}</div>`;
  $$('.unhide-btn', $('#hiddenList')).forEach((button) => button.addEventListener('click', () => {
    delete state.hidden[button.dataset.key];
    saveHidden();
  }));
}

function saveHidden() {
  localStorage.setItem('mintscan_hidden', JSON.stringify(state.hidden));
  updateHiddenUi();
  renderOverview();
}

function hideCollection(chain, address) {
  const key = collectionKey(chain, address);
  const item = state.collections.find((candidate) => collectionKey(chainOf(candidate), candidate.address) === key);
  state.hidden[key] = item?.name || shorten(address);
  saveHidden();
  $$('#liveFeed .live-event').filter((row) => row.dataset.key === key).forEach((row) => row.remove());
  if (state.selectedKey === key) clearDetail();
  sendWs({type: 'hide', chain, address});
}

function clearDetail() {
  state.selectedAddress = null;
  state.selectedChain = null;
  state.selectedKey = null;
  state.detail = null;
  $('#detailHeader').classList.remove('visible');
  $('#detailBody').classList.remove('visible');
  $('#emptyState').style.display = '';
  renderOverview();
  if (matchMedia('(max-width:900px)').matches) switchMobileTab('left');
}

async function loadChains() {
  const data = await fetchJson('/api/chains');
  state.chains = data.chains || {};
}

async function loadOverview() {
  const data = await fetchJson('/api/overview/all');
  state.allWindows = data.windows || {};
  state.collections = state.allWindows[String(state.timeWindow)] || [];
  renderOverview();
}

async function loadWallets() {
  const chain = state.selectedChain === 'ethereum' ? 'ethereum' : 'hood';
  const data = await fetchJson(`/api/wallets?chain=${chain}`);
  state.wallets = data.wallets || [];
  state.walletError = data.error || null;
  const button = $('#walletStatusBtn');
  const summary = $('#mintWalletSummary');
  if (!data.configured) {
    state.selectedWallets.clear();
    renderWalletSelection();
    button.className = 'local-wallet-status local-wallets error';
    button.dataset.i18nDynamic = 'true';
    summary.dataset.i18nDynamic = 'true';
    button.textContent = t('walletConfig');
    summary.textContent = data.error || t('configureWallet');
    $('#mintBtn').disabled = true;
    return;
  }
  button.className = 'local-wallet-status local-wallets connected';
  button.dataset.i18nDynamic = 'true';
  summary.dataset.i18nDynamic = 'true';
  button.textContent = t('walletStatus', {count: data.count});
  state.selectedWallets = new Set(state.wallets.map((wallet) => wallet.address.toLowerCase()));
  renderWalletSelection();
  updateWalletSelectionUi();
}

function selectedWalletAddresses() {
  return state.wallets
    .filter((wallet) => state.selectedWallets.has(wallet.address.toLowerCase()))
    .map((wallet) => wallet.address);
}

function renderWalletSelection() {
  const list = $('#walletSelectionList');
  if (!state.wallets.length) {
    list.innerHTML = `<div class="wallet-selection-empty">${escapeHtml(state.walletError || t('noWallets'))}</div>`;
    updateWalletSelectionUi();
    return;
  }
  list.innerHTML = state.wallets.map((wallet) => {
    const key = wallet.address.toLowerCase();
    const balance = wallet.balanceEth == null ? t('balanceUnavailable') : `${Number(wallet.balanceEth).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'} ETH`;
    return `<label class="wallet-selection-row${state.selectedWallets.has(key) ? ' selected' : ''}">
      <input class="wallet-select-checkbox" type="checkbox" value="${escapeHtml(wallet.address)}" ${state.selectedWallets.has(key) ? 'checked' : ''}>
      <span class="wallet-order">#${wallet.index}</span>
      <span class="wallet-full-address" title="${escapeHtml(wallet.address)}">${escapeHtml(wallet.address)}</span>
      <span class="wallet-balance${wallet.error ? ' error' : ''}" title="${escapeHtml(wallet.error || balance)}">${escapeHtml(balance)}</span>
    </label>`;
  }).join('');
}

function updateWalletSelectionUi({resetPreview = false} = {}) {
  const selectedCount = selectedWalletAddresses().length;
  const totalCount = state.wallets.length;
  const selectAll = $('#selectAllWallets');
  selectAll.disabled = totalCount === 0;
  selectAll.checked = totalCount > 0 && selectedCount === totalCount;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
  $('#walletSelectionCount').textContent = t('selectedCount', {selected: selectedCount, total: totalCount});
  $('#mintWalletSummary').textContent = state.walletError
    || t('walletsLoaded', {total: totalCount, chain: chainInfo(state.selectedChain === 'ethereum' ? 'ethereum' : 'hood').label, selected: selectedCount});
  $('#mintBtn').disabled = !state.detail || selectedCount === 0;
  $$('.wallet-selection-row').forEach((row) => row.classList.toggle('selected', $('.wallet-select-checkbox', row).checked));
  if (resetPreview && state.currentJob) cancelPreview();
  else if (!state.currentJob) updateMintPreviewButton();
}

function setAllWalletsSelected(selected) {
  state.selectedWallets = new Set(selected ? state.wallets.map((wallet) => wallet.address.toLowerCase()) : []);
  $$('.wallet-select-checkbox').forEach((checkbox) => { checkbox.checked = selected; });
  updateWalletSelectionUi({resetPreview: true});
}

function updateMintPreviewButton() {
  const selectedCount = selectedWalletAddresses().length;
  $('#mintBtn').textContent = t('previewWallets', {count: selectedCount});
  $('#mintBtn').disabled = !state.detail || selectedCount === 0;
}

async function selectCollection(address, chain = 'ethereum') {
  const key = collectionKey(chain, address);
  clearTimeout(state.detailRefreshTimer);
  state.detailRefreshTimer = null;
  const request = ++state.detailRefreshRequest;
  state.selectedAddress = address;
  state.selectedChain = chain;
  state.selectedKey = key;
  state.detail = null;
  state.currentJob = null;
  $('#walletPlanList').innerHTML = '';
  $('#mintConfirm').hidden = true;
  history.replaceState(null, '', `#${chain === 'ethereum' ? address : `${chain}:${address}`}`);
  renderOverview();
  $('#emptyState').style.display = 'none';
  $('#detailHeader').classList.add('visible');
  $('#detailBody').classList.add('visible');
  $('#detailTitle').textContent = t('loading');
  if (matchMedia('(max-width:900px)').matches) switchMobileTab('center');
  sendWs({type: 'view', address, chain});
  try {
    const data = await fetchJson(`/api/collection/${address}?chain=${encodeURIComponent(chain)}`);
    if (state.selectedKey !== key || state.detailRefreshRequest !== request) return;
    state.detail = data;
    renderDetail(data);
    await loadWallets();
  } catch (error) {
    $('#detailTitle').textContent = t('unavailable');
    toast(error.message);
  }
}

async function refreshSelectedDetail() {
  if (!state.selectedAddress || !state.selectedKey) return false;
  const address = state.selectedAddress;
  const chain = state.selectedChain;
  const key = state.selectedKey;
  const request = ++state.detailRefreshRequest;
  const data = await fetchJson(`/api/collection/${address}?chain=${encodeURIComponent(chain)}`);
  if (state.selectedKey !== key || state.detailRefreshRequest !== request) return false;
  state.detail = data;
  renderDetail(data);
  return true;
}

function scheduleDetailRefresh(key) {
  if (state.detailRefreshTimer) return;
  state.detailRefreshTimer = setTimeout(() => {
    state.detailRefreshTimer = null;
    if (state.selectedKey !== key || !state.detail) return;
    refreshSelectedDetail().catch((error) => console.warn(`Collection detail refresh failed: ${error.message}`));
  }, 500);
}

function fmtEth(value) {
  if (value == null) return null;
  const number = Number(value);
  if (number === 0) return t('free');
  if (number < .001) return `${number.toFixed(6).replace(/0+$/, '')} Ξ`;
  return `${number.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} Ξ`;
}

function fmtWalletMintLimit(value) {
  if (value == null || value === '') return '—';
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 0 ? limit.toLocaleString() : '—';
}

function renderDetail(data) {
  const chain = chainOf(data);
  const detailImage = safeImageUrl(data.image_url);
  $('#detailImage').innerHTML = detailImage ? `<img src="${detailImage}" alt="">` : '🎨';
  $('#detailTitle').textContent = data.name || t('unknown');
  $('#detailAddress').textContent = shorten(data.address, 8, 6);
  $('#copyAddress').onclick = () => copyText(data.address, 'contract');
  $('#shareBtn').onclick = () => copyText(location.href, 'link');
  $('#detailBadges').innerHTML = `<span class="detail-badge standard">${escapeHtml(data.token_standard || 'NFT')}</span>${data.is_airdrop ? `<span class="detail-badge standard badge-airdrop">🪂 ${t('airdrop')}</span>` : ''}`;

  const socials = [
    data.explorer_url && ['📄', data.explorer_url, data.explorer_name || t('explorer')],
    data.opensea_url && ['🌊', data.opensea_url, 'OpenSea'],
    data.blur_url && ['💨', data.blur_url, 'Blur'],
    data.twitter && ['𝕏', data.twitter, 'X'],
    data.website && ['🌐', data.website, t('website')],
    data.discord_url && ['💬', data.discord_url, 'Discord'],
  ].filter(Boolean).map(([icon, href, title]) => [icon, safeHttpUrl(href), title]).filter(([, href]) => href);
  $('#detailSocials').innerHTML = socials.map(([icon, href, title]) => `<a class="social-icon" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${icon}</a>`).join('');
  $('#detailRightStats').innerHTML = `<div class="social-stats"><span>👁 <span id="viewerCount">${Number(data.viewers || 0).toLocaleString()}</span></span><span>🙈 <span id="hideCount">${Number(data.hide_count || 0).toLocaleString()}</span></span><span>🚩 <span id="scamCount">${Number(data.scam_count || 0).toLocaleString()}</span></span></div><div class="velocity">👁 ${Number(data.mints_3m || 0).toLocaleString()} (3m) · ${Number(data.mints_10m || 0).toLocaleString()} (10m) · ${Number(data.mints_1h || 0).toLocaleString()} (1h)</div>`;

  const stats = [
    ['totalMinted', data.current_supply?.toLocaleString() || '?'],
    ['maxSupply', data.max_supply?.toLocaleString() || '?'],
    ['uniqueMinters', data.unique_minters?.toLocaleString() || '?'],
    ['mintPrice', data.mint_price || '?'],
    data.floor_price_eth != null && ['floor', fmtEth(data.floor_price_eth)],
    ['maxWallet', fmtWalletMintLimit(data.max_per_wallet), data.max_per_wallet == null ? 'unk' : ''],
    data.best_offer_eth != null && ['bestOffer', fmtEth(data.best_offer_eth)],
  ].filter(Boolean);
  $('#detailStats').innerHTML = stats.map(([key, value, valueClass = '']) => `<div class="stat-cell" data-stat-key="${key}"><div class="stat-label">${t(key)}</div><div class="stat-value ${valueClass}">${escapeHtml(value)}</div></div>`).join('');

  const warnings = [];
  if (data.price_modification) warnings.push(`<div class="mod-badge danger">⚠️ <span><b>${t('priceChanged')}</b></span><span class="mod-when">${fullTimeAgo(data.price_modification.ts)}</span></div>`);
  if (data.supply_modification) warnings.push(`<div class="mod-badge danger">⚠️ <span><b>${t('supplyChanged')}</b></span><span class="mod-when">${fullTimeAgo(data.supply_modification.ts)}</span></div>`);
  $('#detailModBadges').innerHTML = warnings.join('');
  $('#detailMeta').innerHTML = `<div class="detail-meta-row">${t('lastMinted')}: ${data.last_mint_time ? fullTimeAgo(data.last_mint_time) : '—'}</div>`;
  const query = encodeURIComponent(data.full_name || data.name || data.address);
  const explorerUrl = safeHttpUrl(data.explorer_url);
  const openseaUrl = safeHttpUrl(data.opensea_url);
  const websiteUrl = safeHttpUrl(data.website);
  $('#detailLinks').innerHTML = [
    explorerUrl && `<a class="detail-link" href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener">📄 ${escapeHtml(data.explorer_name || 'Explorer')}</a>`,
    openseaUrl && `<a class="detail-link" href="${escapeHtml(openseaUrl)}" target="_blank" rel="noopener">🌊 OpenSea</a>`,
    `<a class="detail-link" href="https://x.com/search?q=${query}&f=live" target="_blank" rel="noopener">🔎 ${t('searchX')}</a>`,
    websiteUrl && `<a class="detail-link" href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener">🌐 ${t('website')}</a>`,
  ].filter(Boolean).join('');
  renderRecentMints(data.recent_mints || [], chain);
  renderQuantities(data.mint_quantities || []);
  updateWalletSelectionUi();
  $('#mintInfo').textContent = t('previewFirst');
  updateScamButton();
}

function renderRecentMints(mints, chain) {
  const groups = [];
  for (const mint of mints) {
    const existing = groups.find((item) => item.tx_hash === mint.tx_hash);
    if (existing) {
      existing.count += 1;
      if (mint.token_id != null) existing.tokens.push(Number(mint.token_id));
    } else {
      groups.push({...mint, count: 1, tokens: mint.token_id == null ? [] : [Number(mint.token_id)]});
    }
  }
  $('#mintsTableBody').innerHTML = groups.length ? groups.map((mint) => {
    const token = mint.tokens.length > 1 ? `#${Math.min(...mint.tokens)}–#${Math.max(...mint.tokens)} (${mint.count})` : mint.tokens.length ? `#${mint.tokens[0]}` : '—';
    const toAddress = safeAddress(mint.to_address);
    const txHash = safeTransactionHash(mint.tx_hash);
    return `<tr><td>${escapeHtml(token)}</td><td>${toAddress ? `<a href="${chainInfo(chain).explorer}/address/${toAddress}" target="_blank" rel="noopener">${shorten(toAddress, 8, 6)}</a>` : '—'}</td><td>${txHash ? `<a href="${chainInfo(chain).explorer}/tx/${txHash}" target="_blank" rel="noopener">${shorten(txHash, 10, 6)}</a>` : '—'}</td><td>${escapeHtml(fullTimeAgo(mint.timestamp))}</td></tr>`;
  }).join('') : `<tr><td colspan="4" class="loading-row">${t('noMints')}</td></tr>`;
}

function renderQuantities(quantities) {
  const values = [...new Set(quantities.map((item) => Number(item.qty)).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!values.includes(1)) values.unshift(1);
  state.selectedQuantity = values[0];
  $('#mintQtyOptions').innerHTML = values.map((value, index) => `<button class="mint-qty-btn${index === 0 ? ' active' : ''}" type="button" data-qty="${value}">${value}</button>`).join('');
  $$('.mint-qty-btn').forEach((button) => button.addEventListener('click', () => {
    state.selectedQuantity = Number(button.dataset.qty);
    $$('.mint-qty-btn').forEach((item) => item.classList.toggle('active', item === button));
    cancelPreview();
  }));
}

function walletStatusIcon(status) {
  return ({ready: '✓', pending: '…', sent: '↗', confirmed: '✓', skipped: '!', failed: '×'})[status] || '·';
}

function walletStatusLabel(status) {
  return t(['ready', 'pending', 'sent', 'confirmed', 'skipped', 'failed'].includes(status) ? status : 'pending');
}

function renderJob(job) {
  state.currentJob = {...state.currentJob, ...job};
  if (state.currentJob.status !== 'previewed') delete state.currentJob.confirmationToken;
  const wallets = state.currentJob.wallets || [];
  $('#walletPlanList').innerHTML = wallets.map((wallet) => {
    const status = ['ready', 'pending', 'sent', 'confirmed', 'skipped', 'failed'].includes(wallet.status) ? wallet.status : 'pending';
    return `<div class="wallet-plan-row ${status}">
    <span class="status-icon">${walletStatusIcon(status)}</span>
    <span class="wallet-address" title="${escapeHtml(wallet.address)}">${escapeHtml(shorten(wallet.address, 9, 7))}</span>
    <span class="wallet-cost">${wallet.estimatedTotalEth ? `≈ ${Number(wallet.estimatedTotalEth).toFixed(6)} ETH` : ''}</span>
    <span class="wallet-state">${walletStatusLabel(status)}</span>
    ${wallet.transaction ? `<span class="wallet-plan-details">${escapeHtml(t('planDetails', {to: shorten(wallet.transaction.to, 8, 6), value: wallet.valueEth || '0', gas: wallet.gasLimit || '—', balance: wallet.balanceEth || '—'}))}</span>` : ''}
    ${wallet.reason || wallet.error ? `<span class="wallet-plan-error">${escapeHtml(wallet.reason || wallet.error)}</span>` : ''}
  </div>`;
  }).join('');

  if (state.currentJob.status === 'previewed') {
    const ready = wallets.filter((wallet) => wallet.status === 'ready').length;
    const skipped = wallets.filter((wallet) => wallet.status === 'skipped').length;
    $('#confirmCopy').textContent = t('readyCopy', {ready, skipped});
    $('#mintConfirm').hidden = ready === 0;
    $('#mintBtn').textContent = t('previewReady');
    $('#mintBtn').className = 'mint-btn success';
    $('#mintInfo').textContent = t('previewExpires', {time: new Date(state.currentJob.expiresAt).toLocaleTimeString(state.language)});
  } else if (state.currentJob.status === 'sending') {
    $('#mintConfirm').hidden = true;
    $('#mintBtn').textContent = t('broadcasting');
    $('#mintBtn').className = 'mint-btn loading';
    $('#mintInfo').textContent = t('signing');
  } else if (['completed', 'partial', 'failed'].includes(state.currentJob.status)) {
    $('#mintConfirm').hidden = true;
    $('#mintBtn').disabled = false;
    $('#mintBtn').textContent = state.currentJob.status === 'completed' ? t('batchCompleted') : state.currentJob.status === 'partial' ? t('batchPartial') : t('batchFailed');
    $('#mintBtn').className = `mint-btn ${state.currentJob.status === 'completed' ? 'success' : 'error'}`;
    $('#mintInfo').textContent = t('sentFailed', {sent: state.currentJob.sent?.length || 0, failed: state.currentJob.failed?.length || 0});
    clearInterval(state.currentJobTimer);
  }
}

async function previewMint() {
  const walletAddresses = selectedWalletAddresses();
  if (!state.detail || !walletAddresses.length) return;
  const button = $('#mintBtn');
  button.disabled = true;
  button.className = 'mint-btn loading';
  button.textContent = t('preflighting', {count: walletAddresses.length});
  $('#mintInfo').textContent = t('checkingPlans');
  $('#walletPlanList').innerHTML = '';
  $('#mintConfirm').hidden = true;
  try {
    const job = await fetchJson('/api/mint/preview', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        contractAddress: state.detail.address,
        chainKey: state.selectedChain,
        quantity: state.selectedQuantity,
        tokenId: '0',
        concurrency: Number($('#mintConcurrency').value || 0),
        walletAddresses,
      }),
    });
    renderJob(job);
  } catch (error) {
    button.disabled = false;
    button.className = 'mint-btn error';
    button.textContent = t('previewFailed');
    $('#mintInfo').textContent = error.message;
    const failedWallets = error.body?.failedWallets || [];
    const skippedWallets = error.body?.skippedWallets || [];
    $('#walletPlanList').innerHTML = [...failedWallets, ...skippedWallets].map((wallet) => `<div class="wallet-plan-row ${failedWallets.includes(wallet) ? 'failed' : 'skipped'}">
      <span class="status-icon">${failedWallets.includes(wallet) ? '×' : '!'}</span>
      <span class="wallet-address" title="${escapeHtml(wallet.address)}">${shorten(wallet.address, 9, 7)}</span>
      <span class="wallet-cost"></span>
      <span class="wallet-state">${t(failedWallets.includes(wallet) ? 'failed' : 'skipped')}</span>
      <span class="wallet-plan-error">${escapeHtml(wallet.message || wallet.reason || error.message)}</span>
    </div>`).join('');
  }
}

async function sendMint() {
  if (!state.currentJob?.confirmationToken) return;
  $('#confirmSendBtn').disabled = true;
  try {
    const job = await fetchJson('/api/mint/send', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jobId: state.currentJob.id, confirmationToken: state.currentJob.confirmationToken}),
    });
    renderJob(job);
    clearInterval(state.currentJobTimer);
    state.currentJobTimer = setInterval(pollJob, 1200);
  } catch (error) {
    $('#confirmSendBtn').disabled = false;
    toast(error.message);
  }
}

async function pollJob() {
  if (!state.currentJob?.id) return;
  try { renderJob(await fetchJson(`/api/mint/jobs/${state.currentJob.id}`)); } catch { clearInterval(state.currentJobTimer); }
}

function cancelPreview() {
  clearInterval(state.currentJobTimer);
  state.currentJob = null;
  $('#walletPlanList').innerHTML = '';
  $('#mintConfirm').hidden = true;
  $('#mintBtn').className = 'mint-btn';
  updateMintPreviewButton();
  $('#mintInfo').textContent = selectedWalletAddresses().length
    ? t('previewOnly')
    : t('selectWallet');
}

function sendWs(value) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(value));
}

function connectWs() {
  clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${protocol}//${location.host}/ws/mints`);
  state.ws.onopen = () => {
    if (state.selectedAddress) sendWs({type: 'view', address: state.selectedAddress, chain: state.selectedChain});
  };
  state.ws.onmessage = (event) => {
    let value;
    try { value = JSON.parse(event.data); } catch { return; }
    handleMessage(value);
  };
  state.ws.onclose = () => {
    const pill = $('#upstreamPill');
    pill.dataset.status = 'polling';
    pill.classList.remove('connected');
    pill.lastChild.textContent = ` ${t('livePolling')}`;
    state.reconnectTimer = setTimeout(connectWs, 2000);
  };
}

function handleMessage(value) {
  if (value.type === 'chains') {
    state.chains = value.chains || state.chains;
  } else if (value.type === 'overview') {
    state.allWindows = value.windows || state.allWindows;
    state.collections = state.allWindows[String(state.timeWindow)] || state.collections;
    renderOverview();
  } else if (value.type === 'mint') {
    renderMint(value);
  } else if (value.type === 'name_update') {
    updateName(value);
  } else if (value.type === 'alert') {
    renderAlert(value);
  } else if (value.type === 'milestone') {
    renderMilestone(value);
  } else if (['viewers', 'hide_count', 'scam_count'].includes(value.type)) {
    updateSocialStat(value);
  } else if (value.type === 'price_update') {
    updatePrice(value);
  } else if (value.type === 'mint_job') {
    if (state.currentJob?.id === value.jobId) renderJob(value.job);
    renderLocalJobEvent(value);
  } else if (value.type === 'upstream_status') {
    const pill = $('#upstreamPill');
    pill.dataset.status = value.status;
    pill.classList.toggle('connected', ['connected', 'polling'].includes(value.status));
    pill.lastChild.textContent = value.status === 'connected' ? ` ${t('liveFeed')}` : ` ${t('livePolling')}`;
  }
}

function renderMint(value) {
  const chain = chainOf(value);
  const key = collectionKey(chain, value.address);
  if (state.hidden[key]) return;
  const minter = String(value.to_address || value.tx_hash || 'overview').toLowerCase();
  const groupKey = `${key}:${minter}`;
  const existing = state.feedIndex.get(groupKey);
  const now = Date.now();
  const eventCount = Math.max(1, Number(value.activity_count || 1));
  if (state.selectedKey === key && state.detail) {
    const supply = resolveMintSupplyUpdate(state.detail, value);
    if (supply.authoritative) {
      clearTimeout(state.detailRefreshTimer);
      state.detailRefreshTimer = null;
      state.detail.current_supply = supply.currentSupply;
      if (supply.maxSupply != null) state.detail.max_supply = supply.maxSupply;
      const currentSupply = $('[data-stat-key="totalMinted"] .stat-value', $('#detailStats'));
      const maxSupply = $('[data-stat-key="maxSupply"] .stat-value', $('#detailStats'));
      if (currentSupply) currentSupply.textContent = supply.currentSupply.toLocaleString();
      if (maxSupply && supply.maxSupply != null) maxSupply.textContent = supply.maxSupply.toLocaleString();
    } else {
      scheduleDetailRefresh(key);
    }
    if (value.tx_hash) {
      renderRecentMints([{timestamp: value.timestamp, to_address: value.to_address, token_id: value.token_id, tx_hash: value.tx_hash}, ...(state.detail.recent_mints || [])].slice(0, 50), chain);
    }
  }
  if (existing && now - Number(existing.dataset.seenAt) < 60_000) {
    const count = Number(existing.dataset.count || 1) + eventCount;
    existing.dataset.count = String(count);
    existing.dataset.seenAt = String(now);
    $('.le-count', existing).textContent = `×${count}`;
    const details = $('.le-details', existing);
    if (details && value.mint_price) {
      const priceIcon = value.mint_price_raw === 0 || value.mint_price === 'Free' ? '🆓' : '♦';
      const destination = value.to_address ? ` · → ${shorten(value.to_address, 6, 4)}` : ` · ${t('activityUpdate')}`;
      details.textContent = `${priceIcon} ${value.mint_price}${destination}`;
      existing._i18nData = {kind: 'mint', value: {...value}, chain, eventCount: count};
    }
    $('.le-time', existing).dataset.ts = value.timestamp;
    $('.le-time', existing).textContent = t('now');
    return;
  }
  const row = document.createElement('div');
  row.className = 'live-event';
  row.dataset.chain = chain;
  row.dataset.key = key;
  row.dataset.address = value.address;
  row.dataset.seenAt = String(now);
  row.dataset.count = String(eventCount);
  row._i18nData = {kind: 'mint', value: {...value}, chain, eventCount};
  row.hidden = !chainPasses(chain);
  const hasPrice = Boolean(value.mint_price);
  const priceIcon = value.mint_price_raw === 0 || value.mint_price === 'Free' ? '🆓' : hasPrice ? '♦' : '🔄';
  const priceCopy = hasPrice ? escapeHtml(value.mint_price) : t('syncing');
  const destination = value.to_address ? ` · → ${shorten(value.to_address, 6, 4)}` : ` · ${t('activityUpdate')}`;
  const mintTxHash = safeTransactionHash(value.tx_hash);
  const txLink = mintTxHash ? `<div class="le-actions"><a class="le-action" href="${chainInfo(chain).explorer}/tx/${mintTxHash}" target="_blank" rel="noopener">🔗</a></div>` : '';
  const mintImage = safeImageUrl(value.image_url);
  row.innerHTML = `<div class="le-thumb">${mintImage ? `<img src="${mintImage}" alt="">` : '🎨'}</div><div class="le-info"><button class="le-name" type="button">${escapeHtml(value.name || t('unknown'))}<span class="le-count">×${eventCount}</span><span class="chain-badge">${chainInfo(chain).emoji} ${escapeHtml(chainInfo(chain).label)}</span>${value.is_airdrop ? ' 🪂' : ''}</button><div class="le-details">${priceIcon} ${priceCopy}${escapeHtml(destination)}</div></div><div class="le-right"><div class="le-time" data-ts="${escapeHtml(value.timestamp)}">${timeAgo(value.timestamp)}</div></div>${txLink}`;
  $('.le-name', row).addEventListener('click', () => selectCollection(value.address, chain));
  const feed = $('#liveFeed');
  $('.loading-row', feed)?.remove();
  feed.prepend(row);
  state.feedIndex.set(groupKey, row);
  while (feed.children.length > state.maxLive) feed.lastElementChild.remove();
}

function renderAlert(value) {
  const chain = chainOf(value);
  const row = document.createElement('div');
  row.className = `live-event alert-event ${String(value.level || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}`;
  row.dataset.chain = chain;
  row._i18nData = {kind: 'alert', value: {...value}, chain};
  row.hidden = !chainPasses(chain);
  row.innerHTML = `<div class="le-thumb">${escapeHtml(value.emoji || '⚡')}</div><div class="le-info"><button class="le-name" type="button">${escapeHtml(value.level)} — ${escapeHtml(value.name)}</button><div class="le-details">${Number(value.recent_mints || 0).toLocaleString()} ${t('mints')} · ${Number(value.unique_minters || 0).toLocaleString()} ${t('unique')} · ${escapeHtml(value.mint_price || '?')}</div></div><div class="le-right"><div class="le-time" data-ts="${escapeHtml(value.timestamp)}">${timeAgo(value.timestamp)}</div></div>`;
  $('.le-name', row).onclick = () => selectCollection(value.address, chain);
  $('#liveFeed').prepend(row);
}

function renderMilestone(value) {
  renderAlert({...value, emoji: '📊', level: t('milestone', {value: value.milestone}), levelKey: 'milestone', levelValue: value.milestone, recent_mints: `${Number(value.supply || 0).toLocaleString()} / ${Number(value.max_supply || 0).toLocaleString()}`, unique_minters: '', mint_price: ''});
}

function renderLocalJobEvent(value) {
  const event = value.event || {};
  const supported = ['wallet_pending', 'wallet_sent', 'wallet_confirmed', 'wallet_failed'];
  if (!event.address || !supported.includes(event.type)) return;

  const job = value.job || {};
  const chain = job.chainKey || state.selectedChain || 'hood';
  const wallet = (job.wallets || []).find((item) => item.address === event.address) || {};
  const quantity = job.quantity || '1';
  const valueEth = event.valueEth ?? wallet.valueEth;
  const timestampMs = Date.parse(value.timestamp || job.updatedAt || '') || Date.now();
  const timestamp = Math.floor(timestampMs / 1000);
  const rowKey = `${value.jobId || job.id || 'job'}:${event.address.toLowerCase()}`;
  const feed = $('#liveFeed');
  let row = $$('.mint-job-event', feed).find((item) => item.dataset.jobWallet === rowKey);
  if (!row) {
    row = document.createElement('div');
    row.dataset.jobWallet = rowKey;
    feed.prepend(row);
  }

  const status = event.type.replace('wallet_', '');
  const icon = ({pending: '⏳', sent: '↗️', confirmed: '✅', failed: '❌'})[status] || '⚡';
  const detail = event.hash
    ? `${walletStatusLabel(status)} · ${t('txShort')} ${shorten(event.hash, 10, 6)}`
    : event.error
      ? `${walletStatusLabel(status)} · ${escapeHtml(event.error)}`
      : `${walletStatusLabel(status)} · ${t('signingTransaction')}`;
  const valueCopy = valueEth == null ? t('valuePending') : `${escapeHtml(valueEth)} ETH`;
  const eventHash = safeTransactionHash(event.hash);
  const txLink = eventHash
    ? `<div class="le-actions"><a class="le-action" href="${chainInfo(chain).explorer}/tx/${eventHash}" target="_blank" rel="noopener">🔗</a></div>`
    : '';

  row.className = `live-event mint-job-event ${status}`;
  row.dataset.chain = chain;
  row._i18nData = {kind: 'job', value, chain};
  row.hidden = !chainPasses(chain);
  row.innerHTML = `<div class="le-thumb">${icon}</div><div class="le-info"><div class="le-name">${t('wallet')} ${shorten(event.address, 7, 5)}<span class="chain-badge">${chainInfo(chain).emoji} ${escapeHtml(chainInfo(chain).label)}</span></div><div class="le-details">${t('quantityShort')} ${escapeHtml(quantity)} · ${valueCopy} · ${detail}</div></div><div class="le-right"><div class="le-time" data-ts="${timestamp}">${timeAgo(timestamp)}</div></div>${txLink}`;
  $('.loading-row', feed)?.remove();
  feed.prepend(row);
  while (feed.children.length > state.maxLive) feed.lastElementChild.remove();
}

function updateName(value) {
  const key = collectionKey(chainOf(value), value.address);
  for (const windowRows of Object.values(state.allWindows)) {
    const item = windowRows.find((candidate) => collectionKey(chainOf(candidate), candidate.address) === key);
    if (item) Object.assign(item, {name: value.name, full_name: value.full_name, image_url: value.image_url, twitter: value.twitter});
  }
  if (state.selectedKey === key) $('#detailTitle').textContent = value.full_name || value.name;
  renderOverview();
}

function updateSocialStat(value) {
  if (state.selectedKey !== collectionKey(chainOf(value), value.address)) return;
  const map = {viewers: '#viewerCount', hide_count: '#hideCount', scam_count: '#scamCount'};
  const element = $(map[value.type]);
  if (element) element.textContent = value.count;
}

function updatePrice(value) {
  const key = collectionKey(chainOf(value), value.address);
  $$('#liveFeed .live-event').filter((row) => row.dataset.key === key).forEach((row) => {
    const details = $('.le-details', row);
    if (!details) return;
    const destination = details.textContent.split('→')[1]?.trim() || '';
    const priceIcon = value.mint_price_raw === 0 || value.mint_price_raw == null || value.mint_price === 'Free' ? '🆓' : '♦';
    details.textContent = `${priceIcon} ${value.mint_price || '?'}${destination ? ` · → ${destination}` : ''}`;
    if (row._i18nData?.kind === 'mint') Object.assign(row._i18nData.value, value);
    if (value.is_airdrop && !$('.badge-airdrop', row)) {
      $('.le-name', row)?.insertAdjacentHTML('beforeend', ' <span class="badge-airdrop">🪂</span>');
    }
  });
  if (state.selectedKey !== collectionKey(chainOf(value), value.address)) return;
  const priceCell = $('[data-stat-key="mintPrice"]');
  if (priceCell) $('.stat-value', priceCell).textContent = value.mint_price || '?';
  if (state.detail) {
    state.detail.mint_price = value.mint_price;
    state.detail.mint_price_raw = value.mint_price_raw;
    if (value.is_airdrop) state.detail.is_airdrop = true;
  }
  if (value.is_airdrop && !$('#detailBadges .badge-airdrop')) {
    $('#detailBadges').insertAdjacentHTML('beforeend', `<span class="detail-badge standard badge-airdrop">🪂 ${t('airdrop')}</span>`);
  }
  if (state.currentJob?.status === 'previewed') {
    cancelPreview();
    $('#mintBtn').textContent = t('priceUpdated');
    $('#mintInfo').textContent = t('priceUpdatedInfo');
  }
}

function updateScamButton() {
  const key = `mintscan_scam_${state.selectedKey}`;
  const reported = localStorage.getItem(key) === '1';
  $('#reportScamBtn').classList.toggle('active', reported);
  $('#reportScamBtn').textContent = reported ? t('reported') : t('scam');
}

function renderLiveFeedTranslations() {
  $$('.le-time[data-ts]').forEach((element) => { element.textContent = timeAgo(element.dataset.ts); });
  const loading = $('#liveFeed .loading-row');
  if (loading) loading.textContent = t('connectingFeed');
  $$('#liveFeed .live-event').forEach((row) => {
    const data = row._i18nData;
    if (!data) return;
    if (data.kind === 'mint') {
      const value = data.value;
      const details = $('.le-details', row);
      if (details) {
        const hasPrice = Boolean(value.mint_price);
        const priceIcon = value.mint_price_raw === 0 || value.mint_price === 'Free' ? '🆓' : hasPrice ? '♦' : '🔄';
        const destination = value.to_address ? ` · → ${shorten(value.to_address, 6, 4)}` : ` · ${t('activityUpdate')}`;
        details.textContent = `${priceIcon} ${value.mint_price || t('syncing')}${destination}`;
      }
    } else if (data.kind === 'alert') {
      const value = data.value;
      if (value.levelKey) $('.le-name', row).textContent = `${t(value.levelKey, {value: value.levelValue})} — ${value.name}`;
      const details = $('.le-details', row);
      if (details) details.textContent = `${value.recent_mints || 0} ${t('mints')} · ${value.unique_minters || 0} ${t('unique')} · ${value.mint_price || '?'}`;
    } else if (data.kind === 'job') {
      const value = data.value;
      const event = value.event || {};
      const job = value.job || {};
      const wallet = (job.wallets || []).find((item) => item.address === event.address) || {};
      const status = event.type?.replace('wallet_', '') || 'pending';
      const valueEth = event.valueEth ?? wallet.valueEth;
      const detail = event.hash
        ? `${walletStatusLabel(status)} · ${t('txShort')} ${shorten(event.hash, 10, 6)}`
        : event.error ? `${walletStatusLabel(status)} · ${event.error}` : `${walletStatusLabel(status)} · ${t('signingTransaction')}`;
      $('.le-name', row).firstChild.textContent = `${t('wallet')} ${shorten(event.address, 7, 5)}`;
      $('.le-details', row).textContent = `${t('quantityShort')} ${job.quantity || '1'} · ${valueEth == null ? t('valuePending') : `${valueEth} ETH`} · ${detail}`;
    }
  });
}

function toggleScam() {
  if (!state.selectedKey) return;
  const key = `mintscan_scam_${state.selectedKey}`;
  const reported = localStorage.getItem(key) === '1';
  localStorage.setItem(key, reported ? '0' : '1');
  sendWs({type: reported ? 'unreport_scam' : 'report_scam', address: state.selectedAddress, chain: state.selectedChain});
  updateScamButton();
}

function checkHash() {
  const match = location.hash.slice(1).match(/^(?:([a-z0-9_-]+):)?(0x[a-fA-F0-9]{40})$/);
  if (match) selectCollection(match[2], match[1] || 'ethereum');
}

function bindEvents() {
  const searchInput = $('#searchInput');
  searchInput.addEventListener('input', (event) => { state.search = event.target.value; renderOverview(); });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const match = event.currentTarget.value.trim().match(/^(?:(ethereum|hood):)?(0x[a-fA-F0-9]{40})$/);
    if (!match) return;
    const chain = match[1] || (state.chainFilter === 'ethereum' ? 'ethereum' : 'hood');
    selectCollection(match[2], chain);
  });
  $$('.chain-filter').forEach((button) => button.addEventListener('click', () => setChainFilter(button.dataset.chain)));
  $$('.time-filter').forEach((button) => button.addEventListener('click', () => setTimeWindow(button.dataset.window)));
  $$('.language-option').forEach((button) => button.addEventListener('click', () => setLanguage(button.dataset.lang)));
  $$('.mobile-tab').forEach((button) => button.addEventListener('click', () => switchMobileTab(button.dataset.panel)));
  $('#detailBack').addEventListener('click', () => switchMobileTab('left'));
  $('#resyncBtn').addEventListener('click', () => refreshSelectedDetail().catch((error) => toast(error.message)));
  $('#hiddenCounter').addEventListener('click', () => { $('#hiddenPanel').hidden = false; });
  $('#hiddenBar').addEventListener('click', () => { $('#hiddenPanel').hidden = false; });
  $('#closeHiddenBtn').addEventListener('click', () => { $('#hiddenPanel').hidden = true; });
  $('#hideCollectionBtn').addEventListener('click', () => state.selectedAddress && hideCollection(state.selectedChain, state.selectedAddress));
  $('#reportScamBtn').addEventListener('click', toggleScam);
  $('#mintBtn').addEventListener('click', () => state.currentJob?.status === 'previewed' ? undefined : previewMint());
  $('#confirmSendBtn').addEventListener('click', sendMint);
  $('#cancelPreviewBtn').addEventListener('click', cancelPreview);
  $('#selectAllWallets').addEventListener('change', (event) => setAllWalletsSelected(event.currentTarget.checked));
  $('#walletSelectionList').addEventListener('change', (event) => {
    const checkbox = event.target.closest('.wallet-select-checkbox');
    if (!checkbox) return;
    const key = checkbox.value.toLowerCase();
    if (checkbox.checked) state.selectedWallets.add(key);
    else state.selectedWallets.delete(key);
    updateWalletSelectionUi({resetPreview: true});
  });
  const liveFeed = $('#liveFeed');
  liveFeed.addEventListener('mouseenter', () => $('#feedPaused').classList.add('on'));
  liveFeed.addEventListener('mouseleave', () => $('#feedPaused').classList.remove('on'));
  window.addEventListener('hashchange', checkHash);
}

async function init() {
  applyStaticTranslations();
  bindEvents();
  updateHiddenUi();
  setChainFilter(state.chainFilter);
  setTimeWindow(state.timeWindow);
  connectWs();
  try {
    await Promise.all([loadChains(), loadOverview(), loadWallets()]);
    checkHash();
  } catch (error) {
    toast(error.message);
  }
  setInterval(renderLiveFeedTranslations, 1000);
  setInterval(() => { if (!document.hidden) loadOverview().catch(() => {}); }, 5000);
}

init();
