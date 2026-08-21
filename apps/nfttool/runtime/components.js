import {
  escapeHtml,
  selectedIds,
  shortAddress,
  walletBalance,
  writeChain,
  writeChainId,
} from './core.js';
import {
  groupWallets,
  normalizeWalletGroup,
  toggleWalletGroup,
  UNGROUPED_LABEL,
  walletGroupSelection,
} from './wallet-groups.js';

export { normalizeWalletGroup, toggleWalletGroup };

function walletsFrom(value) {
  return Array.isArray(value) ? value : value?.wallets || [];
}

export function walletGroups(stateOrWallets, { exclude = new Set() } = {}) {
  return groupWallets(walletsFrom(stateOrWallets), { excludedIds: exclude });
}

export function walletGroupState(selectedIds = [], walletIds = []) {
  const selection = walletGroupSelection(selectedIds, walletIds);
  return {
    selectedCount: selection.selectedCount,
    total: selection.total,
    checked: selection.complete,
    partial: selection.partial,
  };
}

function groupButton(group, selected) {
  const status = walletGroupState(selected, group.walletIds);
  const className = `group-check${status.checked ? ' active' : ''}${status.partial ? ' partial' : ''}`;
  return `<button class="${className}" data-wallet-group-action="toggle" data-wallet-group-key="${escapeHtml(group.key)}" type="button" aria-pressed="${status.partial ? 'mixed' : String(status.checked)}"><span>${escapeHtml(group.label)}</span><small>${status.selectedCount}/${status.total}</small></button>`;
}

export function walletGroupBar(state, selected, prefix = 'wallet-group', { exclude = new Set() } = {}) {
  const groups = walletGroups(state, { exclude });
  const availableIds = groups.flatMap((group) => group.walletIds);
  const status = walletGroupState(selected, availableIds);
  const allClass = `group-check${status.checked ? ' active' : ''}${status.partial ? ' partial' : ''}`;
  return `
    <div class="account-groups" data-wallet-group-bar data-wallet-group-mode="select" data-wallet-group-prefix="${escapeHtml(prefix)}" aria-label="钱包分组快捷选择">
      <span>账号(${status.selectedCount})</span>
      <button class="${allClass}" data-wallet-group-action="all" type="button" aria-pressed="${status.partial ? 'mixed' : String(status.checked)}"><span>全部</span><small>${status.selectedCount}/${status.total}</small></button>
      ${groups.map((group) => groupButton(group, selected)).join('')}
      <button class="group-check clear" data-wallet-group-action="clear" type="button"><span>清空</span></button>
    </div>
  `;
}

export function walletGroupFilterBar(state, activeKey = null, prefix = 'wallet-group-filter', { exclude = new Set() } = {}) {
  const groups = walletGroups(state, { exclude });
  return `
    <div class="account-groups group-filter" data-wallet-group-bar data-wallet-group-mode="filter" data-wallet-group-prefix="${escapeHtml(prefix)}" aria-label="钱包分组筛选">
      <span>分组</span>
      <button class="group-check${activeKey === null ? ' active' : ''}" data-wallet-group-action="filter-all" type="button" aria-pressed="${String(activeKey === null)}"><span>全部</span><small>${groups.reduce((total, group) => total + group.walletIds.length, 0)}</small></button>
      ${groups.map((group) => `<button class="group-check${activeKey === group.key ? ' active' : ''}" data-wallet-group-action="filter" data-wallet-group-key="${escapeHtml(group.key)}" type="button" aria-pressed="${String(activeKey === group.key)}"><span>${escapeHtml(group.label)}</span><small>${group.walletIds.length}</small></button>`).join('')}
    </div>
  `;
}

function groupBars(root, prefix, mode) {
  return [...root.querySelectorAll('[data-wallet-group-bar]')]
    .filter((bar) => bar.dataset.walletGroupPrefix === prefix && bar.dataset.walletGroupMode === mode);
}

export function bindWalletGroupBar(root, state, selected, {
  prefix = 'wallet-group',
  exclude = new Set(),
  render,
  onChange,
} = {}) {
  const changed = () => {
    onChange?.(new Set(selected));
    render?.();
  };

  for (const bar of groupBars(root, prefix, 'select')) {
    for (const button of bar.querySelectorAll('[data-wallet-group-action]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.walletGroupAction;
        const currentGroups = walletGroups(state, { exclude });
        if (action === 'all') currentGroups.flatMap((group) => group.walletIds).forEach((id) => selected.add(id));
        else if (action === 'clear') selected.clear();
        else if (action === 'toggle') {
          const groupIds = currentGroups.find((group) => group.key === button.dataset.walletGroupKey)?.walletIds || [];
          const next = toggleWalletGroup(selected, groupIds);
          selected.clear();
          next.forEach((id) => selected.add(id));
        }
        changed();
      });
    }
  }
}

export function bindWalletGroupFilter(root, {
  prefix = 'wallet-group-filter',
  onChange,
} = {}) {
  for (const bar of groupBars(root, prefix, 'filter')) {
    for (const button of bar.querySelectorAll('[data-wallet-group-action]')) {
      button.addEventListener('click', () => {
        onChange?.(button.dataset.walletGroupAction === 'filter-all' ? null : button.dataset.walletGroupKey);
      });
    }
  }
}

export function walletTable(state, selected, {
  inputName = 'selectedWallet',
  showBalance = true,
  compact = false,
  emptyText = '未找到钱包',
} = {}) {
  const chain = writeChain(state);
  const selection = walletGroupState(selected, state.wallets.map((wallet) => wallet.id));
  return `
    <div class="table-scroll account-table ${compact ? 'compact' : ''}" data-wallet-table-input="${escapeHtml(inputName)}">
      <table>
        <thead><tr><th class="check-cell"><input class="wallet-check-all" type="checkbox" aria-label="全选钱包" ${selection.checked ? 'checked' : ''} data-partial="${String(selection.partial)}"></th><th>#</th><th>备注</th><th>地址</th><th>分组</th>${showBalance ? `<th>金额(${escapeHtml(chain.nativeSymbol)})</th>` : ''}</tr></thead>
        <tbody>${state.wallets.map((wallet, index) => {
          const balance = walletBalance(wallet, writeChainId(state));
          return `
            <tr>
              <td class="check-cell"><input type="checkbox" name="${escapeHtml(inputName)}" value="${escapeHtml(wallet.id)}" ${selected.has(wallet.id) ? 'checked' : ''} aria-label="选择 ${escapeHtml(wallet.label || wallet.id)}"></td>
              <td>${index + 1}</td>
              <td>${escapeHtml(wallet.label || wallet.id)}</td>
              <td class="mono" title="${escapeHtml(wallet.address)}">${escapeHtml(shortAddress(wallet.address))}</td>
              <td>${escapeHtml(normalizeWalletGroup(wallet.group) || UNGROUPED_LABEL)}</td>
              ${showBalance ? `<td class="number-cell">${escapeHtml(balance?.formatted ?? '-')}</td>` : ''}
            </tr>
          `;
        }).join('') || `<tr><td colspan="${showBalance ? 6 : 5}" class="empty-cell">${escapeHtml(emptyText)}</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

export function bindWalletTable(root, state, selected, {
  inputName = 'selectedWallet',
  rerender = true,
  render,
  onChange,
} = {}) {
  const tableRoot = root.querySelector(`[data-wallet-table-input="${inputName}"]`);
  const scope = tableRoot?.closest('.data-panel') || tableRoot?.parentElement || root;
  const groupBar = scope.querySelector('[data-wallet-group-mode="select"]');
  const groupPrefix = groupBar?.dataset.walletGroupPrefix;
  const checkAll = scope.querySelector('.wallet-check-all');
  if (checkAll) checkAll.indeterminate = checkAll.dataset.partial === 'true';
  const changed = () => {
    onChange?.(new Set(selected));
    if (rerender) render?.();
  };
  scope.querySelectorAll(`input[name="${inputName}"]`).forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
      changed();
    });
  });
  checkAll?.addEventListener('change', (event) => {
    selected.clear();
    if (event.target.checked) state.wallets.forEach((wallet) => selected.add(wallet.id));
    changed();
  });
  if (groupPrefix) bindWalletGroupBar(scope, state, selected, { prefix: groupPrefix, onChange: changed });
}

export function selectedWalletSet(state) {
  const ids = selectedIds(state);
  return new Set(ids.length ? ids : state.wallets.map((wallet) => wallet.id));
}

export function statusLabel(value) {
  const labels = {
    previewed: '已预览',
    scheduled: '等待执行',
    running: '执行中',
    stopping: '停止中',
    stopped: '已停止',
    confirmation_pending: '待确认',
    confirmed: '成功',
    partial: '部分完成',
    failed: '失败',
    skipped: '已跳过',
    notified: '已通知',
    ready: '通过',
    armed: '自动执行',
    preview: '仅预览',
  };
  return labels[value] || String(value || '-');
}

export function statusClass(value) {
  if (['confirmed', 'ready', 'previewed', 'notified'].includes(value)) return 'success';
  if (['failed', 'stopped'].includes(value)) return 'danger';
  if (['running', 'scheduled', 'confirmation_pending', 'armed'].includes(value)) return 'warning';
  return '';
}

export function formatDateTime(value, fallback = '-') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : fallback;
}

export function bindFields(root, form, names, { clear, renderNames = [] } = {}) {
  const rerender = new Set(renderNames);
  for (const name of names) {
    const input = root.querySelector(`[name="${name}"]`);
    if (!input) continue;
    const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      form[name] = input.type === 'checkbox' ? input.checked : input.value;
      clear?.();
      if (rerender.has(name)) window.requestAnimationFrame(() => root.dispatchEvent(new CustomEvent('nfttool:rerender')));
    });
  }
}

export function encodeFormBody(form, names) {
  return Object.fromEntries(names.map((name) => [name, form[name]]));
}
