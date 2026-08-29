import {
  api,
  bindWalletChecks,
  currentChain,
  escapeHtml,
  networkBar,
  persistSelection,
  requestDeadline,
  runAction,
  selectedIds,
  shortAddress,
  walletBalance,
} from './core.js';
import { groupWallets, normalizeWalletGroup, UNGROUPED_LABEL } from './wallet-groups.js';

const ALL_GROUP_FILTER = 'all';
const GROUP_FILTER_PREFIX = 'group:';

function groupFilterToken(state) {
  return String(state.page.walletGroupFilter || ALL_GROUP_FILTER);
}

function groupFromFilterToken(token) {
  if (!token.startsWith(GROUP_FILTER_PREFIX)) return null;
  try {
    return decodeURIComponent(token.slice(GROUP_FILTER_PREFIX.length));
  } catch {
    return '';
  }
}

function tokenForGroup(group) {
  return `${GROUP_FILTER_PREFIX}${encodeURIComponent(group)}`;
}

function visibleWallets(state) {
  const search = String(state.page.walletSearch || '').trim().toLowerCase();
  const group = groupFromFilterToken(groupFilterToken(state));
  return state.wallets.filter((wallet) => {
    if (group !== null && normalizeWalletGroup(wallet.group) !== group) return false;
    if (!search) return true;
    return [wallet.id, wallet.label, wallet.address, normalizeWalletGroup(wallet.group), wallet.note]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });
}

function walletRows(state) {
  const rows = visibleWallets(state);
  const chain = currentChain(state);
  return rows.map((wallet, index) => {
    const balance = walletBalance(wallet, chain.id);
    return `
      <tr data-wallet-row="${escapeHtml(wallet.id)}">
        <td class="check-cell"><input type="checkbox" data-wallet-check value="${escapeHtml(wallet.id)}" ${state.selected.has(wallet.id) ? 'checked' : ''} aria-label="选择 ${escapeHtml(wallet.id)}"></td>
        <td>${index + 1}</td>
        <td><input class="table-input" data-field="label" value="${escapeHtml(wallet.label)}" placeholder="${escapeHtml(wallet.id)}"></td>
        <td class="mono address-cell" title="${escapeHtml(wallet.address)}">${escapeHtml(shortAddress(wallet.address))}</td>
        <td><input class="table-input" data-field="group" value="${escapeHtml(normalizeWalletGroup(wallet.group))}" placeholder="${UNGROUPED_LABEL}"></td>
        <td class="number-cell">${balance ? `${escapeHtml(balance.formatted)} ${escapeHtml(balance.symbol)}` : '-'}</td>
        <td><input class="table-input wide" data-field="proxyIp" value="${escapeHtml(wallet.proxyIp)}" placeholder="host:port"></td>
        <td><input class="table-input wide mono" data-field="exchangeAddress" value="${escapeHtml(wallet.exchangeAddress)}" placeholder="0x..."></td>
        <td><input class="table-input" data-field="note" value="${escapeHtml(wallet.note)}" placeholder="-"></td>
        <td class="actions-cell">
          <button class="link-button save-wallet" type="button">保存</button>
          <button class="link-button test-proxy" type="button" ${wallet.proxyIp ? '' : 'disabled'}>测试 IP</button>
        </td>
      </tr>
    `;
  }).join('');
}

export function renderWalletManager({ state, openDialog, render, toast }) {
  const ids = selectedIds(state);
  const visible = visibleWallets(state);
  const groupFilter = groupFilterToken(state);
  const groups = groupWallets(state.wallets);
  const visibleSelectedCount = visible.filter((wallet) => state.selected.has(wallet.id)).length;
  const allVisibleSelected = visible.length > 0 && visible.every((wallet) => state.selected.has(wallet.id));
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'readOnly' })}
      <div class="toolbar wallet-toolbar">
        <button class="button primary" id="create-wallets" type="button">创建钱包</button>
        <button class="button primary" id="import-wallets" type="button">导入私钥</button>
        <button class="button danger" id="delete-wallets" type="button" ${ids.length ? '' : 'disabled'}>删除选中</button>
        <button class="button primary" id="refresh-balances" type="button">余额查询</button>
        <button class="button primary" id="set-group" type="button" ${ids.length ? '' : 'disabled'}>设置分组</button>
        <button class="button secondary" id="clear-group" type="button" ${ids.length ? '' : 'disabled'}>清除分组</button>
        <button class="button secondary" id="export-wallets" type="button" ${ids.length ? '' : 'disabled'}>导出</button>
        <div class="toolbar-spacer"></div>
        <label class="compact-field"><span>分组</span><select id="wallet-group-filter"><option value="${ALL_GROUP_FILTER}" ${groupFilter === ALL_GROUP_FILTER ? 'selected' : ''}>全部</option>${groups.map((group) => {
          const token = tokenForGroup(group.key);
          return `<option value="${escapeHtml(token)}" ${groupFilter === token ? 'selected' : ''}>${escapeHtml(group.label)} (${group.walletIds.length})</option>`;
        }).join('')}</select></label>
        <label class="search-field"><span class="sr-only">搜索钱包</span><input id="wallet-search" value="${escapeHtml(state.page.walletSearch || '')}" placeholder="搜索名称 / 地址 / 分组"></label>
      </div>
      <div class="table-scroll wallet-table">
        <table>
          <thead><tr>
            <th class="check-cell"><input type="checkbox" id="select-visible" ${allVisibleSelected ? 'checked' : ''} data-partial="${String(someVisibleSelected)}" aria-label="全选当前钱包"></th>
            <th>#</th><th>备注</th><th>钱包地址</th><th>分组</th><th>金额(${escapeHtml(currentChain(state).nativeSymbol)})</th><th>代理 IP</th><th>交易所地址</th><th>说明</th><th>操作</th>
          </tr></thead>
          <tbody>${walletRows(state) || '<tr><td colspan="10" class="empty-cell">未找到钱包</td></tr>'}</tbody>
        </table>
      </div>
      <footer class="table-footer"><span>当前 ${visible.length} 条</span><span>已选 ${ids.length} 条</span></footer>
    `,
    bind(root) {
      bindWalletChecks(root, state);
      const selectVisible = root.querySelector('#select-visible');
      if (selectVisible) selectVisible.indeterminate = selectVisible.dataset.partial === 'true';
      selectVisible?.addEventListener('change', (event) => {
        for (const wallet of visible) {
          if (event.target.checked) state.selected.add(wallet.id);
          else state.selected.delete(wallet.id);
        }
        persistSelection(state);
        render();
      });
      root.querySelector('#wallet-search')?.addEventListener('input', (event) => {
        state.page.walletSearch = event.target.value;
      });
      root.querySelector('#wallet-search')?.addEventListener('change', render);
      root.querySelector('#wallet-group-filter')?.addEventListener('change', (event) => {
        state.page.walletGroupFilter = event.target.value;
        render();
      });

      root.querySelector('#create-wallets')?.addEventListener('click', () => openDialog({
        title: '创建钱包',
        body: `
          <label class="field"><span>创建数量</span><input name="count" type="number" min="1" max="500" value="1" required></label>
          <label class="field"><span>账号名称</span><input name="prefix" value="wallet" maxlength="32" required></label>
          <label class="field"><span>起始序号</span><input name="start" type="number" min="1" value="1" required></label>
        `,
        onSubmit: async (values) => Boolean(await runAction(() => api('/api/wallets/create', {
          method: 'POST',
          body: JSON.stringify({ count: Number(values.count), prefix: values.prefix, start: Number(values.start) }),
        }), { success: '钱包已创建', refresh: true })),
      }));

      root.querySelector('#import-wallets')?.addEventListener('click', () => openDialog({
        title: '导入私钥',
        body: '<label class="field"><span>钱包列表</span><textarea name="text" rows="9" placeholder="名称,私钥\n名称,分组,私钥" required spellcheck="false"></textarea></label>',
        onSubmit: async (values) => Boolean(await runAction(() => api('/api/wallets/import', {
          method: 'POST',
          body: JSON.stringify({ text: values.text }),
        }), { success: '钱包已导入', refresh: true })),
      }));

      root.querySelector('#set-group')?.addEventListener('click', () => openDialog({
        title: '设置分组',
        body: '<label class="field"><span>分组名称</span><input name="group" maxlength="80" required autofocus></label>',
        onSubmit: async (values) => Boolean(await runAction(() => api('/api/wallets/bulk-group', {
          method: 'POST',
          body: JSON.stringify({ walletIds: ids, group: values.group }),
        }), { success: '分组已更新', refresh: true })),
      }));

      root.querySelector('#clear-group')?.addEventListener('click', () => {
        void runAction(() => api('/api/wallets/bulk-group', {
          method: 'POST',
          body: JSON.stringify({ walletIds: ids, group: '' }),
        }), { success: '已清除所选钱包分组', refresh: true });
      });

      root.querySelector('#delete-wallets')?.addEventListener('click', () => openDialog({
        title: '删除选中钱包',
        danger: true,
        confirmText: '确认删除',
        body: `<p class="dialog-warning">将删除 ${ids.length} 个本地钱包。</p><label class="field"><span>确认文本</span><input name="phrase" placeholder="输入：确认删除" required></label>`,
        onSubmit: async (values) => {
          if (values.phrase !== '确认删除') {
            toast('请输入“确认删除”', 'error');
            return false;
          }
          const result = await runAction(() => api('/api/wallets', {
            method: 'DELETE',
            body: JSON.stringify({ walletIds: ids }),
          }), { success: '所选钱包已删除', refresh: true, rerender: false });
          if (result) {
            state.selected.clear();
            persistSelection(state);
            render();
          }
          return Boolean(result);
        },
      }));

      root.querySelector('#refresh-balances')?.addEventListener('click', () => {
        const walletIds = ids.length ? ids : visible.map((wallet) => wallet.id);
        void runAction(() => api('/api/balances/refresh', {
          method: 'POST',
          body: JSON.stringify({ walletIds, chainId: state.chainId }),
        }), { success: '余额已更新', refresh: true });
      });

      root.querySelector('#export-wallets')?.addEventListener('click', () => openDialog({
        title: '导出钱包',
        confirmText: '导出',
        body: '<label class="field"><span>确认文本</span><input name="phrase" placeholder="输入：确认导出私钥" required autocomplete="off"></label>',
        onSubmit: async (values) => {
          const result = await runAction(async () => {
            const response = await fetch('/api/wallets/export', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ walletIds: ids, phrase: values.phrase }),
              signal: requestDeadline({ method: 'POST' }).signal,
            });
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}));
              throw new Error(payload.error || '钱包导出失败');
            }
            const href = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = href;
            link.download = `nfttool-wallets-${Date.now()}.txt`;
            link.click();
            URL.revokeObjectURL(href);
            return true;
          }, { success: '钱包已导出', rerender: false });
          return Boolean(result);
        },
      }));

      root.querySelectorAll('[data-wallet-row]').forEach((row) => {
        const walletId = row.dataset.walletRow;
        const wallet = state.wallets.find((item) => item.id === walletId);
        row.querySelector('.save-wallet')?.addEventListener('click', () => {
          const values = Object.fromEntries([...row.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.value]));
          void runAction(() => api(`/api/wallets/${encodeURIComponent(walletId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...wallet, ...values }),
          }), { success: `${walletId} 已保存`, refresh: true });
        });
        row.querySelector('.test-proxy')?.addEventListener('click', () => {
          const proxy = row.querySelector('[data-field="proxyIp"]').value;
          void runAction(async () => {
            const result = await api('/api/network/test-proxy', { method: 'POST', body: JSON.stringify({ proxy }) });
            toast(`${result.host}:${result.port} ${result.latencyMs}ms`);
            return result;
          }, { rerender: false });
        });
      });
    },
  };
}
