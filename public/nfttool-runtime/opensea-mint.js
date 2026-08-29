import {
  api,
  escapeHtml,
  networkBar,
  renderTaskResult,
  runAction,
  shortAddress,
  writeChain,
  writeChainId,
  writeProfileId,
  writeProfileRef,
} from './core.js';
import { bindWalletTable, walletGroupBar, walletTable } from './components.js';

const STAGE_STATUS = {
  live: ['进行中', 'success'],
  not_started: ['未开始', ''],
  ended: ['已结束', ''],
  unconfigured: ['未配置', 'danger'],
};

const WALLET_STATUS = {
  eligible: ['可执行', 'success'],
  upcoming: ['待开始', ''],
  unknown: ['资格未知', ''],
  ineligible: ['不可执行', 'danger'],
};

const SALE_MODES = [
  ['auto', '自动识别'],
  ['public', '公开'],
  ['allowlist', 'Allowlist'],
  ['signed', 'Signed'],
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function freshOpenSeaForm() {
  return {
    target: '',
    contractAddress: '',
    slug: '',
    quantity: '1',
    concurrency: '2',
    saleMode: 'auto',
    executionMode: 'immediate',
    scheduleAt: '',
    stageUuid: '',
    walletIds: new Set(),
    target_: null,
    intelligence: null,
    preview: null,
    result: null,
  };
}

function statusCell(map, value) {
  const [label, tone] = map[value] || [value || '-', ''];
  return `<span class="${tone ? `${tone}-text` : ''}">${escapeHtml(label)}</span>`;
}

// A SeaDrop stage read straight off the singleton looks configured even for a
// contract that never used SeaDrop: getPublicDrop(anything) returns zeroes rather
// than reverting. The honest signals are the stage status and the creator payout,
// never the protocol label, so mintability is decided on those.
function targetPanel(form) {
  if (!form.intelligence) return '<div class="empty-state">先解析一个 OpenSea 合集或合约地址</div>';
  const info = form.intelligence;
  const unconfigured = info.creatorPayout === ZERO_ADDRESS || info.creatorPayout === null;
  return `
    <div class="plan-summary">
      <div><span>名称</span><strong>${escapeHtml(info.name || '-')}</strong></div>
      <div><span>Symbol</span><strong>${escapeHtml(info.symbol || '-')}</strong></div>
      <div><span>供应</span><strong>${escapeHtml(String(info.currentSupply ?? '-'))}${info.maxSupply ? ` / ${escapeHtml(String(info.maxSupply))}` : ''}</strong></div>
      <div><span>剩余</span><strong>${escapeHtml(String(info.supplyLeft ?? '-'))}</strong></div>
    </div>
    ${unconfigured ? '<div class="empty-state">该合约没有配置 SeaDrop creator payout，链上读到的阶段全部无效，不要按可铸处理</div>' : ''}
    ${info.openSeaError ? `<div class="empty-state">OpenSea 阶段目录不可用：${escapeHtml(info.openSeaError)}</div>` : ''}
    ${info.seaDropError ? `<div class="empty-state">SeaDrop 链上读取失败：${escapeHtml(info.seaDropError)}</div>` : ''}
  `;
}

function stageTable(form) {
  const stages = form.intelligence?.stages || [];
  if (!stages.length) return '<div class="empty-state">没有读到任何销售阶段</div>';
  return `
    <div class="table-scroll compact-table">
      <table>
        <thead><tr><th>阶段</th><th>类型</th><th>状态</th><th>价格</th><th>钱包上限</th><th>时间</th><th></th></tr></thead>
        <tbody>${stages.map((stage) => `
          <tr>
            <td>${escapeHtml(stage.label || stage.id)}</td>
            <td>${escapeHtml(stage.type || '-')}</td>
            <td>${statusCell(STAGE_STATUS, stage.status)}</td>
            <td class="mono">${escapeHtml(stage.mintPriceEth ?? '-')}</td>
            <td class="mono">${escapeHtml(String(stage.maxTotalMintableByWallet ?? '-'))}</td>
            <td class="mono">${escapeHtml(stage.startAt ? new Date(stage.startAt).toLocaleString('zh-CN') : '-')}</td>
            <td><button class="button secondary" type="button" data-stage-pick="${escapeHtml(stage.id)}" data-stage-type="${escapeHtml(stage.type || '')}" data-stage-uuid="${escapeHtml(stage.uuid || '')}">选用</button></td>
          </tr>
        `).join('')}</tbody>
      </table>
    </div>
  `;
}

function eligibilityTable(form) {
  const wallets = form.intelligence?.wallets || [];
  if (!wallets.length) return '';
  return `
    <div class="table-scroll compact-table">
      <table>
        <thead><tr><th>钱包</th><th>资格</th><th>推荐阶段</th></tr></thead>
        <tbody>${wallets.map((wallet) => `
          <tr>
            <td class="mono">${escapeHtml(shortAddress(wallet.address))}</td>
            <td>${statusCell(WALLET_STATUS, wallet.status)}</td>
            <td>${escapeHtml(wallet.recommendedStageId || '-')}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    </div>
  `;
}

function previewPanel(form) {
  if (!form.preview) return '<div class="empty-state">尚未生成预览</div>';
  const preview = form.preview;
  const rows = preview.wallets || [];
  // Build a map from stage UUID to stage label for display
  const stages = form.intelligence?.stages || [];
  const stageMap = Object.fromEntries(stages.map((s) => [s.uuid, s.label || s.id]));
  const hasStageInfo = rows.some((row) => row.openSeaStageUuid);
  return `
    <div class="plan-summary">
      <div><span>路线</span><strong>${escapeHtml(preview.mintRoute || '-')}</strong></div>
      <div><span>销售模式</span><strong>${escapeHtml(preview.saleMode || '-')}</strong></div>
      <div><span>可执行</span><strong>${rows.filter((row) => row.status === 'ready').length} / ${rows.length}</strong></div>
      <div><span>预计总额</span><strong class="mono">${escapeHtml(preview.estimatedTotalEth || '-')}</strong></div>
      ${preview.scheduledAt ? `<div><span>定时</span><strong>${escapeHtml(new Date(preview.scheduledAt).toLocaleString('zh-CN'))}</strong></div>` : ''}
    </div>
    ${preview.routeReason ? `<div class="empty-state">${escapeHtml(preview.routeReason)}</div>` : ''}
    <div class="table-scroll compact-table">
      <table>
        <thead><tr><th>#</th><th>钱包</th><th>状态</th>${hasStageInfo ? '<th>阶段</th>' : ''}<th>金额</th><th>说明</th></tr></thead>
        <tbody>${rows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td class="mono">${escapeHtml(shortAddress(row.address))}</td>
            <td class="${row.status === 'ready' ? 'success-text' : 'danger-text'}">${escapeHtml(row.status)}</td>
            ${hasStageInfo ? `<td>${escapeHtml(stageMap[row.openSeaStageUuid] || row.openSeaStageUuid || '-')}</td>` : ''}
            <td class="mono">${escapeHtml(row.transaction?.valueEth ?? '-')}</td>
            <td class="mono">${escapeHtml(row.reason || row.error || row.transaction?.selector || '')}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    </div>
  `;
}

export function renderOpenSeaMint({ state, render }) {
  const form = state.page.openSeaMint ||= freshOpenSeaForm();
  const chain = writeChain(state);
  const scheduled = form.executionMode === 'scheduled';
  const invalidate = () => {
    form.preview = null;
    form.result = null;
  };
  return {
    html: `
      ${networkBar({ state, includeAsset: false })}
      <section class="launchpad-bar">
        <label class="field"><span>合集 / 合约</span><input name="target" value="${escapeHtml(form.target)}" placeholder="https://opensea.io/collection/... 或 0x..." spellcheck="false"></label>
        <button class="button secondary" id="resolve-opensea" type="button">解析并读取阶段</button>
        <span>${form.target_ ? escapeHtml(`${form.target_.name || shortAddress(form.target_.contractAddress)} · ${form.target_.source}`) : ''}</span>
      </section>
      <section class="preview-panel"><header><h2>合集情报</h2><span>${escapeHtml(chain.name)}</span></header>${targetPanel(form)}${form.intelligence ? stageTable(form) : ''}${eligibilityTable(form)}</section>
      <div class="launchpad-layout">
        <section class="data-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'opensea-mint')}${walletTable(state, form.walletIds, { inputName: 'openSeaMintWallet', compact: true })}</section>
        <form class="form-panel">
          <header><h2>铸造参数</h2><span>${escapeHtml(chain.nativeSymbol)}</span></header>
          <label class="field"><span>合约地址</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="解析后自动填入" spellcheck="false"></label>
          <div class="form-grid two">
            <label class="field"><span>数量</span><input name="quantity" type="number" min="1" value="${escapeHtml(form.quantity)}"></label>
            <label class="field"><span>并发</span><input name="concurrency" type="number" min="1" value="${escapeHtml(form.concurrency)}"></label>
          </div>
          <label class="field"><span>销售阶段</span><select name="saleMode">${SALE_MODES.map(([value, label]) => `<option value="${value}" ${form.saleMode === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
          <div class="fee-strip">
            <label class="toggle"><input name="scheduled" type="checkbox" ${scheduled ? 'checked' : ''}><span>定时抢铸</span></label>
            <label class="compact-field"><span>开售时间</span><input name="scheduleAt" type="datetime-local" value="${escapeHtml(form.scheduleAt)}" ${scheduled ? '' : 'disabled'}></label>
          </div>
          <footer>
            <button class="button secondary" id="preview-opensea" type="button">生成预览</button>
            <button class="button primary" id="send-opensea" type="button" ${form.preview?.confirmation ? '' : 'disabled'}>${scheduled ? '武装定时任务' : '开始铸造'}</button>
          </footer>
        </form>
      </div>
      <section class="preview-panel"><header><h2>铸造预览</h2></header>${previewPanel(form)}</section>
      <section class="preview-panel"><header><h2>执行结果</h2></header>${form.result ? renderTaskResult(form.result) : '<div class="empty-state">尚未执行</div>'}</section>
    `,
    bind(root) {
      for (const name of ['target', 'contractAddress', 'quantity', 'concurrency', 'scheduleAt']) {
        const input = root.querySelector(`[name="${name}"]`);
        input?.addEventListener('input', () => {
          form[name] = input.value;
          invalidate();
        });
      }
      root.querySelector('[name="saleMode"]')?.addEventListener('change', (event) => {
        form.saleMode = event.target.value;
        invalidate();
        render();
      });
      root.querySelector('[name="scheduled"]')?.addEventListener('change', (event) => {
        form.executionMode = event.target.checked ? 'scheduled' : 'immediate';
        invalidate();
        render();
      });
      bindWalletTable(root, state, form.walletIds, { inputName: 'openSeaMintWallet', render, onChange: invalidate });
      root.querySelectorAll('[data-stage-pick]').forEach((button) => button.addEventListener('click', () => {
        const stageId = button.dataset.stagePick;
        const type = button.dataset.stageType;
        const stageUuid = button.dataset.stageUuid || '';
        form.saleMode = ['public', 'allowlist', 'signed'].includes(type) ? type : 'auto';
        form.stageUuid = stageUuid;

        // Auto-filter wallets: keep only those whose recommendedStageId matches the selected stage
        if (form.intelligence?.wallets && stageId) {
          const eligibleAddresses = new Set(
            form.intelligence.wallets
              .filter((w) => w.recommendedStageId === stageId)
              .map((w) => w.address.toLowerCase())
          );

          const originalCount = form.walletIds.size;

          // Filter form.walletIds to keep only eligible wallets
          const eligibleWalletIds = [...form.walletIds].filter((walletId) => {
            const wallet = state.wallets.find((w) => w.id === walletId);
            return wallet && eligibleAddresses.has(wallet.address.toLowerCase());
          });

          // Update the selection
          form.walletIds.clear();
          eligibleWalletIds.forEach((id) => form.walletIds.add(id));

          if (eligibleWalletIds.length === 0) {
            toast('该阶段没有符合资格的钱包', 'warning');
          } else if (eligibleWalletIds.length < originalCount) {
            toast(`已自动过滤，保留 ${eligibleWalletIds.length} 个符合该阶段的钱包`, 'success');
          }
        }

        invalidate();
        render();
      }));
      root.querySelector('#resolve-opensea')?.addEventListener('click', () => void runAction(async () => {
        const result = await api('/api/opensea-mint/resolve', { method: 'POST', body: JSON.stringify({
          chainId: writeChainId(state),
          target: form.target,
          walletIds: [...form.walletIds],
          quantity: form.quantity,
          rpcProfileId: writeProfileId(state),
          rpcProfileRef: writeProfileRef(state),
        }) });
        form.target_ = result.target;
        form.intelligence = result.intelligence;
        form.contractAddress = result.target.contractAddress || form.contractAddress;
        form.slug = result.target.slug || '';
        invalidate();
        return result;
      }, { success: '合集阶段已读取' }));
      root.querySelector('#preview-opensea')?.addEventListener('click', () => void runAction(async () => {
        try {
          const result = await api('/api/opensea-mint/preview', { method: 'POST', body: JSON.stringify({
            chainId: writeChainId(state),
            contractAddress: form.contractAddress,
            walletIds: [...form.walletIds],
            quantity: form.quantity,
            concurrency: form.concurrency,
            saleMode: form.saleMode,
            executionMode: form.executionMode,
            scheduleAt: form.executionMode === 'scheduled' ? form.scheduleAt : null,
            openSeaStageUuid: form.stageUuid,
            slug: form.slug,
            rpcProfileId: writeProfileId(state),
            rpcProfileRef: writeProfileRef(state),
          }) });
          form.preview = result;
          form.result = null;
          return result;
        } catch (error) {
          // If the request succeeded (HTTP 200) but returned ok: false, the response
          // body is in error.details. Treat this as a successful preview with no
          // executable wallets rather than a hard failure.
          if (error.status === 200 && error.details && typeof error.details === 'object') {
            form.preview = error.details;
            form.result = null;
            return error.details;
          }
          throw error;
        }
      }, { success: '铸造预览已生成' }));
      root.querySelector('#send-opensea')?.addEventListener('click', () => {
        const confirmation = form.preview?.confirmation;
        if (!confirmation) return;
        const ready = (form.preview.wallets || []).filter((row) => row.status === 'ready').length;
        const question = scheduled
          ? `确认武装定时任务？开售时将自动为 ${ready} 个钱包广播交易。`
          : `确认立即为 ${ready} 个钱包广播铸造交易？预计总额 ${form.preview.estimatedTotalEth || '-'} ${chain.nativeSymbol}。`;
        if (!window.confirm(question)) return;
        void runAction(async () => {
          const result = await api('/api/opensea-mint/send', { method: 'POST', body: JSON.stringify({
            previewId: confirmation.previewId,
            confirmationToken: confirmation.confirmationToken,
          }) });
          form.result = result;
          // The credential is single use, so the button must not stay armed.
          form.preview = { ...form.preview, confirmation: null };
          return result;
        }, { success: scheduled ? '定时任务已武装' : '铸造任务已提交' });
      });
    },
  };
}
