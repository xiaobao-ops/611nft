import { api, currentChain, escapeHtml, networkBar, shortAddress, toast, writeChainId, writeProfileId, writeProfileRef } from './core.js';
import { renderAdvancedMintPanel, createAdvancedForm } from './advanced-mint.js';
import {
  bindWalletTable,
  selectedWalletSet,
  statusClass,
  statusLabel,
  walletGroupBar,
  walletTable,
} from './components.js';

const OPENSEA_ACTIVE = new Set(['sending', 'confirmation_pending', 'pending']);
const OPENSEA_LABELS = {
  previewed: '已预览',
  ready: '可执行',
  skipped: '已跳过',
  failed: '失败',
  sending: '发送中',
  pending: '发送中',
  sent: '已发送',
  confirmation_pending: '待确认',
  confirmed: '成功',
  completed: '已完成',
};

function defaultModeForChain(state) {
  return Number(currentChain(state).id) === 4663 ? 'opensea' : 'method';
}

function openSeaStatusLabel(value) {
  return OPENSEA_LABELS[value] || statusLabel(value);
}

function openSeaStatusClass(value) {
  if (['ready', 'confirmed', 'completed', 'previewed'].includes(value)) return 'success';
  if (['failed', 'skipped'].includes(value)) return value === 'failed' ? 'danger' : '';
  if (['sending', 'pending', 'confirmation_pending'].includes(value)) return 'warning';
  return statusClass(value);
}

function eventAddress(event) {
  return String(event?.address || event?.contractAddress || '').trim();
}

function eventQuantity(event) {
  const value = event?.quantity ?? event?.mintQuantity ?? event?.mint_quantity ?? '1';
  const match = String(value).match(/^\d+$/);
  return match && Number(value) > 0 ? String(Number(value)) : '1';
}

function clearPolling(form) {
  if (!form?.pollTimer) return;
  window.clearInterval(form.pollTimer);
  form.pollTimer = null;
}

export function createMintActionState(state) {
  const walletIds = selectedWalletSet(state);
  const advanced = createAdvancedForm(state, { walletIds });
  return {
    chainId: Number(writeChainId(state)),
    mode: defaultModeForChain(state),
    eventId: '',
    event: null,
    walletIds,
    scrollTop: 0,
    advanced,
    openSea: {
      walletIds,
      contractAddress: '',
      quantity: '1',
      tokenId: '0',
      concurrency: '5',
      maxMintCostEth: '',
      job: null,
      error: '',
      busy: false,
      pollTimer: null,
    },
  };
}

export function prepareMintAction(action, state, event) {
  if (Number(action.chainId) !== Number(state.chainId)) {
    clearPolling(action.advanced);
    clearPolling(action.openSea);
    action.chainId = Number(state.chainId);
    action.mode = defaultModeForChain(state);
    action.advanced.job = null;
    action.openSea.job = null;
    action.openSea.error = '';
    action.scrollTop = 0;
  }
  action.advanced.walletIds = action.walletIds;
  action.openSea.walletIds = action.walletIds;
  const nextId = String(event?.id || eventAddress(event) || '');
  if (nextId === action.eventId) return;
  clearPolling(action.advanced);
  clearPolling(action.openSea);
  action.eventId = nextId;
  action.event = event || null;
  action.scrollTop = 0;
  const contract = eventAddress(event);
  action.advanced.contractAddress = String(event?.mintTarget || contract || '');
  action.openSea.contractAddress = contract;
  action.openSea.quantity = eventQuantity(event);
  action.openSea.tokenId = '0';
  action.advanced.job = null;
  action.openSea.job = null;
  action.openSea.error = '';
}

function startOpenSeaPolling(form, render) {
  if (!form.job?.id || form.pollTimer || !OPENSEA_ACTIVE.has(form.job.status)) return;
  form.pollTimer = window.setInterval(async () => {
    if (form.pollInFlight) return;
    form.pollInFlight = true;
    try {
      const result = await api(`/api/nft-mint/jobs/${encodeURIComponent(form.job.id)}`);
      form.job = result.job;
      render();
      if (!OPENSEA_ACTIVE.has(form.job.status)) {
        window.clearInterval(form.pollTimer);
        form.pollTimer = null;
      }
    } catch (error) {
      window.clearInterval(form.pollTimer);
      form.pollTimer = null;
      form.error = error.message;
      toast(error.message, 'error');
      render();
    } finally {
      form.pollInFlight = false;
    }
  }, 2000);
}

function openSeaPayload(form, state) {
  return {
    chainId: state.chainId,
    rpcProfileId: writeProfileId(state),
    rpcProfileRef: writeProfileRef(state),
    walletIds: [...form.walletIds],
    contractAddress: form.contractAddress,
    quantity: form.quantity,
    tokenId: form.tokenId,
    concurrency: form.concurrency,
    maxMintCostEth: form.maxMintCostEth,
  };
}

function openSeaJobSummary(job, chain) {
  if (!job) return '<div class="empty-state">尚未生成 OpenSea 真实报价</div>';
  const summary = job.summary || {};
  return `
    <div class="plan-summary opensea-job-summary">
      <div><span>钱包</span><strong>${summary.total ?? job.wallets?.length ?? 0}</strong></div>
      <div><span>可执行</span><strong>${summary.ready ?? summary.eligible ?? 0}</strong></div>
      <div><span>跳过</span><strong>${summary.skipped ?? 0}</strong></div>
      <div><span>失败</span><strong>${summary.failed ?? 0}</strong></div>
      <div><span>待确认</span><strong>${summary.pending ?? 0}</strong></div>
      <div><span>状态</span><strong>${escapeHtml(openSeaStatusLabel(job.status))}</strong></div>
    </div>
    <div class="table-scroll opensea-plan-table"><table>
      <thead><tr><th>状态</th><th>钱包 / 地址</th><th>目标 / Selector</th><th>数量 / 金额</th><th>Gas / 总需求</th><th>交易</th></tr></thead>
      <tbody>${(job.wallets || []).map((wallet) => {
        const transaction = wallet.transaction || {};
        const status = wallet.status || wallet.preflightStatus;
        return `<tr>
          <td><span class="status ${openSeaStatusClass(status)}">${escapeHtml(openSeaStatusLabel(status))}</span>${wallet.reason ? `<small class="row-error">${escapeHtml(wallet.reason)}</small>` : ''}</td>
          <td><strong>${escapeHtml(wallet.walletId || '-')}</strong><code>${escapeHtml(shortAddress(wallet.address))}</code></td>
          <td><code>${escapeHtml(transaction.to || '-')}</code><small>${escapeHtml(transaction.selector || '-')}</small></td>
          <td><strong>${escapeHtml(job.quantity || '-')}</strong><code>${escapeHtml(transaction.valueEth || '0')} ${escapeHtml(chain.nativeSymbol)}</code></td>
          <td><strong>${escapeHtml(wallet.gasLimit || wallet.estimatedGas || '-')}</strong><code>Gas ${escapeHtml(wallet.estimatedFeeEth || '-')} ${escapeHtml(chain.nativeSymbol)}</code><small>总需求 ${escapeHtml(wallet.estimatedTotalEth || '-')} ${escapeHtml(chain.nativeSymbol)} · ${wallet.feeModel === 'eip1559' ? 'EIP-1559' : 'Legacy'}</small></td>
          <td><code title="${escapeHtml(wallet.txHash || '')}">${escapeHtml(wallet.txHash ? shortAddress(wallet.txHash) : '尚未发送')}</code></td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="empty-cell">当前预览没有钱包计划</td></tr>'}</tbody>
    </table></div>
  `;
}

async function sendOpenSeaJob(form, render) {
  if (!form.job?.id || !form.job?.confirmationToken) throw new Error('请先生成有效的交易预览')
  const count = form.job.summary?.ready ?? form.job.summary?.eligible ?? 0
  if (!window.confirm(`确认发送 ${count} 个钱包的 OpenSea 铸造交易？`)) return null
  const result = await api('/api/nft-mint/send', {
    method: 'POST',
    body: JSON.stringify({ jobId: form.job.id, confirmationToken: form.job.confirmationToken }),
  })
  form.job = result.job
  startOpenSeaPolling(form, render)
  return result
}

function renderOpenSeaPanel({ state, render, action }) {
  const form = action.openSea;
  const chain = currentChain(state);
  startOpenSeaPolling(form, render);
  return {
    html: `
      <section class="opensea-quick-panel">
        <div class="opensea-quick-fields">
          <label class="field"><span>NFT 合约地址</span><input name="openseaContractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="从左侧事件自动填入，或输入 0x..." spellcheck="false"></label>
          <div class="form-grid three">
            <label class="field"><span>每钱包数量</span><input name="openseaQuantity" type="number" min="1" max="1000" value="${escapeHtml(form.quantity)}" inputmode="numeric"></label>
            <label class="field"><span>Token ID</span><input name="openseaTokenId" value="${escapeHtml(form.tokenId)}" inputmode="numeric"></label>
            <label class="field"><span>并发钱包数</span><input name="openseaConcurrency" type="number" min="0" max="20" value="${escapeHtml(form.concurrency)}" inputmode="numeric"></label>
          </div>
          <label class="field"><span>最大铸造金额（${escapeHtml(chain.nativeSymbol)}，可选）</span><input name="openseaMaxMintCostEth" value="${escapeHtml(form.maxMintCostEth)}" placeholder="留空表示不设上限" inputmode="decimal"></label>
        </div>
        <section class="data-panel opensea-wallet-panel"><header><h2>执行钱包</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'opensea-quick')}${walletTable(state, form.walletIds, { inputName: 'openseaWallet', compact: true })}</section>
        ${form.error ? `<div class="inline-alert">${escapeHtml(form.error)}</div>` : ''}
        <div class="opensea-quick-actions"><button class="button secondary" id="opensea-quick-preview" type="button" ${form.busy ? 'disabled' : ''}>${form.busy ? '正在请求报价' : '生成预览'}</button><button class="button primary" id="opensea-quick-direct" type="button" ${form.busy ? 'disabled' : ''}>直接发送</button><button class="button" id="opensea-quick-send" type="button" ${form.job?.status === 'previewed' && form.job?.confirmationToken ? '' : 'disabled'}>确认并发送</button></div>
        <section class="preview-panel opensea-job-panel"><header><h2>OpenSea 任务计划</h2>${form.job ? `<span class="status ${openSeaStatusClass(form.job.status)}">${escapeHtml(openSeaStatusLabel(form.job.status))}</span>` : ''}</header>${openSeaJobSummary(form.job, chain)}</section>
      </section>
    `,
    bind(root) {
      for (const name of ['openseaContractAddress', 'openseaQuantity', 'openseaTokenId', 'openseaConcurrency', 'openseaMaxMintCostEth']) {
        const input = root.querySelector(`[name="${name}"]`);
        input?.addEventListener('input', () => {
          const key = name.replace(/^opensea/, '').replace(/^./, (value) => value.toLowerCase());
          form[key] = input.value;
          form.job = null;
          form.error = '';
        });
      }
      bindWalletTable(root, state, form.walletIds, {
        inputName: 'openseaWallet',
        render,
        onChange: () => { form.job = null; form.error = ''; },
      });
      root.querySelector('#opensea-quick-preview')?.addEventListener('click', () => {
        if (form.busy) return;
        form.busy = true;
        form.error = '';
        render();
        void api('/api/nft-mint/preview', { method: 'POST', body: JSON.stringify(openSeaPayload(form, state)) })
          .then((result) => {
            form.job = result.job;
            toast('OpenSea 真实预览已生成');
          })
          .catch((error) => {
            form.error = error.message;
            toast(error.message, 'error');
          })
          .finally(() => {
            form.busy = false;
            render();
          });
      });
      root.querySelector('#opensea-quick-send')?.addEventListener('click', () => {
        if (form.busy || !form.job?.confirmationToken) return;
        form.busy = true;
        form.error = '';
        render();
        void sendOpenSeaJob(form, render)
          .then((result) => { if (result) toast('OpenSea 铸造任务已提交'); })
          .catch((error) => {
            form.error = error.message;
            toast(error.message, 'error');
          })
          .finally(() => {
            form.busy = false;
            render();
          });
      });
      root.querySelector('#opensea-quick-direct')?.addEventListener('click', () => {
        if (form.busy) return;
        form.busy = true;
        form.error = '';
        render();
        const preview = form.job?.status === 'previewed' && form.job?.confirmationToken
          ? Promise.resolve({ job: form.job })
          : api('/api/nft-mint/preview', { method: 'POST', body: JSON.stringify(openSeaPayload(form, state)) });
        void preview
          .then((result) => {
            form.job = result.job;
            return sendOpenSeaJob(form, render);
          })
          .then((result) => { if (result) toast('OpenSea 铸造任务已提交'); })
          .catch((error) => {
            form.error = error.message;
            toast(error.message, 'error');
          })
          .finally(() => {
            form.busy = false;
            render();
          });
      });
    },
  };
}

export function renderMintActionPanel({ state, render, event = null, readOnly = false }) {
  const transactionState = { ...state, chainId: writeChainId(state) };
  const action = state.page.mintAction ||= createMintActionState(transactionState);
  prepareMintAction(action, transactionState, event);
  const renderWithScroll = () => {
    const currentPanel = document.querySelector('.mint-action-panel');
    if (currentPanel) action.scrollTop = currentPanel.scrollTop;
    render();
  };
  const mode = action.mode;
  const inner = mode === 'opensea'
    ? renderOpenSeaPanel({ state: transactionState, render: renderWithScroll, action })
    : renderAdvancedMintPanel({ state: transactionState, render: renderWithScroll }, {
      form: action.advanced,
      title: mode === 'hex' ? 'Hex 模式' : 'ABI 方法',
      embedded: true,
      hideModeTabs: true,
      inputName: 'mintActionWallet',
      idPrefix: 'mint-action-advanced',
    });
  return {
    html: `
      <aside class="mint-action-panel" aria-label="NFT 铸造动作面板">
        <nav class="mint-action-tabs" role="tablist" aria-label="快速 Mint 模式">
          <button type="button" role="tab" data-mint-action-mode="method" class="${mode === 'method' ? 'active' : ''}">ABI 方法</button>
          <button type="button" role="tab" data-mint-action-mode="hex" class="${mode === 'hex' ? 'active' : ''}">Hex 模式</button>
          <button type="button" role="tab" data-mint-action-mode="opensea" class="${mode === 'opensea' ? 'active' : ''}">OpenSea 快速</button>
        </nav>
        <div class="mint-action-body ${readOnly ? 'is-read-only' : ''}" aria-disabled="${String(readOnly)}">${readOnly ? '<div class="live-stream-notice action-read-only-notice">网络快照确认前，铸造动作暂时只读。</div>' : ''}${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}${inner.html}</div>
      </aside>
    `,
    bind(root) {
      const panel = root.querySelector('.mint-action-panel');
      if (panel) {
        panel.scrollTop = action.scrollTop;
        panel.addEventListener('scroll', () => { action.scrollTop = panel.scrollTop; }, { passive: true });
      }
      root.querySelectorAll('[data-mint-action-mode]').forEach((button) => button.addEventListener('click', () => {
        action.mode = button.dataset.mintActionMode;
        if (action.mode !== 'opensea') action.advanced.mode = action.mode;
        renderWithScroll();
      }));
      inner.bind?.(root);
      if (readOnly) root.querySelectorAll('.mint-action-body.is-read-only .advanced-toolbar button, .mint-action-body.is-read-only .advanced-layout input, .mint-action-body.is-read-only .advanced-layout select, .mint-action-body.is-read-only .advanced-layout textarea, .mint-action-body.is-read-only .advanced-settings input, .mint-action-body.is-read-only .advanced-settings select, .mint-action-body.is-read-only .advanced-settings textarea').forEach((control) => { control.disabled = true; });
    },
  };
}
