import {
  api,
  confirmationBody,
  escapeHtml,
  nativeToWei,
  networkBar,
  renderPlan,
  renderTaskResult,
  runAction,
  selectedIds,
  shortAddress,
  toast,
  walletBalance,
  writeChain,
  writeChainId,
  writeProfileId,
  writeProfileRef,
} from './core.js';
import {
  bindWalletGroupBar,
  bindWalletGroupFilter,
  walletGroupBar,
  walletGroupFilterBar,
} from './components.js';
import { normalizeWalletGroup, UNGROUPED_LABEL } from './wallet-groups.js';


function pickerWallets(state, { exclude = new Set(), groupKey = null } = {}) {
  const excluded = new Set([...exclude].map(String));
  const seen = new Set();
  return state.wallets.filter((wallet) => {
    const id = String(wallet.id);
    if (!id || excluded.has(id) || seen.has(id)) return false;
    seen.add(id);
    return groupKey === null || normalizeWalletGroup(wallet.group) === groupKey;
  });
}

export function walletIdsInStateOrder(state, selected, exclude = new Set()) {
  const selectedIds = new Set([...selected].map(String));
  return pickerWallets(state, { exclude })
    .filter((wallet) => selectedIds.has(String(wallet.id)))
    .map((wallet) => String(wallet.id));
}

export function dispersePreviewBody(state, form) {
  return {
    chainId: writeChainId(state),
    rpcProfileId: writeProfileId(state),
    rpcProfileRef: writeProfileRef(state),
    fromId: form.fromId,
    targetIds: walletIdsInStateOrder(state, form.targetIds, new Set([form.fromId])),
    asset: form.asset,
    tokenAddress: form.tokenAddress,
    amountMode: form.amountMode,
    amount: form.amount,
    targetBalance: form.targetBalance,
    executionMode: form.executionMode,
    preflight: form.preflight,
  };
}

export function collectionPreviewRequest(state, form) {
  if (form.mode === 'token') {
    return {
      path: '/api/plan/token-collect',
      body: {
        snapshotId: form.snapshot?.snapshotId,
        destination: form.destination,
        holdingIds: [...form.holdingIds],
        preflight: form.preflight,
        rpcProfileId: writeProfileId(state),
        rpcProfileRef: writeProfileRef(state),
      },
    };
  }
  return {
    path: '/api/plan/many-to-one',
    body: {
      chainId: writeChainId(state),
      sourceIds: walletIdsInStateOrder(state, form.sourceIds, new Set([form.destinationWalletId])),
      destinationWalletId: form.destinationWalletId,
      reserveEth: form.reserveEth,
      gasMultiplier: form.gasMultiplier,
      preflight: form.preflight,
      rpcProfileId: writeProfileId(state),
      rpcProfileRef: writeProfileRef(state),
    },
  };
}

export function manyToManyPreviewBody(state, form) {
  return {
      chainId: writeChainId(state),
    senderIds: walletIdsInStateOrder(state, form.senderIds, form.receiverIds),
    receiverIds: walletIdsInStateOrder(state, form.receiverIds, form.senderIds),
    asset: form.asset,
    tokenAddress: form.tokenAddress,
    amount: form.amount,
    preflight: form.preflight,
    executionMode: form.executionMode,
    rpcProfileId: writeProfileId(state),
    rpcProfileRef: writeProfileRef(state),
  };
}

export function exchangePreviewRows(state, form) {
  const ids = new Set(walletIdsInStateOrder(state, form.walletIds));
  return pickerWallets(state).filter((wallet) => ids.has(String(wallet.id)));
}

export function walletPicker(state, {
  selected,
  name,
  radio = false,
  exclude = new Set(),
  balance = true,
  exchange = false,
  groupPrefix = name,
  groupKey = null,
}) {
  const chain = writeChain(state);
  const activeGroup = groupKey == null ? null : normalizeWalletGroup(groupKey);
  const wallets = pickerWallets(state, { exclude, groupKey: radio ? activeGroup : null });
  return `
    ${radio
      ? walletGroupFilterBar(state, activeGroup, groupPrefix, { exclude })
      : walletGroupBar(state, selected, groupPrefix, { exclude })}
    <div class="table-scroll picker-table">
      <table>
        <thead><tr><th></th><th>#</th><th>备注</th><th>地址</th><th>分组</th>${balance ? `<th>金额(${escapeHtml(chain.nativeSymbol)})</th>` : ''}${exchange ? '<th>交易所地址</th>' : ''}</tr></thead>
        <tbody>${wallets.map((wallet, index) => {
          const checked = radio ? selected === wallet.id : selected.has(wallet.id);
          const balanceRow = walletBalance(wallet, chain.id);
          return `
            <tr>
              <td class="check-cell"><input type="${radio ? 'radio' : 'checkbox'}" name="${escapeHtml(name)}" value="${escapeHtml(wallet.id)}" ${checked ? 'checked' : ''} aria-label="选择 ${escapeHtml(wallet.id)}"></td>
              <td>${index + 1}</td><td>${escapeHtml(wallet.label || wallet.id)}</td>
              <td class="mono" title="${escapeHtml(wallet.address)}">${escapeHtml(shortAddress(wallet.address))}</td>
              <td>${escapeHtml(normalizeWalletGroup(wallet.group) || UNGROUPED_LABEL)}</td>
              ${balance ? `<td class="number-cell">${balanceRow ? escapeHtml(balanceRow.formatted) : '-'}</td>` : ''}
              ${exchange ? `<td class="mono">${escapeHtml(wallet.exchangeAddress || '-')}</td>` : ''}
            </tr>
          `;
        }).join('') || `<tr><td colspan="${5 + Number(balance) + Number(exchange)}" class="empty-cell">没有可选钱包</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function bindPicker(root, {
  state,
  selector,
  selected,
  radio = false,
  exclude = new Set(),
  groupPrefix,
  onChange,
  onGroupFilter,
}) {
  root.querySelectorAll(selector).forEach((input) => {
    input.addEventListener('change', () => {
      if (radio) onChange(input.value);
      else {
        if (input.checked) selected.add(input.value);
        else selected.delete(input.value);
        onChange(selected);
      }
    });
  });
  if (radio) bindWalletGroupFilter(root, { prefix: groupPrefix, onChange: onGroupFilter });
  else bindWalletGroupBar(root, state, selected, { prefix: groupPrefix, exclude, onChange });
}

function bindTextFields(root, form, clearPlan, names) {
  for (const name of names) {
    root.querySelector(`[name="${name}"]`)?.addEventListener('input', (event) => {
      form[name] = event.target.value;
      clearPlan();
    });
  }
}

// Takes the form rather than the plan so the per-entry outcome can be kept and rendered:
// the server already reports every entry's fate, and discarding it left the operator to
// reconstruct a partial batch from a block explorer.
async function executePlan(taskPath, form, label) {
  const plan = form.plan;
  if (!plan) {
    toast('请先生成预览', 'error');
    return null;
  }
  const count = plan.entries?.length || 0;
  if (!window.confirm(`${label}？本次共 ${count} 笔交易。\n全部交易将并发广播，力争同一区块内完成。`)) return null;
  form.result = null;
  const result = await runAction(() => api(taskPath, {
    method: 'POST',
    body: JSON.stringify(confirmationBody(plan)),
  }), { success: '' });
  if (result) {
    form.result = result;
    const rows = Array.isArray(result.results) ? result.results : [];
    const sent = rows.filter((row) => row.ok).length;
    toast(sent === rows.length ? `${sent} 笔已全部广播` : `${rows.length} 笔中 ${sent} 笔广播成功，详情见执行结果`, sent === rows.length ? 'success' : 'error');
  }
  return result;
}

export function renderDisperse({ state, render }) {
  const defaults = selectedIds(state);
  const form = state.page.disperse ||= {
    fromId: defaults[0] || state.wallets[0]?.id || '',
    fromGroup: null,
    targetIds: new Set(defaults.slice(1)),
    asset: 'native',
    tokenAddress: '',
    amountMode: 'fixed',
    amount: '0.001',
    targetBalance: '0.001',
    executionMode: 'burst',
    preflight: true,
    plan: null,
  };
  form.fromGroup ??= null;
  if (!state.wallets.some((wallet) => wallet.id === form.fromId)) form.fromId = state.wallets[0]?.id || '';
  form.targetIds.delete(form.fromId);
  const clearPlan = () => { form.plan = null; };
  const selectedTargetIds = walletIdsInStateOrder(state, form.targetIds, new Set([form.fromId]));
  return {
    html: `
      ${networkBar({ state, asset: form.asset, tokenAddress: form.tokenAddress, mode: 'writeProfile' })}
      <div class="toolbar">
        <button class="button primary" id="refresh-disperse-balances" type="button">刷新金额</button>
        <label class="compact-field"><span>分发模式</span><select name="amountMode"><option value="fixed" ${form.amountMode === 'fixed' ? 'selected' : ''}>固定金额</option><option value="topup" ${form.amountMode === 'topup' ? 'selected' : ''}>补足余额</option></select></label>
        <label class="compact-field"><span>${form.amountMode === 'topup' ? '目标余额' : '每个地址'}</span><input name="${form.amountMode === 'topup' ? 'targetBalance' : 'amount'}" value="${escapeHtml(form.amountMode === 'topup' ? form.targetBalance : form.amount)}" inputmode="decimal"></label>
        <label class="toggle"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label>
        <div class="toolbar-spacer"></div>
        <button class="button secondary" id="preview-disperse" type="button">生成预览</button>
        <button class="button primary" id="execute-disperse" type="button" ${form.plan?.entries?.length ? '' : 'disabled'}>执行任务</button>
      </div>
      <div class="split-workspace">
        <section class="data-panel"><header><h2>分发账号</h2><span>单选</span></header>${walletPicker(state, { selected: form.fromId, name: 'fromWallet', radio: true, exclude: new Set(form.targetIds), groupPrefix: 'disperse-from', groupKey: form.fromGroup })}</section>
        <section class="data-panel"><header><h2>Recipients Wallet</h2><span>${selectedTargetIds.length} 个</span></header>${walletPicker(state, { selected: form.targetIds, name: 'targetWallet', exclude: new Set([form.fromId]), groupPrefix: 'disperse-target' })}</section>
      </div>
      <section class="preview-panel"><header><h2>交易预览</h2></header>${renderPlan(form.plan)}${renderTaskResult(form.result)}</section>
    `,
    bind(root) {
      root.querySelectorAll('input[name="asset"]').forEach((input) => input.addEventListener('change', () => {
        form.asset = input.value;
        clearPlan();
        render();
      }));
      bindTextFields(root, form, clearPlan, ['tokenAddress', 'amount', 'targetBalance']);
      root.querySelector('[name="amountMode"]')?.addEventListener('change', (event) => {
        form.amountMode = event.target.value;
        clearPlan();
        render();
      });
      root.querySelector('[name="preflight"]')?.addEventListener('change', (event) => { form.preflight = event.target.checked; clearPlan(); });
      bindPicker(root, {
        state,
        selector: 'input[name="fromWallet"]',
        selected: form.fromId,
        radio: true,
        exclude: new Set(form.targetIds),
        groupPrefix: 'disperse-from',
        onChange: (value) => { form.fromId = value; form.targetIds.delete(value); clearPlan(); render(); },
        onGroupFilter: (group) => { form.fromGroup = group; render(); },
      });
      bindPicker(root, {
        state,
        selector: 'input[name="targetWallet"]',
        selected: form.targetIds,
        exclude: new Set([form.fromId]),
        groupPrefix: 'disperse-target',
        onChange: () => { clearPlan(); render(); },
      });
      root.querySelector('#refresh-disperse-balances')?.addEventListener('click', () => {
        const walletIds = [form.fromId, ...walletIdsInStateOrder(state, form.targetIds, new Set([form.fromId]))].filter(Boolean);
        void runAction(() => api('/api/balances/refresh', {
          method: 'POST',
          body: JSON.stringify({ walletIds, chainId: writeChainId(state), tokenAddress: form.asset === 'erc20' ? form.tokenAddress : '' }),
        }), { success: '金额已更新', refresh: true });
      });
      root.querySelector('#preview-disperse')?.addEventListener('click', () => void runAction(async () => {
        form.plan = await api('/api/plan/one-to-many', {
          method: 'POST',
          body: JSON.stringify(dispersePreviewBody(state, form)),
        });
        return form.plan;
      }, { success: '预览已生成' }));
      root.querySelector('#execute-disperse')?.addEventListener('click', () => void executePlan('/api/tasks/one-to-many', form, '执行分发任务'));
    },
  };
}

export function renderCollection({ state, render }) {
  const defaults = selectedIds(state);
  const form = state.page.collection ||= {
    mode: 'token',
    sourceIds: new Set(defaults.length ? defaults : state.wallets.map((wallet) => wallet.id)),
    contractAddress: '',
    destination: '',
    destinationWalletId: state.wallets[0]?.id || '',
    reserveEth: '0.00005',
    gasMultiplier: '1.25',
    snapshot: null,
    holdingIds: new Set(),
    plan: null,
    preflight: true,
  };
  const clearPlan = () => { form.plan = null; };
  const chain = writeChain(state);
  const holdings = form.snapshot?.holdings?.rows || [];
  const sourceExclude = form.mode === 'native' ? new Set([form.destinationWalletId]) : new Set();
  const sourceIds = walletIdsInStateOrder(state, form.sourceIds, sourceExclude);
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="归集类型"><button type="button" data-mode="token" class="${form.mode === 'token' ? 'active' : ''}">代币 / NFT</button><button type="button" data-mode="native" class="${form.mode === 'native' ? 'active' : ''}">${escapeHtml(chain.nativeSymbol)}</button></div>
        ${form.mode === 'token' ? '<button class="button primary" id="query-holdings" type="button">查询持仓</button>' : '<button class="button primary" id="refresh-collection-balances" type="button">刷新金额</button>'}
        <label class="toggle"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label>
        <div class="toolbar-spacer"></div>
        <button class="button secondary" id="preview-collection" type="button">生成预览</button>
        <button class="button primary" id="execute-collection" type="button" ${form.plan?.entries?.length ? '' : 'disabled'}>执行任务</button>
      </div>
      <div class="split-workspace collection-layout">
        <section class="data-panel">
          <header><h2>归集账号</h2><span>${sourceIds.length} 个</span></header>
          ${walletPicker(state, { selected: form.sourceIds, name: 'sourceWallet', exclude: sourceExclude, groupPrefix: 'collection-source' })}
        </section>
        <section class="form-panel">
          <header><h2>归集参数</h2></header>
          ${form.mode === 'token' ? `
            <label class="field"><span>代币 / NFT 合约</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="0x..." spellcheck="false"></label>
            <label class="field"><span>Recipient Wallet</span><input name="destination" value="${escapeHtml(form.destination)}" placeholder="0x..." spellcheck="false"></label>
            <div class="holding-summary"><span>标准 <strong>${escapeHtml(form.snapshot?.holdings?.standard || '-')}</strong></span><span>总持仓 <strong>${escapeHtml(form.snapshot?.holdings?.totalFormatted || '-')}</strong></span><span>已选 <strong>${form.holdingIds.size}</strong></span></div>
            <div class="table-scroll holdings-table"><table><thead><tr><th></th><th>钱包</th><th>Token ID</th><th>数量</th></tr></thead><tbody>${holdings.map((row) => `<tr><td><input type="checkbox" name="holding" value="${escapeHtml(row.id)}" ${form.holdingIds.has(row.id) ? 'checked' : ''}></td><td>${escapeHtml(row.walletId)}</td><td class="mono">${escapeHtml(row.tokenId ?? '-')}</td><td>${escapeHtml(row.formatted)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">尚未查询持仓</td></tr>'}</tbody></table></div>
          ` : `
            <label class="field"><span>Recipient Wallet</span><select name="destinationWalletId">${state.wallets.map((wallet) => `<option value="${escapeHtml(wallet.id)}" ${form.destinationWalletId === wallet.id ? 'selected' : ''}>${escapeHtml(wallet.label || wallet.id)} · ${escapeHtml(shortAddress(wallet.address))}</option>`).join('')}</select></label>
            <label class="field"><span>保留 ${escapeHtml(chain.nativeSymbol)}</span><input name="reserveEth" value="${escapeHtml(form.reserveEth)}" inputmode="decimal"></label>
            <label class="field"><span>Gas 保留倍数</span><input name="gasMultiplier" value="${escapeHtml(form.gasMultiplier)}" inputmode="decimal"></label>
          `}
        </section>
      </div>
      <section class="preview-panel"><header><h2>交易预览</h2></header>${renderPlan(form.plan)}${renderTaskResult(form.result)}</section>
    `,
    bind(root) {
      root.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
        form.mode = button.dataset.mode;
        form.plan = null;
        render();
      }));
      bindPicker(root, {
        state,
        selector: 'input[name="sourceWallet"]',
        selected: form.sourceIds,
        exclude: sourceExclude,
        groupPrefix: 'collection-source',
        onChange: () => { clearPlan(); render(); },
      });
      bindTextFields(root, form, () => { form.snapshot = null; form.holdingIds.clear(); clearPlan(); }, ['contractAddress']);
      bindTextFields(root, form, clearPlan, ['destination', 'reserveEth', 'gasMultiplier']);
      root.querySelector('[name="destinationWalletId"]')?.addEventListener('change', (event) => {
        form.destinationWalletId = event.target.value;
        form.sourceIds.delete(form.destinationWalletId);
        clearPlan();
        render();
      });
      root.querySelector('[name="preflight"]')?.addEventListener('change', (event) => { form.preflight = event.target.checked; clearPlan(); });
      root.querySelectorAll('input[name="holding"]').forEach((input) => input.addEventListener('change', () => {
        if (input.checked) form.holdingIds.add(input.value);
        else form.holdingIds.delete(input.value);
        clearPlan();
        render();
      }));
      root.querySelector('#query-holdings')?.addEventListener('click', () => void runAction(async () => {
        form.snapshot = await api('/api/token-holdings/query', {
          method: 'POST',
          body: JSON.stringify({ chainId: writeChainId(state), walletIds: sourceIds, contractAddress: form.contractAddress }),
        });
        form.holdingIds = new Set(form.snapshot.holdings.rows.filter((row) => BigInt(row.count || 0) > 0n).map((row) => row.id));
        form.plan = null;
        return form.snapshot;
      }, { success: '持仓已更新' }));
      root.querySelector('#refresh-collection-balances')?.addEventListener('click', () => void runAction(() => api('/api/balances/refresh', {
        method: 'POST',
        body: JSON.stringify({ walletIds: sourceIds, chainId: writeChainId(state) }),
      }), { success: '金额已更新', refresh: true }));
      root.querySelector('#preview-collection')?.addEventListener('click', () => void runAction(async () => {
        const request = collectionPreviewRequest(state, form);
        form.plan = await api(request.path, {
          method: 'POST',
          body: JSON.stringify(request.body),
        });
        return form.plan;
      }, { success: '预览已生成' }));
      root.querySelector('#execute-collection')?.addEventListener('click', () => void executePlan(form.mode === 'token' ? '/api/tasks/token-collect' : '/api/tasks/many-to-one', form, '执行归集任务'));
    },
  };
}

export function renderManyToMany({ state, render }) {
  const defaults = selectedIds(state);
  const form = state.page.many ||= {
    senderIds: new Set(defaults),
    receiverIds: new Set(),
    asset: 'native',
    tokenAddress: '',
    amount: '0.001',
    preflight: true,
    executionMode: 'burst',
    plan: null,
  };
  const clearPlan = () => { form.plan = null; };
  const senderIds = walletIdsInStateOrder(state, form.senderIds, form.receiverIds);
  const receiverIds = walletIdsInStateOrder(state, form.receiverIds, form.senderIds);
  const walletById = new Map(pickerWallets(state).map((wallet) => [String(wallet.id), wallet]));
  const senders = senderIds.map((id) => walletById.get(id));
  const receivers = receiverIds.map((id) => walletById.get(id));
  return {
    html: `
      ${networkBar({ state, asset: form.asset, tokenAddress: form.tokenAddress, mode: 'writeProfile' })}
      <div class="toolbar">
        <label class="compact-field"><span>每笔金额</span><input name="amount" value="${escapeHtml(form.amount)}" inputmode="decimal"></label>
        
        <label class="toggle"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label>
        <div class="pair-count ${senders.length === receivers.length && senders.length ? 'valid' : ''}">${senders.length} : ${receivers.length}</div>
        <div class="toolbar-spacer"></div>
        <button class="button secondary" id="preview-many" type="button">生成预览</button>
        <button class="button primary" id="execute-many" type="button" ${form.plan?.entries?.length ? '' : 'disabled'}>执行任务</button>
      </div>
      <div class="split-workspace">
        <section class="data-panel"><header><h2>Senders Wallet</h2><span>${senders.length} 个</span></header>${walletPicker(state, { selected: form.senderIds, name: 'senderWallet', exclude: form.receiverIds, groupPrefix: 'many-sender' })}</section>
        <section class="data-panel"><header><h2>Recipients Wallet</h2><span>${receivers.length} 个</span></header>${walletPicker(state, { selected: form.receiverIds, name: 'receiverWallet', exclude: form.senderIds, groupPrefix: 'many-receiver' })}</section>
      </div>
      <section class="pair-preview"><header><h2>转账对应关系</h2></header><div class="pair-list">${senders.map((sender, index) => `<div><span>${index + 1}</span><code>${escapeHtml(sender.label || sender.id)}</code><b>→</b><code>${escapeHtml(receivers[index]?.label || '待选择')}</code></div>`).join('') || '<div class="empty-state">请选择发送和接收钱包</div>'}</div></section>
      <section class="preview-panel"><header><h2>交易预览</h2></header>${renderPlan(form.plan)}${renderTaskResult(form.result)}</section>
    `,
    bind(root) {
      root.querySelectorAll('input[name="asset"]').forEach((input) => input.addEventListener('change', () => { form.asset = input.value; clearPlan(); render(); }));
      bindTextFields(root, form, clearPlan, ['tokenAddress', 'amount']);
      root.querySelector('[name="preflight"]')?.addEventListener('change', (event) => { form.preflight = event.target.checked; clearPlan(); });
      bindPicker(root, {
        state,
        selector: 'input[name="senderWallet"]',
        selected: form.senderIds,
        exclude: form.receiverIds,
        groupPrefix: 'many-sender',
        onChange: () => { clearPlan(); render(); },
      });
      bindPicker(root, {
        state,
        selector: 'input[name="receiverWallet"]',
        selected: form.receiverIds,
        exclude: form.senderIds,
        groupPrefix: 'many-receiver',
        onChange: () => { clearPlan(); render(); },
      });
      root.querySelector('#preview-many')?.addEventListener('click', () => void runAction(async () => {
        form.plan = await api('/api/plan/many-to-many', {
          method: 'POST',
          body: JSON.stringify(manyToManyPreviewBody(state, form)),
        });
        return form.plan;
      }, { success: '预览已生成' }));
      root.querySelector('#execute-many')?.addEventListener('click', () => void executePlan('/api/tasks/many-to-many', form, '执行多对多转账'));
    },
  };
}

export function renderExchangeDeposit({ state, render }) {
  const defaults = selectedIds(state);
  const form = state.page.exchange ||= {
    walletIds: new Set(defaults.length ? defaults : state.wallets.map((wallet) => wallet.id)),
    amount: '0.01',
    preflight: true,
    addresses: Object.fromEntries(state.wallets.map((wallet) => [wallet.id, wallet.exchangeAddress || ''])),
    plans: [],
  };
  const chain = writeChain(state);
  const selectedWallets = exchangePreviewRows(state, form);
  const clearPlans = () => { form.plans = []; };
  const combinedPlan = form.plans.length ? {
    entries: form.plans.flatMap(({ plan }) => plan.entries || []),
    confirmation: { mode: '逐钱包', expiresAt: form.plans[0]?.plan.confirmation?.expiresAt },
  } : null;
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}
      <div class="toolbar">
        <label class="compact-field"><span>每个钱包充值</span><input name="amount" value="${escapeHtml(form.amount)}" inputmode="decimal"></label>
        <span class="unit-label">${escapeHtml(chain.nativeSymbol)}</span>
        <label class="toggle"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label>
        <div class="toolbar-spacer"></div>
        <button class="button secondary" id="preview-exchange" type="button">生成预览</button>
        <button class="button primary" id="execute-exchange" type="button" ${form.plans.length ? '' : 'disabled'}>执行任务</button>
      </div>
      <div class="exchange-groups">${walletGroupBar(state, form.walletIds, 'exchange')}</div>
      <div class="table-scroll exchange-table"><table>
        <thead><tr><th></th><th>#</th><th>备注</th><th>钱包地址</th><th>分组</th><th>交易所充值地址</th><th>金额</th><th>操作</th></tr></thead>
        <tbody>${state.wallets.map((wallet, index) => `<tr data-exchange-row="${escapeHtml(wallet.id)}">
          <td><input type="checkbox" name="exchangeWallet" value="${escapeHtml(wallet.id)}" ${form.walletIds.has(wallet.id) ? 'checked' : ''}></td>
          <td>${index + 1}</td><td>${escapeHtml(wallet.label || wallet.id)}</td><td class="mono">${escapeHtml(shortAddress(wallet.address))}</td>
          <td>${escapeHtml(normalizeWalletGroup(wallet.group) || UNGROUPED_LABEL)}</td>
          <td><input class="table-input wide mono" name="exchangeAddress" value="${escapeHtml(form.addresses[wallet.id] || '')}" placeholder="0x..." spellcheck="false"></td>
          <td>${escapeHtml(form.amount)} ${escapeHtml(chain.nativeSymbol)}</td><td><button class="link-button save-exchange-address" type="button">保存地址</button></td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty-cell">未找到钱包</td></tr>'}</tbody>
      </table></div>
      <footer class="table-footer"><span>已选 ${selectedWallets.length} 个钱包</span><span>合计 ${escapeHtml((Number(form.amount || 0) * selectedWallets.length).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''))} ${escapeHtml(chain.nativeSymbol)}</span></footer>
      <section class="preview-panel"><header><h2>交易预览</h2></header>${renderPlan(combinedPlan)}</section>
    `,
    bind(root) {
      bindTextFields(root, form, clearPlans, ['amount']);
      root.querySelector('[name="preflight"]')?.addEventListener('change', (event) => { form.preflight = event.target.checked; clearPlans(); });
      bindWalletGroupBar(root, state, form.walletIds, {
        prefix: 'exchange',
        onChange: () => { clearPlans(); render(); },
      });
      root.querySelectorAll('[data-exchange-row]').forEach((row) => {
        const walletId = row.dataset.exchangeRow;
        const wallet = state.wallets.find((item) => item.id === walletId);
        const addressInput = row.querySelector('[name="exchangeAddress"]');
        addressInput.addEventListener('input', () => { form.addresses[walletId] = addressInput.value; clearPlans(); });
        row.querySelector('[name="exchangeWallet"]').addEventListener('change', (event) => {
          if (event.target.checked) form.walletIds.add(walletId);
          else form.walletIds.delete(walletId);
          clearPlans();
          render();
        });
        row.querySelector('.save-exchange-address').addEventListener('click', () => void runAction(() => api(`/api/wallets/${encodeURIComponent(walletId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...wallet, exchangeAddress: form.addresses[walletId] }),
        }), { success: `${walletId} 充值地址已保存`, refresh: true }));
      });
      root.querySelector('#preview-exchange')?.addEventListener('click', () => void runAction(async () => {
        const valueWei = nativeToWei(form.amount);
        const rows = exchangePreviewRows(state, form);
        if (!rows.length) throw new Error('请至少选择一个钱包');
        const missing = rows.filter((wallet) => !/^0x[a-fA-F0-9]{40}$/.test(form.addresses[wallet.id] || ''));
        if (missing.length) throw new Error(`交易所地址无效：${missing.map((wallet) => wallet.label || wallet.id).join(', ')}`);
        form.plans = [];
        for (const wallet of rows) {
          const plan = await api('/api/plan/contract-call', {
            method: 'POST',
            body: JSON.stringify({
              chainId: writeChainId(state),
              walletIds: [wallet.id],
              to: form.addresses[wallet.id],
              valueWei,
              data: '0x',
              preflight: form.preflight,
              executionMode: 'burst',
              rpcProfileId: writeProfileId(state),
              rpcProfileRef: writeProfileRef(state),
            }),
          });
          form.plans.push({ walletId: wallet.id, plan });
        }
        return form.plans;
      }, { success: '预览已生成' }));
      root.querySelector('#execute-exchange')?.addEventListener('click', () => {
        if (!window.confirm(`确认向 ${form.plans.length} 个交易所地址发送 ${form.amount} ${chain.nativeSymbol}？`)) return;
        void runAction(async () => {
          const results = [];
          for (const item of form.plans) {
            results.push(await api('/api/tasks/contract-call', {
              method: 'POST',
              body: JSON.stringify(confirmationBody(item.plan)),
            }));
          }
          return results;
        }, { success: '充值任务已提交' });
      });
    },
  };
}
