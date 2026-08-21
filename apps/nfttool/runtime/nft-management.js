import {
  api,
  confirmationBody,
  escapeHtml,
  networkBar,
  runAction,
  shortAddress,
  writeChain,
  writeChainId,
  writeProfileId,
  writeProfileRef,
  toast,
} from './core.js';
import {
  bindWalletTable,
  selectedWalletSet,
  statusClass,
  statusLabel,
  walletGroupBar,
  walletTable,
} from './components.js';

const MARKET_SHORT = { opensea: 'OS', x2y2: 'X2', blur: 'Blur' };
// Previews and holdings queries move no funds, so a timeout there is a free retry.
const PREVIEW_TIMEOUT_MS = 60_000;

function clearTokenPrices(form) {
  if (!form.prices) return;
  for (const marketplaceId of Object.keys(form.prices)) form.prices[marketplaceId] = {};
  form.amounts = {};
}

function clearForChain(form, state) {
  const chainId = writeChainId(state);
  if (Number(form.chainId) === chainId) return;
  Object.assign(form, {
    chainId,
    snapshot: null,
    holdingIds: new Set(),
    plan: null,
    jobs: [],
    approvalPlans: [],
    catalog: [],
    catalogLoaded: false,
    catalogLoading: false,
  });
  clearTokenPrices(form);
}

function startCatalog(form, state, render) {
  if (form.catalogLoaded || form.catalogLoading) return;
  form.catalogLoading = true;
  api(`/api/nft-marketplaces?chainId=${Number(writeChainId(state))}`)
    .then((result) => {
      form.catalog = result.marketplaces || [];
      const supported = form.catalog.filter((item) => item.supported);
      const supportedIds = new Set(supported.map((item) => item.id));
      if (!supported.length) {
        form.catalogError = form.catalog.find((item) => item.chainSupported)?.unavailableReason || '当前链没有可用挂单平台';
      }
      if (form.marketplaces instanceof Set) {
        form.marketplaces = new Set([...form.marketplaces].filter((id) => supportedIds.has(id)));
        if (!form.marketplaces.size && supported[0]) form.marketplaces.add(supported[0].id);
      }
      if (form.marketplace && !supportedIds.has(form.marketplace)) form.marketplace = supported[0]?.id || '';
      form.catalogLoaded = true;
    })
    .catch((error) => { form.catalogError = error.message; form.catalogLoaded = true; })
    .finally(() => { form.catalogLoading = false; render(); });
}

function supportedMarkets(form) {
  const standard = form.snapshot?.holdings?.standard;
  return (form.catalog || []).filter((item) => item.supported && (!standard || item.operators?.[standard]));
}

function walletName(state, id) {
  const wallet = state.wallets.find((item) => item.id === id);
  return wallet?.label || wallet?.id || id;
}

function selectedHoldingRows(form) {
  return (form.snapshot?.holdings?.rows || []).filter((row) => form.holdingIds.has(row.id));
}

function bindHoldingChecks(root, form, render) {
  root.querySelectorAll('[data-holding-check]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) form.holdingIds.add(input.value);
    else form.holdingIds.delete(input.value);
    form.plan = null;
    form.jobs = [];
    form.approvalPlans = [];
    render();
  }));
  root.querySelector('[data-holding-all]')?.addEventListener('change', (event) => {
    form.holdingIds.clear();
    if (event.target.checked) (form.snapshot?.holdings?.rows || []).forEach((row) => form.holdingIds.add(row.id));
    form.plan = null;
    form.jobs = [];
    form.approvalPlans = [];
    render();
  });
}

async function queryHoldings(form, state, render, { selectAll = false } = {}) {
  const result = await api('/api/token-holdings/query', {
    method: 'POST',
    timeoutMs: PREVIEW_TIMEOUT_MS,
    body: JSON.stringify({
      chainId: writeChainId(state),
      walletIds: [...form.walletIds],
      contractAddress: form.contractAddress,
      includeMetadata: true,
    }),
  });
  if (!['ERC721', 'ERC1155'].includes(result.holdings?.standard)) throw new Error('该页面只接受 ERC721 或 ERC1155 NFT 合约');
  form.snapshot = result;
  form.holdingIds = new Set(selectAll ? result.holdings.rows.map((row) => row.id) : []);
  clearTokenPrices(form);
  form.plan = null;
  form.jobs = [];
  form.approvalPlans = [];
  render();
  return result;
}

function holdingTable(form, state, { destination = false } = {}) {
  const holdings = form.snapshot?.holdings;
  const rows = holdings?.rows || [];
  const allChecked = rows.length > 0 && rows.every((row) => form.holdingIds.has(row.id));
  return `
    <div class="holding-summary">
      <span>标准<strong>${escapeHtml(holdings?.standard || '-')}</strong></span>
      <span>NFT 数量<strong>${escapeHtml(holdings?.totalFormatted ?? '-')}</strong></span>
      <span>已选持仓<strong>${form.holdingIds.size}</strong></span>
      ${holdings?.metadataPending ? `<span>元数据未完成<strong>${escapeHtml(holdings.metadataPending)}</strong></span>` : ''}
    </div>
    <div class="table-scroll nft-holding-table">
      <table>
        <thead><tr><th class="check-cell"><input data-holding-all type="checkbox" ${allChecked ? 'checked' : ''} aria-label="全选 NFT"></th><th>钱包</th><th>地址</th><th>Token ID</th><th>数量</th><th>名称</th>${destination ? '<th>接收地址</th>' : ''}</tr></thead>
        <tbody>${rows.map((row) => `<tr><td class="check-cell"><input data-holding-check type="checkbox" value="${escapeHtml(row.id)}" ${form.holdingIds.has(row.id) ? 'checked' : ''} aria-label="选择 Token ${escapeHtml(row.tokenId)}"></td><td>${escapeHtml(walletName(state, row.walletId))}</td><td class="mono" title="${escapeHtml(row.address)}">${escapeHtml(shortAddress(row.address))}</td><td class="mono">#${escapeHtml(row.tokenId)}</td><td>${escapeHtml(row.count)}</td><td>${escapeHtml(row.metadata?.tokenName || `${holdings?.symbol || 'NFT'} #${row.tokenId}`)}</td>${destination ? `<td class="mono">${escapeHtml(shortAddress(form.destination))}</td>` : ''}</tr>`).join('') || '<tr><td colspan="7" class="empty-cell">查询后显示真实 NFT 持仓</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function listingBadge(row) {
  const listing = row.listing;
  if (!listing) return '';
  const price = `${escapeHtml(formatEth(listing.priceWei))} ${escapeHtml(listing.currency || 'ETH')}`;
  const expiry = Number(listing.endTime) * 1000;
  const expired = Number.isFinite(expiry) && expiry > 0 && expiry < Date.now();
  const title = expiry > 0 ? `有效至 ${new Date(expiry).toLocaleString('zh-CN')}` : '';
  return `<span class="nft-listed ${expired ? 'danger-text' : 'success-text'}" title="${escapeHtml(title)}">${expired ? '挂单已过期' : '已挂单'} ${price}</span>`;
}

function mediaCard(row, form, state) {
  const markets = supportedMarkets(form).filter((market) => form.marketplaces.has(market.id));
  const metadata = row.metadata || {};
  const fallback = `${form.snapshot?.holdings?.symbol || 'NFT'} #${row.tokenId}`;
  return `
    <article class="nft-item ${form.holdingIds.has(row.id) ? 'selected' : ''} ${row.listing ? 'is-listed' : ''}">
      <label class="nft-select"><input data-holding-check type="checkbox" value="${escapeHtml(row.id)}" ${form.holdingIds.has(row.id) ? 'checked' : ''} aria-label="选择 ${escapeHtml(fallback)}"></label>
      <div class="nft-media">
        <span>无图</span>
        ${metadata.imageUrl ? `<img src="${escapeHtml(metadata.imageUrl)}" alt="${escapeHtml(metadata.tokenName || fallback)}" loading="lazy">` : ''}
      </div>
      <div class="nft-item-copy"><strong title="${escapeHtml(metadata.tokenName || fallback)}">${escapeHtml(metadata.tokenName || fallback)}</strong><span>${escapeHtml(walletName(state, row.walletId))} · ${escapeHtml(shortAddress(row.address))}</span><span>Token ID #${escapeHtml(row.tokenId)}${row.standard === 'ERC1155' ? ` · 持有 ${escapeHtml(row.count)}` : ''}</span>${listingBadge(row)}</div>
      <div class="nft-price-fields">${markets.map((market) => `<label><span>${escapeHtml(MARKET_SHORT[market.id] || market.label)}</span><input data-token-price="${escapeHtml(row.id)}" data-market="${escapeHtml(market.id)}" value="${escapeHtml(form.prices[market.id]?.[row.id] || '')}" inputmode="decimal" placeholder="价格"></label>`).join('') || '<span class="nft-no-market">请选择挂单平台</span>'}</div>
    </article>
  `;
}

function parseEth(value, label) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error(`${label}格式无效`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
}

function formatEth(value) {
  const amount = BigInt(value);
  const whole = amount / 10n ** 18n;
  const fraction = String(amount % 10n ** 18n).padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function sortedRows(form) {
  const rows = [...(form.snapshot?.holdings?.rows || [])];
  if (form.sort === 'wallet') return rows.sort((a, b) => a.walletId.localeCompare(b.walletId, 'zh-CN', { numeric: true }) || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
  if (form.sort === 'token-desc') return rows.sort((a, b) => BigInt(a.tokenId) > BigInt(b.tokenId) ? -1 : BigInt(a.tokenId) < BigInt(b.tokenId) ? 1 : 0);
  return rows.sort((a, b) => BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : BigInt(a.tokenId) > BigInt(b.tokenId) ? 1 : 0);
}

function applyPriceRule(form, marketplaceId) {
  const rows = sortedRows(form).filter((row) => form.holdingIds.has(row.id));
  if (!rows.length) throw new Error('请先选择要设置价格的 NFT');
  const settings = form.pricing[marketplaceId];
  const output = form.prices[marketplaceId] ||= {};
  if (form.priceMode === 'same') {
    const amount = parseEth(settings.same, '相同价格');
    if (amount <= 0n) throw new Error('相同价格必须大于 0');
    const value = formatEth(amount);
    rows.forEach((row) => { output[row.id] = value; });
    return;
  }
  if (form.priceMode === 'ladder') {
    const start = parseEth(settings.start, '阶梯起始价格');
    if (start <= 0n) throw new Error('阶梯起始价格必须大于 0');
    const every = Number(settings.every);
    const rate = Number(settings.rate);
    if (!Number.isInteger(every) || every < 1) throw new Error('阶梯间隔必须是正整数');
    if (!Number.isFinite(rate) || rate < -100 || rate > 10000) throw new Error('阶梯递增比例无效');
    const rateBps = BigInt(Math.round(rate * 100));
    rows.forEach((row, index) => {
      const step = BigInt(Math.floor(index / every));
      const multiplier = 10000n + step * rateBps;
      if (multiplier <= 0n) throw new Error('阶梯价格计算结果必须大于 0');
      output[row.id] = formatEth(start * multiplier / 10000n);
    });
    return;
  }
  const start = parseEth(settings.start, '区间起始价格');
  const end = parseEth(settings.end, '区间结束价格');
  rows.forEach((row, index) => {
    const value = rows.length === 1 ? start : start + (end - start) * BigInt(index) / BigInt(rows.length - 1);
    if (value <= 0n) throw new Error('区间价格必须大于 0');
    output[row.id] = formatEth(value);
  });
}

function pricingControls(form) {
  const markets = supportedMarkets(form).filter((market) => form.marketplaces.has(market.id));
  return `
    <section class="pricing-panel">
      <div class="pricing-tabs">${[['same', '相同价格'], ['ladder', '阶梯挂单'], ['range', '区间挂单']].map(([id, label]) => `<button data-price-mode="${id}" class="${form.priceMode === id ? 'active' : ''}" type="button">${label}</button>`).join('')}</div>
      ${markets.map((market) => {
        const values = form.pricing[market.id];
        return `<div class="pricing-row"><strong>${escapeHtml(MARKET_SHORT[market.id] || market.label)}</strong>${form.priceMode === 'same'
          ? `<input data-pricing="same" data-market="${market.id}" value="${escapeHtml(values.same)}" inputmode="decimal" aria-label="${escapeHtml(market.label)} 相同价格">`
          : form.priceMode === 'ladder'
            ? `<input data-pricing="start" data-market="${market.id}" value="${escapeHtml(values.start)}" inputmode="decimal" aria-label="${escapeHtml(market.label)} 起始价格"><input data-pricing="every" data-market="${market.id}" value="${escapeHtml(values.every)}" inputmode="numeric" placeholder="间隔数" aria-label="间隔数"><input data-pricing="rate" data-market="${market.id}" value="${escapeHtml(values.rate)}" inputmode="decimal" placeholder="递增%" aria-label="递增比例">`
            : `<input data-pricing="start" data-market="${market.id}" value="${escapeHtml(values.start)}" inputmode="decimal" aria-label="${escapeHtml(market.label)} 区间起点"><input data-pricing="end" data-market="${market.id}" value="${escapeHtml(values.end)}" inputmode="decimal" aria-label="${escapeHtml(market.label)} 区间终点">`}
          <button class="button primary apply-price" data-market="${market.id}" type="button">设置</button></div>`;
      }).join('') || '<div class="empty-state compact">选择挂单平台后设置价格</div>'}
    </section>
  `;
}

function listingProceeds(job) {
  const rows = job.summary?.proceeds;
  if (!Array.isArray(rows) || !rows.length) return '';
  const total = rows.reduce((sum, row) => sum + BigInt(row.price || 0), 0n);
  const seller = rows.reduce((sum, row) => sum + BigInt(row.seller || 0), 0n);
  const skipped = rows.reduce((sum, row) => sum + (row.skippedOptionalFees || []).reduce((inner, fee) => inner + BigInt(fee.amount || 0), 0n), 0n);
  const cut = total - seller;
  return `<span title="挂单总额 ${formatEth(total)}，扣除 ${formatEth(cut)} 平台与版税费用">实收 ${escapeHtml(formatEth(seller))} / ${escapeHtml(formatEth(total))}</span>${skipped > 0n ? `<span class="success-text" title="该合集版税为可选，已跳过">省下可选版税 ${escapeHtml(formatEth(skipped))}</span>` : ''}`;
}

function listingJobs(jobs) {
  if (!jobs.length) return '<div class="empty-state">尚未生成真实挂单预览</div>';
  return `<div class="listing-jobs">${jobs.map((job) => `<div><span class="status ${statusClass(job.status)}">${escapeHtml(statusLabel(job.status))}</span><strong>${escapeHtml(job.marketplace?.label || '-')}</strong><span>${job.rows?.length || 0} 个 NFT</span><span>${job.summary?.signatureCount || 0} 个签名</span>${listingProceeds(job)}<span class="${job.summary?.requiresApproval ? 'danger-text' : 'success-text'}">${job.summary?.requiresApproval ? `需要 ${job.summary.transactionCount} 笔授权` : '可提交'}</span>${job.error ? `<small>${escapeHtml(job.error)}</small>` : ''}</div>`).join('')}</div>`;
}

function approvalPlans(plans) {
  if (!plans.length) return '';
  return `<section class="approval-strip">${plans.map((plan) => `<span><strong>${escapeHtml(plan.marketplace?.label || '-')}</strong> ${plan.entries?.length ? `${plan.entries.length} 笔待授权` : '授权状态已满足'}</span>`).join('')}</section>`;
}

function durationSeconds(form) {
  const value = Number(form.durationValue);
  const multiplier = { minutes: 60, hours: 3600, days: 86400 }[form.durationUnit];
  if (!Number.isFinite(value) || value <= 0 || !multiplier) throw new Error('挂单有效期无效');
  return Math.round(value * multiplier);
}

// Every marketplace preview is an independent call to an external router, so they run
// together and each one keeps its own failure reason instead of aborting the batch.
export async function previewListings(form, markets, request = api) {
  const duration = durationSeconds(form);
  const results = await Promise.allSettled(markets.map((market) => request('/api/nft-listings/preview', {
    method: 'POST',
    timeoutMs: PREVIEW_TIMEOUT_MS,
    body: JSON.stringify({
      snapshotId: form.snapshot.snapshotId,
      holdingIds: [...form.holdingIds],
      marketplace: market.id,
      prices: form.prices[market.id],
      amounts: form.amounts,
      durationSeconds: duration,
    }),
  })));
  const jobs = results.map((result, index) => (result.status === 'fulfilled'
    ? result.value.job
    : {
      id: `${markets[index].id}:failed`,
      status: 'failed',
      marketplace: markets[index],
      rows: [],
      summary: null,
      error: result.reason?.message || '挂单预览失败',
    }));
  return { jobs, failures: results.filter((result) => result.status === 'rejected') };
}

export function readyListingJobs(jobs) {
  return (jobs || []).filter((job) => job.status === 'previewed' && job.summary?.ready && job.confirmation);
}

function blockedReason(jobs) {
  const approval = jobs.find((job) => job.summary?.requiresApproval);
  if (approval) return `${approval.marketplace?.label || '平台'}：存在未授权的钱包，请先点「检查授权」与「执行授权」`;
  const failed = jobs.find((job) => job.error);
  if (failed) return failed.error;
  return '挂单预览没有产生可提交的订单';
}

// Preview is a convenience, not a gate: the server still binds every submission to a
// previewId + confirmationToken, so listing directly just means generating that pair here
// instead of making the operator click twice. Existing previews are reused as-is.
export async function submitListings(form, markets, request = api) {
  let jobs = readyListingJobs(form.jobs);
  if (!jobs.length) {
    const preview = await previewListings(form, markets, request);
    form.jobs = preview.jobs;
    jobs = readyListingJobs(preview.jobs);
    if (!jobs.length) throw new Error(blockedReason(preview.jobs));
  }
  const submitted = [];
  for (const job of jobs) {
    const result = await request('/api/nft-listings/submit', {
      method: 'POST',
      body: JSON.stringify({ previewId: job.confirmation.previewId, confirmationToken: job.confirmation.confirmationToken }),
    });
    const index = form.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) form.jobs[index] = result.job;
    submitted.push(result.job);
  }
  return submitted;
}

function freshSellForm(state) {
  const pricing = {};
  const prices = {};
  for (const id of Object.keys(MARKET_SHORT)) {
    pricing[id] = { same: '0.01', start: '0.01', every: '1', rate: '5', end: '0.02' };
    prices[id] = {};
  }
  return {
    chainId: writeChainId(state),
    walletIds: selectedWalletSet(state),
    contractAddress: '',
    snapshot: null,
    holdingIds: new Set(),
    marketplaces: new Set(['opensea']),
    catalog: [],
    catalogLoaded: false,
    catalogLoading: false,
    catalogError: '',
    priceMode: 'same',
    pricing,
    prices,
    amounts: {},
    durationValue: '15',
    durationUnit: 'minutes',
    sort: 'token-asc',
    jobs: [],
    approvalPlans: [],
  };
}

export function renderBatchSell({ state, render }) {
  const form = state.page.batchSell ||= freshSellForm(state);
  clearForChain(form, state);
  const chain = writeChain(state);
  const rows = sortedRows(form);
  const selectedMarkets = supportedMarkets(form).filter((market) => form.marketplaces.has(market.id));
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}
      <div class="nft-query-layout">
        <section class="data-panel nft-wallet-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'sell')}${walletTable(state, form.walletIds, { inputName: 'sellWallet', compact: true })}</section>
        <section class="form-panel nft-query-panel"><header><h2>NFT 查询</h2><span>${escapeHtml(chain.name)}</span></header><label class="field"><span>NFT Token 合约</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="0x..." spellcheck="false"></label><button class="button primary query-nfts" id="query-sell" type="button">批量查询</button>${form.snapshot ? `<div class="query-result"><strong>${escapeHtml(form.snapshot.holdings.symbol || form.snapshot.holdings.standard)}</strong><span>${form.snapshot.holdings.rows.length} 条持仓 · ${escapeHtml(form.snapshot.holdings.totalFormatted)} 枚</span><span>${form.snapshot.holdings.coverageComplete ? '持仓覆盖完整' : '合约枚举覆盖有限'}</span></div>` : ''}</section>
      </div>
      <div class="sell-settings">
        ${pricingControls(form)}
        <section class="listing-options">
          <label class="compact-field"><span>相同有效期</span><input name="durationValue" value="${escapeHtml(form.durationValue)}" inputmode="decimal"><select name="durationUnit"><option value="minutes" ${form.durationUnit === 'minutes' ? 'selected' : ''}>分钟</option><option value="hours" ${form.durationUnit === 'hours' ? 'selected' : ''}>小时</option><option value="days" ${form.durationUnit === 'days' ? 'selected' : ''}>天</option></select></label>
          <div class="segmented"><button class="active" type="button">List</button><button type="button" disabled title="当前恢复范围为 NFT 挂单">Bid</button></div>
          <div class="market-checks">${supportedMarkets(form).map((market) => `<label class="toggle"><input data-market-check type="checkbox" value="${escapeHtml(market.id)}" ${form.marketplaces.has(market.id) ? 'checked' : ''}><span>${escapeHtml(market.label)}</span></label>`).join('') || `<span>${form.catalogLoading ? '正在读取平台配置' : escapeHtml(form.catalogError || '当前链没有可用挂单平台')}</span>`}</div>
          <div class="listing-actions"><button class="button secondary" id="preview-sell-approval" type="button" ${selectedMarkets.length && form.holdingIds.size ? '' : 'disabled'}>检查授权</button><button class="button primary" id="execute-sell-approval" type="button" ${form.approvalPlans.some((plan) => plan.entries?.length) ? '' : 'disabled'}>执行授权</button></div>
        </section>
      </div>
      ${approvalPlans(form.approvalPlans)}
      <div class="nft-list-toolbar"><label class="compact-field"><span>排序</span><select name="sort"><option value="token-asc" ${form.sort === 'token-asc' ? 'selected' : ''}>Token ID 升序</option><option value="token-desc" ${form.sort === 'token-desc' ? 'selected' : ''}>Token ID 降序</option><option value="wallet" ${form.sort === 'wallet' ? 'selected' : ''}>按账号</option></select></label><span>${form.holdingIds.size} / ${rows.length}</span>${form.snapshot?.holdings?.listedCount ? `<span class="success-text">${escapeHtml(form.snapshot.holdings.listedCount)} 个已挂单</span>` : ''}${form.snapshot?.holdings?.metadataPending ? `<span>${escapeHtml(form.snapshot.holdings.metadataPending)} 个元数据仍在加载，可重新查询</span>` : ''}<label class="toggle select-all-nfts"><input data-holding-all type="checkbox" ${rows.length && rows.every((row) => form.holdingIds.has(row.id)) ? 'checked' : ''}><span>全选</span></label><div class="toolbar-spacer"></div><button class="button secondary" id="preview-listings" type="button" ${form.holdingIds.size && selectedMarkets.length ? '' : 'disabled'}>生成挂单预览</button><button class="button primary" id="submit-listings" type="button" ${form.holdingIds.size && selectedMarkets.length ? '' : 'disabled'}>执行挂单</button></div>
      <section class="nft-grid" aria-label="NFT 持仓">${rows.map((row) => mediaCard(row, form, state)).join('') || '<div class="empty-state">选择账号并输入 NFT Token 合约后查询真实持仓</div>'}</section>
      <section class="preview-panel listing-preview"><header><h2>挂单任务</h2><span>${form.jobs.length} 个平台预览</span></header>${listingJobs(form.jobs)}</section>
    `,
    bind(root) {
      startCatalog(form, state, render);
      bindWalletTable(root, state, form.walletIds, { inputName: 'sellWallet', render, onChange: () => { form.snapshot = null; form.holdingIds.clear(); form.jobs = []; form.approvalPlans = []; } });
      bindHoldingChecks(root, form, render);
      root.querySelector('[name="contractAddress"]')?.addEventListener('input', (event) => { form.contractAddress = event.target.value; form.snapshot = null; form.holdingIds.clear(); form.jobs = []; form.approvalPlans = []; clearTokenPrices(form); });
      root.querySelector('#query-sell')?.addEventListener('click', () => void runAction(() => queryHoldings(form, state, render), { success: '真实 NFT 持仓已更新' }));
      root.querySelectorAll('[data-price-mode]').forEach((button) => button.addEventListener('click', () => { form.priceMode = button.dataset.priceMode; render(); }));
      root.querySelectorAll('[data-pricing]').forEach((input) => input.addEventListener('input', () => { form.pricing[input.dataset.market][input.dataset.pricing] = input.value; form.jobs = []; }));
      root.querySelectorAll('.apply-price').forEach((button) => button.addEventListener('click', () => {
        try { applyPriceRule(form, button.dataset.market); form.jobs = []; render(); toast('已为所选 NFT 设置价格'); } catch (error) { toast(error.message, 'error'); }
      }));
      root.querySelectorAll('[data-token-price]').forEach((input) => input.addEventListener('input', () => { form.prices[input.dataset.market][input.dataset.tokenPrice] = input.value; form.jobs = []; }));
      root.querySelectorAll('.nft-media img').forEach((image) => {
        image.addEventListener('load', () => image.classList.add('loaded'));
        image.addEventListener('error', () => image.remove());
        if (image.complete && image.naturalWidth > 0) image.classList.add('loaded');
      });
      root.querySelectorAll('[data-market-check]').forEach((input) => input.addEventListener('change', () => {
        if (input.checked) form.marketplaces.add(input.value); else form.marketplaces.delete(input.value);
        form.jobs = []; form.approvalPlans = []; render();
      }));
      root.querySelector('[name="durationValue"]')?.addEventListener('input', (event) => { form.durationValue = event.target.value; form.jobs = []; });
      root.querySelector('[name="durationUnit"]')?.addEventListener('change', (event) => { form.durationUnit = event.target.value; form.jobs = []; render(); });
      root.querySelector('[name="sort"]')?.addEventListener('change', (event) => { form.sort = event.target.value; render(); });
      root.querySelector('#preview-sell-approval')?.addEventListener('click', () => void runAction(async () => {
        const walletIds = [...new Set(selectedHoldingRows(form).map((row) => row.walletId))];
        form.approvalPlans = await Promise.all(selectedMarkets.map((market) => api('/api/plan/nft-approval', { method: 'POST', timeoutMs: PREVIEW_TIMEOUT_MS, body: JSON.stringify({ chainId: writeChainId(state), rpcProfileId: writeProfileId(state), rpcProfileRef: writeProfileRef(state), walletIds, snapshotId: form.snapshot.snapshotId, contractAddress: form.contractAddress, marketplace: market.id, approved: true, holdingsOnly: true, preflight: true }) })));
        return form.approvalPlans;
      }, { success: '链上授权状态已检查' }));
      root.querySelector('#execute-sell-approval')?.addEventListener('click', () => {
        const plans = form.approvalPlans.filter((plan) => plan.entries?.length && plan.confirmation);
        if (!plans.length || !window.confirm(`确认发送 ${plans.reduce((sum, plan) => sum + plan.entries.length, 0)} 笔 NFT 授权交易？`)) return;
        void runAction(async () => {
          const results = [];
          for (const plan of plans) results.push(await api('/api/tasks/nft-approval', { method: 'POST', body: JSON.stringify(confirmationBody(plan)) }));
          form.approvalPlans = [];
          form.jobs = [];
          return results;
        }, { success: 'NFT 授权任务已提交' });
      });
      root.querySelector('#preview-listings')?.addEventListener('click', () => void runAction(async () => {
        const { jobs, failures } = await previewListings(form, selectedMarkets);
        form.jobs = jobs;
        if (!failures.length) toast('真实挂单预览已生成');
        else if (failures.length === jobs.length) toast(failures[0].reason?.message || '挂单预览失败', 'error');
        else toast(`${jobs.length - failures.length} 个平台预览成功，${failures.length} 个失败`, 'error');
        return jobs;
      }));
      root.querySelector('#submit-listings')?.addEventListener('click', () => {
        const ready = readyListingJobs(form.jobs);
        const count = ready.length ? ready.reduce((sum, job) => sum + job.rows.length, 0) : form.holdingIds.size * selectedMarkets.length;
        if (!count) return;
        const notice = ready.length ? '' : '\n（尚未预览，将自动生成预览后直接提交）';
        if (!window.confirm(`确认签名并提交 ${count} 个 NFT 挂单？${notice}`)) return;
        void runAction(() => submitListings(form, selectedMarkets), { success: 'NFT 挂单已提交' });
      });
    },
  };
}

function freshCollectionForm(state) {
  return {
    chainId: writeChainId(state),
    walletIds: selectedWalletSet(state),
    contractAddress: '',
    destination: '',
    snapshot: null,
    holdingIds: new Set(),
    preflight: true,
    plan: null,
  };
}

export function renderNftCollection({ state, render }) {
  const form = state.page.collectionNFT ||= freshCollectionForm(state);
  clearForChain(form, state);
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}
      <div class="nft-collection-layout">
        <section class="data-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'nft-collect')}${walletTable(state, form.walletIds, { inputName: 'nftCollectWallet', compact: true })}</section>
        <section class="form-panel"><header><h2>NFT 归集参数</h2><span>接收地址不需要私钥</span></header><label class="field"><span>接收账号</span><input name="destination" value="${escapeHtml(form.destination)}" placeholder="0x..." spellcheck="false"></label><label class="field"><span>筛选合约</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="NFT Token 合约" spellcheck="false"></label><label class="toggle collection-preflight"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label><div class="form-actions"><button class="button primary" id="query-collection-nfts" type="button">查询</button><button class="button secondary" id="preview-nft-collection" type="button" ${form.holdingIds.size ? '' : 'disabled'}>生成预览</button><button class="button primary" id="execute-nft-collection" type="button" ${form.plan?.entries?.length ? '' : 'disabled'}>执行归集</button></div></section>
      </div>
      <section class="preview-panel"><header><h2>真实 NFT 持仓</h2><span>${form.snapshot?.expiresAt ? `快照有效至 ${escapeHtml(new Date(form.snapshot.expiresAt).toLocaleTimeString('zh-CN'))}` : ''}</span></header>${holdingTable(form, state, { destination: true })}</section>
      <section class="preview-panel"><header><h2>归集预览</h2><span>${form.plan?.entries?.length || 0} 笔交易</span></header>${form.plan ? `<div class="table-scroll compact-table"><table><thead><tr><th>#</th><th>钱包</th><th>摘要</th></tr></thead><tbody>${form.plan.entries.map((entry, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(entry.walletId)}</td><td>${escapeHtml(entry.summary)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">查询并选择持仓后生成归集预览</div>'}</section>
    `,
    bind(root) {
      bindWalletTable(root, state, form.walletIds, { inputName: 'nftCollectWallet', render, onChange: () => { form.snapshot = null; form.holdingIds.clear(); form.plan = null; } });
      bindHoldingChecks(root, form, render);
      for (const name of ['destination', 'contractAddress']) root.querySelector(`[name="${name}"]`)?.addEventListener('input', (event) => { form[name] = event.target.value; form.plan = null; if (name === 'contractAddress') { form.snapshot = null; form.holdingIds.clear(); } });
      root.querySelector('[name="preflight"]')?.addEventListener('change', (event) => { form.preflight = event.target.checked; form.plan = null; });
      root.querySelector('#query-collection-nfts')?.addEventListener('click', () => void runAction(() => queryHoldings(form, state, render, { selectAll: true }), { success: '真实 NFT 持仓已更新' }));
      root.querySelector('#preview-nft-collection')?.addEventListener('click', () => void runAction(async () => {
        form.plan = await api('/api/plan/token-collect', { method: 'POST', body: JSON.stringify({ snapshotId: form.snapshot?.snapshotId, destination: form.destination, holdingIds: [...form.holdingIds], preflight: form.preflight, rpcProfileId: writeProfileId(state), rpcProfileRef: writeProfileRef(state) }) });
        return form.plan;
      }, { success: 'NFT 归集预览已生成' }));
      root.querySelector('#execute-nft-collection')?.addEventListener('click', () => {
        if (!form.plan?.confirmation || !window.confirm(`确认执行 ${form.plan.entries.length} 笔 NFT 归集交易？`)) return;
        void runAction(() => api('/api/tasks/token-collect', { method: 'POST', body: JSON.stringify(confirmationBody(form.plan)) }), { success: 'NFT 归集任务已提交' });
      });
    },
  };
}

function freshApproveForm(state) {
  return {
    chainId: writeChainId(state),
    walletIds: selectedWalletSet(state),
    contractAddress: '',
    marketplace: 'opensea',
    approved: true,
    preflight: true,
    plan: null,
    catalog: [],
    catalogLoaded: false,
    catalogLoading: false,
    catalogError: '',
  };
}

export function renderBatchApprove({ state, render }) {
  const form = state.page.batchApprove ||= freshApproveForm(state);
  clearForChain(form, state);
  const markets = supportedMarkets(form);
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}
      <div class="nft-approve-layout">
        <section class="data-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'nft-approve')}${walletTable(state, form.walletIds, { inputName: 'nftApproveWallet', compact: true })}</section>
        <section class="form-panel"><header><h2>批量授权</h2><span>无论当前是否持有 NFT 都会检查</span></header><label class="field"><span>NFT Token 合约</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="0x..." spellcheck="false"></label><label class="field"><span>挂单平台</span><select name="marketplace">${markets.map((market) => `<option value="${escapeHtml(market.id)}" ${form.marketplace === market.id ? 'selected' : ''}>${escapeHtml(market.label)}</option>`).join('')}</select></label><div class="approve-options"><label class="toggle"><input name="approved" type="checkbox" ${form.approved ? 'checked' : ''}><span>${form.approved ? '授权平台操作全部 NFT' : '撤销平台授权'}</span></label><label class="toggle"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label></div><div class="form-actions"><button class="button secondary" id="preview-nft-approve" type="button" ${form.walletIds.size && form.marketplace ? '' : 'disabled'}>检查并生成预览</button><button class="button ${form.approved ? 'primary' : 'danger'}" id="execute-nft-approve" type="button" ${form.plan?.entries?.length ? '' : 'disabled'}>${form.approved ? '执行授权' : '执行撤销'}</button></div>${form.catalogError ? `<div class="inline-alert">${escapeHtml(form.catalogError)}</div>` : ''}</section>
      </div>
      <section class="preview-panel"><header><h2>授权预览</h2><span>${form.plan ? `${escapeHtml(form.plan.standard)} · ${escapeHtml(form.plan.marketplace.label)}` : ''}</span></header>${form.plan ? `<div class="approval-address"><span>Operator</span><code>${escapeHtml(form.plan.marketplace.operator)}</code></div><div class="plan-summary"><div><span>已是目标状态</span><strong>${form.plan.rows.filter((row) => !row.changed).length}</strong></div><div><span>待发送交易</span><strong>${form.plan.entries.length}</strong></div><div><span>目标状态</span><strong>${form.plan.approved ? '授权' : '撤销'}</strong></div></div><div class="table-scroll compact-table"><table><thead><tr><th>钱包</th><th>当前状态</th><th>处理</th></tr></thead><tbody>${form.plan.rows.map((row) => `<tr><td>${escapeHtml(row.walletId)}</td><td>${row.current ? '已授权' : '未授权'}</td><td>${row.changed ? '将发送交易' : '跳过'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">填写 NFT 合约并检查真实链上授权状态</div>'}</section>
    `,
    bind(root) {
      startCatalog(form, state, render);
      bindWalletTable(root, state, form.walletIds, { inputName: 'nftApproveWallet', render, onChange: () => { form.plan = null; } });
      root.querySelector('[name="contractAddress"]')?.addEventListener('input', (event) => { form.contractAddress = event.target.value; form.plan = null; });
      root.querySelector('[name="marketplace"]')?.addEventListener('change', (event) => { form.marketplace = event.target.value; form.plan = null; render(); });
      root.querySelector('[name="approved"]')?.addEventListener('change', (event) => { form.approved = event.target.checked; form.plan = null; render(); });
      root.querySelector('[name="preflight"]')?.addEventListener('change', (event) => { form.preflight = event.target.checked; form.plan = null; });
      root.querySelector('#preview-nft-approve')?.addEventListener('click', () => void runAction(async () => {
        form.plan = await api('/api/plan/nft-approval', { method: 'POST', body: JSON.stringify({ chainId: writeChainId(state), rpcProfileId: writeProfileId(state), rpcProfileRef: writeProfileRef(state), walletIds: [...form.walletIds], contractAddress: form.contractAddress, marketplace: form.marketplace, approved: form.approved, preflight: form.preflight }) });
        return form.plan;
      }, { success: '链上 NFT 授权状态已检查' }));
      root.querySelector('#execute-nft-approve')?.addEventListener('click', () => {
        if (!form.plan?.confirmation || !window.confirm(`确认发送 ${form.plan.entries.length} 笔 NFT ${form.plan.approved ? '授权' : '撤销'}交易？`)) return;
        void runAction(async () => {
          const result = await api('/api/tasks/nft-approval', { method: 'POST', body: JSON.stringify(confirmationBody(form.plan)) });
          form.plan = null;
          return result;
        }, { success: 'NFT 授权任务已提交' });
      });
    },
  };
}
