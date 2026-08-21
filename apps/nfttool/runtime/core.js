import {
  readStoredWalletIds,
  reconcileWalletIds,
  writeStoredWalletIds,
} from './wallet-groups.js';

const ACTIVE_CHAIN_KEY = 'nfttool:active-chain';
const WRITE_CHAIN_KEY = 'nfttool:write-chain';
const WRITE_RPC_PROFILE_KEY = 'nfttool:write-rpc-profile';
const WRITE_RPC_PROFILE_REF_KEY = 'nfttool:write-rpc-profile-ref';
const CUSTOM_RPC_ENDPOINTS_KEY = 'nfttool:custom-rpc-endpoints';
const LEGACY_RPC_SELECTION_KEY = 'nfttool:rpc-selection';
// Reads are cheap, so they fail fast. Writes default long on purpose: a task route
// broadcasts transactions in a sequential loop, and aborting one that is actually
// working would invite a retry that double-sends. Call sites where a timeout is
// harmless (previews, queries) pass a shorter timeoutMs.
const API_READ_TIMEOUT_MS = 30_000;
const API_WRITE_TIMEOUT_MS = 300_000;
const PROFILE_LABELS = [
  ['ethereum', 'Ethereum'],
  ['bsc', 'BSC'],
  ['base', 'Base'],
  ['robinhood', 'Robinhood'],
  ['custom', '自定义'],
];

const routeMeta = {
  walletManager: { title: '钱包管理', section: '钱包模块' },
  ethDisperse: { title: '分发代币', section: '钱包模块' },
  ethCollection: { title: '归集代币', section: '钱包模块' },
  moreToMore: { title: '多对多转账', section: '钱包模块' },
  despositToExchange: { title: '交易所充值', section: '钱包模块' },
  mint: { title: 'NFT 盯盘', section: '数据流' },
  documentaryList: { title: '跟单 / 自动铸造', section: '跟单模块' },
  signTask: { title: '签名任务', section: 'Mint 高级版' },
  highHexMint: { title: '高级铸造', section: 'Mint 高级版' },
  opensea: { title: 'OpenSea', section: 'Mint 高级版' },
  magiceden: { title: 'Magic Eden', section: 'Mint 高级版' },
  fairMint: { title: 'Fair Mint', section: 'Mint 高级版' },
  manifold: { title: 'Manifold', section: 'Mint 高级版' },
  indelible: { title: 'Indelible', section: 'Mint 高级版' },
  bueno: { title: 'Bueno', section: 'Mint 高级版' },
  sound: { title: 'Sound', section: 'Mint 高级版' },
  gmstudio: { title: 'GM Studio', section: 'Mint 高级版' },
  ensRegister: { title: 'ENS Register', section: 'Mint 高级版' },
  skyarkchronicles: { title: 'SkyArk Chronicles', section: 'Mint 高级版' },
  skyarkchroniclesCollection: { title: 'SkyArk NFT Collection', section: 'Mint 高级版' },
  skyarkchroniclesDisperse: { title: 'SkyArk NFT Disperse', section: 'Mint 高级版' },
  batchSell: { title: '批量挂单', section: 'NFT 管理' },
  collectionNFT: { title: 'NFT 归集', section: 'NFT 管理' },
  batchApprove: { title: '批量授权', section: 'NFT 管理' },
};

function storedSelection() {
  return new Set(readStoredWalletIds());
}

function storedWriteProfile() {
  const saved = String(localStorage.getItem(WRITE_RPC_PROFILE_KEY) || '').trim().toLowerCase();
  if (saved === 'main') {
    localStorage.setItem(WRITE_RPC_PROFILE_KEY, 'ethereum');
    return 'ethereum';
  }
  if (saved === 'hk') {
    localStorage.setItem(WRITE_RPC_PROFILE_KEY, 'ethereum');
    return 'ethereum';
  }
  if (['flashbots', 'arbitrum', 'zks', 'shib'].includes(saved)) {
    localStorage.setItem(WRITE_RPC_PROFILE_KEY, 'ethereum');
    localStorage.removeItem(WRITE_RPC_PROFILE_REF_KEY);
    return 'ethereum';
  }
  if (saved) return saved;
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_RPC_SELECTION_KEY) || '{}');
    if (legacy && typeof legacy === 'object' && Object.values(legacy).some((value) => /^rpc-\d+$/.test(String(value)))) {
      localStorage.setItem(WRITE_RPC_PROFILE_KEY, 'ethereum');
    }
    localStorage.removeItem?.(LEGACY_RPC_SELECTION_KEY);
  } catch {
    localStorage.removeItem?.(LEGACY_RPC_SELECTION_KEY);
  }
  return 'ethereum';
}

function storedRpcSelections() {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_RPC_SELECTION_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function invalidateWritePreviews(state = runtimeState) {
  const seen = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Object.prototype.hasOwnProperty.call(value, 'job')) value.job = null;
    if (Object.prototype.hasOwnProperty.call(value, 'plan')) value.plan = null;
    if (Array.isArray(value.jobs)) value.jobs = [];
    if (Array.isArray(value.approvalPlans)) value.approvalPlans = [];
    for (const child of Object.values(value)) visit(child);
  };
  visit(state.page);
}

export const runtimeState = {
  routeName: 'walletManager',
  wallets: [],
  chains: [],
  selected: storedSelection(),
  chainId: Number(localStorage.getItem(ACTIVE_CHAIN_KEY) || 1),
  transactionChainId: Number(localStorage.getItem(WRITE_CHAIN_KEY) || 1),
  writeProfileId: storedWriteProfile(),
  writeProfileRef: String(localStorage.getItem(WRITE_RPC_PROFILE_REF_KEY) || '').trim(),
  customRpcEndpoints: String(localStorage.getItem(CUSTOM_RPC_ENDPOINTS_KEY) || '').trim(),
  rpcProfilesByChain: {},
  rpcProfiles: [],
  rpcReadByChain: {},
  rpcSelections: storedRpcSelections(),
  rpcByChain: {},
  rpcLoadingChainId: null,
  rpcProfileTesting: '',
  rpcProfileSwitching: false,
  page: {},
  busy: false,
  bootError: '',
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function shortAddress(value) {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text || '-';
}

export function currentChain(state = runtimeState) {
  return state.chains.find((chain) => Number(chain.id) === Number(state.chainId)) || state.chains[0] || {
    id: 1,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
  };
}

export function selectedIds(state = runtimeState) {
  return state.wallets.filter((wallet) => state.selected.has(wallet.id)).map((wallet) => wallet.id);
}

export function persistSelection(state = runtimeState) {
  const ids = reconcileWalletIds(state.selected, state.wallets);
  state.selected = new Set(writeStoredWalletIds(ids));
}

export function requestDeadline({ method = 'GET', timeoutMs, signal } = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : String(method).toUpperCase() === 'GET' ? API_READ_TIMEOUT_MS : API_WRITE_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(budget);
  return { budget, deadline, signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
}

function requestFailure(error, path, deadline, budget) {
  if (!deadline.aborted) return error;
  const failure = new Error(`请求超时：${path} 在 ${Math.round(budget / 1000)} 秒内没有响应`);
  failure.name = 'TimeoutError';
  failure.timeoutMs = budget;
  failure.cause = error;
  return failure;
}

export async function api(path, options = {}) {
  const { timeoutMs, signal: callerSignal, ...init } = options;
  const { budget, deadline, signal } = requestDeadline({ method: init.method, timeoutMs, signal: callerSignal });
  let response;
  try {
    response = await fetch(path, {
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      ...init,
      signal,
    });
  } catch (error) {
    throw requestFailure(error, path, deadline, budget);
  }
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  let body;
  try {
    body = isJson ? await response.json() : await response.text();
  } catch (error) {
    if (signal.aborted || !isJson) throw requestFailure(error, path, deadline, budget);
    body = {};
  }
  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.error || body?.message || `请求失败：${response.status}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

export function nativeToWei(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d{0,18})?$/.test(text)) throw new Error('金额必须是最多 18 位小数的非负数');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18))).toString();
}

export function chainOptions(state = runtimeState) {
  return state.chains.map((chain) => `
    <option value="${chain.id}" ${Number(chain.id) === Number(state.chainId) ? 'selected' : ''}>
      ${escapeHtml(chain.name)} (${escapeHtml(chain.nativeSymbol)})
    </option>
  `).join('');
}

export function rpcStatus(state = runtimeState) {
  return (state.rpcReadByChain || state.rpcByChain || {})[String(state.chainId)] || {
    state: 'unprobed',
    activeHost: '',
    activeId: '',
    preferredId: '',
    upstreams: [],
  };
}

export function writeProfiles(state = runtimeState) {
  const rows = state.rpcProfiles;
  if (Array.isArray(rows) && rows.length) return rows;
  return PROFILE_LABELS.map(([id, label], index) => ({
    id,
    label,
    chainId: [1, 56, 8453, 4663, null][index],
    applicable: true,
    available: true,
    configured: id === 'custom' ? false : true,
    host: '',
    lastTest: null,
  }));
}

export function writeProfileId(state = runtimeState) {
  const requested = String(state.writeProfileId || localStorage.getItem(WRITE_RPC_PROFILE_KEY) || 'ethereum').trim().toLowerCase();
  const normalized = requested === 'main' || requested === 'hk' ? 'ethereum' : ['flashbots', 'arbitrum', 'zks', 'shib'].includes(requested) ? 'ethereum' : requested;
  const profile = writeProfiles(state).find((item) => item.id === normalized);
  return profile?.id || 'ethereum';
}

export function writeChainId(state = runtimeState) {
  const profile = writeProfiles(state).find((item) => item.id === writeProfileId(state));
  return Number(profile?.chainId || state.transactionChainId || state.chainId || 1);
}

export function writeChain(state = runtimeState) {
  const id = writeChainId(state);
  return state.chains?.find((chain) => Number(chain.id) === id) || {
    id,
    name: id ? `Chain ${id}` : '自定义链',
    nativeSymbol: 'ETH',
  };
}

export function syncWriteChain(state = runtimeState, chainId) {
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) return null;
  state.chainId = id;
  state.transactionChainId = id;
  localStorage.setItem(ACTIVE_CHAIN_KEY, String(id));
  localStorage.setItem(WRITE_CHAIN_KEY, String(id));
  return id;
}

export function writeProfileRef(state = runtimeState) {
  return writeProfileId(state) === 'custom'
    ? String(state.writeProfileRef || localStorage.getItem(WRITE_RPC_PROFILE_REF_KEY) || '').trim()
    : '';
}

export function customRpcEndpoints(state = runtimeState) {
  return String(state.customRpcEndpoints || localStorage.getItem(CUSTOM_RPC_ENDPOINTS_KEY) || '').trim();
}

function writeProfileOptions(state = runtimeState) {
  const selected = writeProfileId(state);
  const profiles = writeProfiles(state);
  const profileBusy = Boolean(state.rpcProfileTesting || state.rpcProfileSwitching);
  const radios = profiles.map((profile) => {
    const label = profile.label || PROFILE_LABELS.find(([id]) => id === profile.id)?.[1] || profile.id;
    const test = profile.lastTest;
    const stateText = profile.id === 'custom' && !test?.ok
      ? '需输入并测试'
      : test?.ok
        ? `${test.latencyMs} ms`
        : test?.ok === false
          ? '测试失败'
          : '';
    return `<label class="rpc-profile-option ${profile.id === selected ? 'is-selected' : ''}"><input class="rpc-profile-radio" type="radio" name="writeRpcProfile" value="${escapeHtml(profile.id)}" ${profile.id === selected ? 'checked' : ''} ${profileBusy ? 'disabled' : ''}><span>${escapeHtml(label)}</span>${stateText ? `<small>${escapeHtml(stateText)}</small>` : ''}</label>`;
  }).join('');
  const custom = selected === 'custom';
  return `
    <fieldset class="rpc-profile-group" aria-label="发送节点"><legend>发送节点</legend><div class="rpc-profile-radios">${radios}</div>${custom ? `<label class="custom-rpc-field"><span>个人 RPC（每行一个 HTTP(S) 地址）</span><textarea class="custom-rpc-input" name="customRpcEndpoints" rows="3" placeholder="https://rpc.example\nhttps://backup.example">${escapeHtml(customRpcEndpoints(state))}</textarea></label>` : ''}<button class="button secondary rpc-profile-test" type="button" data-rpc-profile-test="${escapeHtml(selected)}" ${profileBusy ? 'disabled' : ''}>${state.rpcProfileTesting ? '测试中…' : '测试'}</button></fieldset>
  `;
}

export function networkBar({ state = runtimeState, asset = 'native', tokenAddress = '', includeAsset = true, mode = 'writeProfile', readOnly = false } = {}) {
  const chain = readOnly || mode === 'readOnly' ? currentChain(state) : writeChain(state);
  return `
    <section class="network-bar" aria-label="交易设置">
      ${readOnly || mode === 'readOnly' ? '' : writeProfileOptions(state)}
      ${includeAsset ? `
        <fieldset class="choice-row">
          <legend>Choose Token</legend>
          <label><input type="radio" name="asset" value="native" ${asset === 'native' ? 'checked' : ''}> ${escapeHtml(chain.nativeSymbol)}</label>
          <label><input type="radio" name="asset" value="erc20" ${asset === 'erc20' ? 'checked' : ''}> Customize</label>
        </fieldset>
        <label class="inline-field token-field ${asset === 'erc20' ? '' : 'is-hidden'}"><span>Token Contract</span><input name="tokenAddress" value="${escapeHtml(tokenAddress)}" placeholder="0x..." spellcheck="false"></label>
      ` : ''}
      <span class="network-count">账号(${state.wallets.length})</span>
    </section>
  `;
}

export function walletBalance(wallet, chainId, tokenKey = 'native') {
  return wallet.balances?.find((row) => Number(row.chainId) === Number(chainId) && row.tokenKey === tokenKey) || null;
}

export function renderPlan(plan, emptyText = '尚未生成预览') {
  if (!plan) return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  const entries = Array.isArray(plan.entries) ? plan.entries : [];
  return `
    <div class="plan-summary">
      <div><span>交易数</span><strong>${entries.length}</strong></div>
      <div><span>执行模式</span><strong>${escapeHtml(plan.confirmation?.mode || '顺序')}</strong></div>
      <div><span>预览有效期</span><strong>${escapeHtml(plan.confirmation?.expiresAt ? new Date(plan.confirmation.expiresAt).toLocaleTimeString('zh-CN') : '-')}</strong></div>
    </div>
    <div class="table-scroll compact-table">
      <table>
        <thead><tr><th>#</th><th>钱包</th><th>交易摘要</th></tr></thead>
        <tbody>${entries.map((entry, index) => `
          <tr><td>${index + 1}</td><td>${escapeHtml(entry.walletId || '-')}</td><td class="mono">${escapeHtml(entry.summary || shortAddress(entry.to))}</td></tr>
        `).join('') || '<tr><td colspan="3">当前参数没有生成可执行交易</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

export function confirmationBody(plan) {
  const confirmation = plan?.confirmation;
  if (!confirmation?.previewId || !confirmation?.confirmationToken) throw new Error('预览确认凭据已失效，请重新生成预览');
  return {
    previewId: confirmation.previewId,
    confirmationToken: confirmation.confirmationToken,
  };
}

function setBusy(value) {
  runtimeState.busy = value;
  document.body.classList.toggle('is-busy', value);
  document.querySelector('#app')?.setAttribute('aria-busy', String(value));
}

export function toast(message, type = 'success') {
  const region = document.querySelector('#toast-region');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), 3600);
}

export async function runAction(action, { success = '', refresh = false, rerender = true } = {}) {
  if (runtimeState.busy) return null;
  setBusy(true);
  try {
    const result = await action();
    if (refresh) await refreshRuntimeData();
    if (success) toast(success);
    if (rerender) renderRuntime();
    return result;
  } catch (error) {
    toast(error.message || '操作失败', 'error');
    return null;
  } finally {
    setBusy(false);
  }
}

export function openDialog({ title, body, confirmText = '确定', danger = false, onSubmit }) {
  const root = document.querySelector('#dialog-root');
  root.innerHTML = `
    <dialog class="runtime-dialog">
      <form method="dialog">
        <header><h2>${escapeHtml(title)}</h2><button type="button" class="icon-button dialog-close" aria-label="关闭" title="关闭">&times;</button></header>
        <div class="dialog-body">${body}</div>
        <footer><button type="button" class="button secondary dialog-cancel">取消</button><button type="submit" class="button ${danger ? 'danger' : 'primary'}">${escapeHtml(confirmText)}</button></footer>
      </form>
    </dialog>
  `;
  const dialog = root.querySelector('dialog');
  const close = () => {
    dialog.close();
    root.innerHTML = '';
  };
  root.querySelector('.dialog-close').addEventListener('click', close);
  root.querySelector('.dialog-cancel').addEventListener('click', close);
  root.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const complete = await onSubmit(values, event.currentTarget);
    if (complete !== false) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.showModal();
}

export function bindWalletChecks(root, state = runtimeState, selector = '[data-wallet-check]') {
  root.querySelectorAll(selector).forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(input.value);
      else state.selected.delete(input.value);
      persistSelection(state);
      renderRuntime();
    });
  });
}

export async function refreshRuntimeData() {
  const [walletData, chainData] = await Promise.all([api('/api/wallets'), api('/api/chains')]);
  runtimeState.wallets = walletData.wallets || [];
  runtimeState.chains = chainData.chains || [];
  if (!runtimeState.chains.some((chain) => Number(chain.id) === Number(runtimeState.chainId))) {
    runtimeState.chainId = Number(runtimeState.chains[0]?.id || 1);
  }
  persistSelection(runtimeState);
  await refreshRpcProfiles({ render: false });
  await refreshRpcStatus(runtimeState.chainId, { render: false });
}

export async function refreshRpcStatus(chainId = runtimeState.chainId, { render = true } = {}) {
  const id = Number(chainId);
  runtimeState.rpcLoadingChainId = id;
  try {
    const data = await api(`/api/rpc-pool/status?chainId=${encodeURIComponent(id)}`);
    const row = data.chains?.find((item) => Number(item.chainId) === id) || data.chains?.[0];
    if (row) {
      runtimeState.rpcReadByChain[String(id)] = row;
      runtimeState.rpcByChain[String(id)] = row;
    }
  } catch (error) {
    const row = {
      state: 'error', activeHost: '', activeId: '', preferredId: '', upstreams: [], error: error.message,
    };
    runtimeState.rpcReadByChain[String(id)] = row;
    runtimeState.rpcByChain[String(id)] = row;
  } finally {
    if (runtimeState.rpcLoadingChainId === id) runtimeState.rpcLoadingChainId = null;
    if (render) renderRuntime();
  }
  return runtimeState.rpcByChain[String(id)];
}

export async function refreshRpcProfiles({ render = true } = {}) {
  try {
    const data = await api('/api/rpc-profiles');
    const previousProfiles = new Map((runtimeState.rpcProfiles || []).map((profile) => [profile.id, profile]));
    runtimeState.rpcProfiles = (data.profiles || []).map((profile) => ({
      ...profile,
      chainId: profile.chainId ?? previousProfiles.get(profile.id)?.chainId ?? null,
      lastTest: profile.lastTest || previousProfiles.get(profile.id)?.lastTest || null,
    }));
    const selected = writeProfileId(runtimeState);
    if (selected !== runtimeState.writeProfileId) {
      runtimeState.writeProfileId = selected;
      localStorage.setItem(WRITE_RPC_PROFILE_KEY, selected);
    }
    const selectedProfile = runtimeState.rpcProfiles.find((profile) => profile.id === selected);
    if (selectedProfile?.chainId) {
      syncWriteChain(runtimeState, selectedProfile.chainId);
    }
    if (selected !== 'custom') {
      runtimeState.writeProfileRef = '';
      localStorage.removeItem(WRITE_RPC_PROFILE_REF_KEY);
    }
  } catch (error) {
    toast(error.message || 'RPC profile 加载失败', 'error');
  } finally {
    if (render) renderRuntime();
  }
  return runtimeState.rpcProfiles;
}

let activeRenderer = null;
let writeProfileSwitchSequence = 0;

function focusedControlSnapshot(root) {
  const active = globalThis.document?.activeElement;
  if (!root || !active || !root.contains?.(active)) return null;
  const tagName = String(active.tagName || '').toLowerCase();
  if (!['input', 'textarea', 'select'].includes(tagName)) return null;
  return {
    id: String(active.id || ''),
    name: String(active.getAttribute?.('name') || ''),
    type: String(active.getAttribute?.('type') || '').toLowerCase(),
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    selectionDirection: active.selectionDirection || 'none',
  };
}

function restoreFocusedControl(root, snapshot) {
  if (!root || !snapshot) return;
  const controls = [...(root.querySelectorAll?.('input, textarea, select') || [])];
  const control = (snapshot.id && controls.find((item) => item.id === snapshot.id))
    || controls.find((item) => item.getAttribute?.('name') === snapshot.name && String(item.getAttribute?.('type') || '').toLowerCase() === snapshot.type);
  if (!control) return;
  try { control.focus({ preventScroll: true }); } catch { control.focus(); }
  if (snapshot.selectionStart === null || typeof control.setSelectionRange !== 'function') return;
  const valueLength = String(control.value || '').length;
  const start = Math.min(snapshot.selectionStart, valueLength);
  const end = Math.min(snapshot.selectionEnd ?? start, valueLength);
  try { control.setSelectionRange(start, end, snapshot.selectionDirection); } catch { /* Select elements do not expose text ranges. */ }
}

export function renderRuntime() {
  const app = document.querySelector('#app');
  if (!activeRenderer) return;
  if (runtimeState.bootError) {
    app.innerHTML = `<div class="fatal-state"><strong>钱包数据加载失败</strong><span>${escapeHtml(runtimeState.bootError)}</span><button class="button primary" id="runtime-retry">重试</button></div>`;
    app.querySelector('#runtime-retry').addEventListener('click', () => bootData());
    return;
  }
  const focused = focusedControlSnapshot(app);
  const meta = routeMeta[runtimeState.routeName] || { title: '未知模块', section: 'NFT TOOL' };
  const context = {
    state: runtimeState,
    api,
    render: renderRuntime,
    runAction,
    toast,
    openDialog,
  };
  const view = activeRenderer(context) || { html: '' };
  app.innerHTML = `
    <div class="runtime-shell" data-route="${escapeHtml(runtimeState.routeName)}">
      <header class="runtime-header">
        <div><span>${escapeHtml(meta.section)}</span><h1>${escapeHtml(meta.title)}</h1></div>
        <div class="runtime-metrics"><span>钱包 <strong>${runtimeState.wallets.length}</strong></span><span>已选 <strong>${selectedIds().length}</strong></span></div>
      </header>
      <div class="runtime-content">${view.html}</div>
    </div>
  `;
  app.querySelectorAll('.rpc-profile-radio').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (runtimeState.rpcProfileSwitching || runtimeState.rpcProfileTesting) {
        renderRuntime();
        return;
      }
      const switchSequence = ++writeProfileSwitchSequence;
      const profileId = radio.value;
      const previous = {
        profileId: writeProfileId(runtimeState),
        chainId: runtimeState.chainId,
        transactionChainId: runtimeState.transactionChainId,
        profileRef: runtimeState.writeProfileRef,
      };
      runtimeState.writeProfileId = profileId;
      localStorage.setItem(WRITE_RPC_PROFILE_KEY, profileId);
      const selectedProfile = writeProfiles(runtimeState).find((profile) => profile.id === profileId);
      const chainId = Number(selectedProfile?.chainId || runtimeState.transactionChainId || runtimeState.chainId || 1);
      runtimeState.writeProfileRef = '';
      localStorage.removeItem(WRITE_RPC_PROFILE_REF_KEY);
      invalidateWritePreviews(runtimeState);
      runtimeState.rpcProfileSwitching = true;
      renderRuntime();
      try {
        if (profileId === 'custom') return;
        const result = await runAction(() => api('/api/rpc-profiles/select', {
          method: 'POST',
          body: JSON.stringify({ chainId, profileId }),
        }), { success: `写入 profile 已选择：${profileId}`, rerender: false });
        if (switchSequence !== writeProfileSwitchSequence) return;
        if (!result?.profile) {
          runtimeState.writeProfileId = previous.profileId;
          runtimeState.chainId = previous.chainId;
          runtimeState.transactionChainId = previous.transactionChainId;
          runtimeState.writeProfileRef = previous.profileRef;
          localStorage.setItem(WRITE_RPC_PROFILE_KEY, previous.profileId);
          localStorage.setItem(ACTIVE_CHAIN_KEY, String(previous.chainId));
          localStorage.setItem(WRITE_CHAIN_KEY, String(previous.transactionChainId));
          if (previous.profileRef) localStorage.setItem(WRITE_RPC_PROFILE_REF_KEY, previous.profileRef);
          return;
        }
        const resolvedChainId = Number(result.chainId || result.profile.chainId || chainId);
        if (syncWriteChain(runtimeState, resolvedChainId)) await refreshRpcStatus(resolvedChainId, { render: false });
        await refreshRpcProfiles({ render: false });
      } finally {
        runtimeState.rpcProfileSwitching = false;
        renderRuntime();
      }
    });
  });
  app.querySelectorAll('.rpc-profile-test').forEach((button) => {
    button.addEventListener('click', () => void runAction(async () => {
      const profileId = writeProfileId(runtimeState);
      const chainId = writeChainId(runtimeState);
      const endpoints = profileId === 'custom' ? customRpcEndpoints(runtimeState) : undefined;
      runtimeState.rpcProfileTesting = profileId;
      renderRuntime();
      try {
        const profileRef = writeProfileRef(runtimeState);
        const request = { profileId, profileRef, ...(endpoints ? { endpoints } : {}) };
        // A fresh custom endpoint has no known chain yet; the server infers it
        // from eth_chainId before freezing the short-lived profileRef.
        if (profileId !== 'custom' || profileRef) request.chainId = chainId;
        const result = await api('/api/rpc-profiles/test', { method: 'POST', body: JSON.stringify(request) });
        if (profileId === 'custom' && result.test?.profileRef) {
          runtimeState.writeProfileRef = result.test.profileRef;
          localStorage.setItem(WRITE_RPC_PROFILE_REF_KEY, result.test.profileRef);
        }
        if (result.test?.chainId) {
          const testedChainId = syncWriteChain(runtimeState, result.test.chainId);
          if (testedChainId) await refreshRpcStatus(testedChainId, { render: false });
        }
        runtimeState.rpcProfiles = runtimeState.rpcProfiles.map((profile) => profile.id === profileId ? { ...profile, chainId: result.test?.chainId || profile.chainId || null, lastTest: result.test } : profile);
        return result;
      } finally {
        runtimeState.rpcProfileTesting = '';
        await refreshRpcProfiles({ render: false });
        renderRuntime();
      }
    }, { success: 'RPC profile 测试完成', rerender: false }));
  });
  app.querySelectorAll('.custom-rpc-input').forEach((input) => {
    input.addEventListener('input', () => {
      runtimeState.customRpcEndpoints = input.value;
      localStorage.setItem(CUSTOM_RPC_ENDPOINTS_KEY, input.value);
      runtimeState.writeProfileRef = '';
      localStorage.removeItem(WRITE_RPC_PROFILE_REF_KEY);
      invalidateWritePreviews(runtimeState);
    });
  });
  view.bind?.(app, context);
  restoreFocusedControl(app, focused);
}

async function bootData() {
  runtimeState.bootError = '';
  document.querySelector('#app').innerHTML = '<div class="boot-state"><span class="spinner" aria-hidden="true"></span><span>正在读取钱包数据</span></div>';
  try {
    await refreshRuntimeData();
  } catch (error) {
    runtimeState.bootError = error.message;
  }
  renderRuntime();
}

export function bootRuntime({ routeName, renderPage }) {
  runtimeState.routeName = routeName;
  activeRenderer = renderPage;
  void bootData();
}
