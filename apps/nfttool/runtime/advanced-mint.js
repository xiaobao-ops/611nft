import { api, escapeHtml, networkBar, runAction, shortAddress, toast, writeChain, writeChainId, writeProfileId, writeProfileRef } from './core.js';
import {
  bindWalletTable,
  selectedWalletSet,
  statusClass,
  statusLabel,
  walletGroupBar,
  walletTable,
} from './components.js';

const ADVANCED_ACTIVE = new Set(['scheduled', 'running', 'stopping', 'confirmation_pending', 'partial']);

function methodParameterTypes(signature) {
  const source = String(signature || '').replace(/^\s*function\s+/, '');
  const start = source.indexOf('(');
  if (start < 1) return [];
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '(' || source[index] === '[') depth += 1;
    if (source[index] === ')' || source[index] === ']') depth -= 1;
    if (source[index] === ')' && depth === 0) {
      end = index;
      break;
    }
  }
  if (end < 0) return [];
  const body = source.slice(start + 1, end).trim();
  if (!body) return [];
  const output = [];
  let item = '';
  depth = 0;
  for (const character of body) {
    if (character === '(' || character === '[') depth += 1;
    if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      output.push(item.trim());
      item = '';
    } else item += character;
  }
  output.push(item.trim());
  return output;
}

export function createAdvancedForm(state, preset = {}) {
  const importedContract = localStorage.getItem('nfttool:advanced-contract') || '';
  if (importedContract) localStorage.removeItem('nfttool:advanced-contract');
  return {
    walletIds: selectedWalletSet(state),
    contractAddress: importedContract,
    mode: 'method',
    methodSignature: preset.methodSignature || 'mint(uint256)',
    parameters: ['1'],
    calldata: '0x',
    replaceWallet: false,
    valueEth: '0',
    rounds: '1',
    frequencyMs: '400',
    executionMode: 'sequential',
    waitMode: 'confirmed',
    scheduleAt: '',
    preflight: true,
    allowGasFailure: false,
    autoGas: true,
    gasLimit: '120000',
    gasMultiplier: '1.3',
    autoFee: true,
    eip1559: true,
    gasPriceGwei: '',
    maxFeeGwei: '',
    priorityFeeGwei: '',
    prefetchNonce: true,
    job: null,
    pollTimer: null,
    ...preset,
  };
}

export function advancedMintPayload(form, state) {
  return {
    chainId: writeChainId(state),
    rpcProfileId: writeProfileId(state),
    rpcProfileRef: writeProfileRef(state),
    walletIds: [...form.walletIds],
    contractAddress: form.contractAddress,
    mode: form.mode,
    methodSignature: form.methodSignature,
    parameters: form.parameters,
    calldata: form.calldata,
    replaceWallet: form.replaceWallet,
    valueEth: form.valueEth,
    rounds: form.rounds,
    frequencyMs: form.frequencyMs,
    executionMode: form.executionMode,
    waitMode: form.waitMode,
    scheduleAt: form.scheduleAt,
    preflight: form.preflight,
    allowGasFailure: form.allowGasFailure,
    autoGas: form.autoGas,
    gasLimit: form.gasLimit,
    autoFee: form.autoFee,
    eip1559: form.eip1559,
    gasPriceGwei: form.gasPriceGwei,
    maxFeeGwei: form.maxFeeGwei,
    priorityFeeGwei: form.priorityFeeGwei,
    prefetchNonce: form.prefetchNonce,
  };
}

function jobSummary(job) {
  if (!job) return '<div class="empty-state">尚未生成任务预览</div>';
  const summary = job.summary || {};
  return `
    <div class="plan-summary advanced-summary">
      <div><span>账号</span><strong>${summary.wallets ?? job.wallets?.length ?? 0}</strong></div>
      <div><span>计划交易</span><strong>${summary.plannedTransactions ?? 0}</strong></div>
      <div><span>Pending</span><strong>${summary.pending ?? 0}</strong></div>
      <div><span>成功</span><strong>${summary.confirmed ?? 0}</strong></div>
      <div><span>失败</span><strong>${summary.failed ?? 0}</strong></div>
      <div><span>状态</span><strong>${escapeHtml(statusLabel(job.status))}</strong></div>
    </div>
    <div class="table-scroll advanced-plan-table"><table>
      <thead><tr><th>状态</th><th>钱包 / Nonce</th><th>方法 / Selector</th><th>Gas / Fee</th><th>金额</th><th>交易</th></tr></thead>
      <tbody>${(job.wallets || []).map((wallet) => {
        const result = [...(job.results || [])].reverse().find((row) => row.walletId === wallet.walletId);
        const status = result?.status || wallet.preflightStatus;
        return `<tr><td><span class="status ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span>${wallet.error ? `<small class="row-error">${escapeHtml(wallet.error)}</small>` : ''}</td><td><strong>${escapeHtml(wallet.walletId)}</strong><code>${escapeHtml(result?.nonce ?? wallet.nonce ?? '自动')}</code></td><td><strong>${escapeHtml(wallet.method || '-')}</strong><code>${escapeHtml(wallet.selector || '-')}</code></td><td><strong>${escapeHtml(wallet.gas || '自动')}</strong><code>${escapeHtml(wallet.maxFeePerGas || wallet.gasPrice || '自动')}</code></td><td><code>${escapeHtml(wallet.valueWei || '0')} wei</code></td><td><code title="${escapeHtml(result?.txHash || '')}">${escapeHtml(result?.txHash ? shortAddress(result.txHash) : '尚未发送')}</code></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="empty-cell">当前预览没有钱包计划</td></tr>'}</tbody>
    </table></div>
  `;
}

function jobLogs(job) {
  const logs = job?.logs || [];
  return `
    <div class="advanced-log-tabs"><button class="active" type="button">info(${logs.length})</button><span>pending(${job?.summary?.pending || 0})</span><span>成功(${job?.summary?.confirmed || 0})</span><span>失败(${job?.summary?.failed || 0})</span></div>
    <div class="advanced-log-body" role="log">
      ${logs.map((entry) => `<div class="${escapeHtml(entry.level || '')}"><time>${escapeHtml(new Date(entry.at).toLocaleTimeString('zh-CN'))}</time><strong>${escapeHtml(entry.level || 'info')}</strong><span>${escapeHtml(entry.message || '')}</span>${entry.details?.txHash ? `<code>${escapeHtml(shortAddress(entry.details.txHash))}</code>` : ''}</div>`).join('') || '<div class="empty-state">尚未生成任务日志</div>'}
    </div>
  `;
}

function parameterFields(form) {
  const types = methodParameterTypes(form.methodSignature);
  if (form.parameters.length !== types.length) {
    form.parameters = types.map((_, index) => form.parameters[index] ?? '');
  }
  return types.map((type, index) => `
    <label class="field parameter-field"><span>${escapeHtml(type)}:</span><input data-parameter="${index}" value="${escapeHtml(form.parameters[index])}" placeholder="${type.includes('address') ? '& 或 {wallet}' : '参数值'}" spellcheck="false"></label>
  `).join('');
}

function startPolling(form, render) {
  if (!form.job?.id || form.pollTimer || !ADVANCED_ACTIVE.has(form.job.status)) return;
  form.pollTimer = window.setInterval(async () => {
    if (form.pollInFlight) return;
    form.pollInFlight = true;
    try {
      const result = await api(`/api/advanced-mint/jobs/${encodeURIComponent(form.job.id)}`);
      form.job = { ...result.job, confirmation: form.job.confirmation };
      render();
      if (!ADVANCED_ACTIVE.has(form.job.status)) {
        window.clearInterval(form.pollTimer);
        form.pollTimer = null;
      }
    } catch (error) {
      window.clearInterval(form.pollTimer);
      form.pollTimer = null;
      toast(error.message, 'error');
    } finally {
      form.pollInFlight = false;
    }
  }, 2000);
}

function bindAdvancedFields(root, form, render) {
  const rerender = new Set(['autoGas', 'autoFee', 'eip1559', 'waitMode']);
  const names = [
    'contractAddress', 'methodSignature', 'calldata', 'replaceWallet', 'valueEth', 'rounds',
    'frequencyMs', 'executionMode', 'waitMode', 'scheduleAt', 'preflight', 'allowGasFailure',
    'autoGas', 'gasLimit', 'gasMultiplier', 'autoFee', 'eip1559', 'gasPriceGwei',
    'maxFeeGwei', 'priorityFeeGwei', 'prefetchNonce',
  ];
  for (const name of names) {
    const input = root.querySelector(`[name="${name}"]`);
    if (!input) continue;
    const eventName = name === 'methodSignature' ? 'change' : input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      form[name] = input.type === 'checkbox' ? input.checked : input.value;
      form.job = null;
      if (name === 'waitMode' && form.waitMode === 'zero-block') form.autoGas = false;
      if (rerender.has(name) || name === 'methodSignature') render();
    });
  }
  root.querySelectorAll('[data-parameter]').forEach((input) => input.addEventListener('input', () => {
    form.parameters[Number(input.dataset.parameter)] = input.value;
    form.job = null;
  }));
}

export function renderAdvancedMintPanel({ state, render }, {
  form,
  title = 'Mint 高级版',
  embedded = false,
  hideModeTabs = false,
  inputName = 'advancedWallet',
  idPrefix = 'advanced',
} = {}) {
  const chain = writeChain(state);
  startPolling(form, render);
  const id = (name) => `${idPrefix}-${name}`;
  return {
    html: `
      <div class="advanced-toolbar ${embedded ? 'embedded-advanced-toolbar' : ''}">
        <span>${escapeHtml(title)}</span>
        <div class="toolbar-spacer"></div>
        <button class="button secondary" id="${id('preview')}" type="button">生成预览</button>
        <button class="button primary" id="${id('direct')}" type="button" ${form.job?.status && form.job.status !== 'previewed' ? 'disabled' : ''}>直接发送</button>
        <button class="button primary" id="${id('execute')}" type="button" ${form.job?.status === 'previewed' ? '' : 'disabled'}>开始任务</button>
        <button class="button danger" id="${id('stop')}" type="button" ${ADVANCED_ACTIVE.has(form.job?.status) ? '' : 'disabled'}>停止</button>
        <button class="button" id="${id('accelerate')}" type="button" ${form.job?.summary?.pending ? '' : 'disabled'}>加速</button>
        <button class="button" id="${id('cancel')}" type="button" ${form.job?.summary?.pending ? '' : 'disabled'}>取消订单</button>
      </div>
      <div class="advanced-layout ${embedded ? 'embedded-advanced-layout' : ''}">
        <section class="data-panel advanced-wallet-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, idPrefix)}${walletTable(state, form.walletIds, { inputName, compact: true })}</section>
        <section class="form-panel advanced-call-panel">
          <header><h2>合约调用</h2>${hideModeTabs ? '' : `<div class="segmented"><button type="button" data-mode="method" class="${form.mode === 'method' ? 'active' : ''}">ABI 方法</button><button type="button" data-mode="hex" class="${form.mode === 'hex' ? 'active' : ''}">Hex 模式</button></div>`}</header>
          <label class="field"><span>合约地址</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="0x..." spellcheck="false"></label>
          ${form.mode === 'method' ? `
            <label class="field"><span>选择方法（地址部分请输入 &amp; 替代）</span><input name="methodSignature" value="${escapeHtml(form.methodSignature)}" placeholder="mint(address,uint256)" spellcheck="false"></label>
            <div class="advanced-parameters">${parameterFields(form)}</div>
          ` : `
            <label class="field"><span>Hex</span><textarea name="calldata" rows="6" spellcheck="false">${escapeHtml(form.calldata)}</textarea></label>
            <label class="toggle field-toggle"><input name="replaceWallet" type="checkbox" ${form.replaceWallet ? 'checked' : ''}><span>替换 &amp; / {wallet} 地址</span></label>
          `}
          <div class="form-grid three">
            <label class="field"><span>金额(${escapeHtml(chain.nativeSymbol)})</span><input name="valueEth" value="${escapeHtml(form.valueEth)}" inputmode="decimal"></label>
            <label class="field"><span>次数</span><input name="rounds" type="number" min="1" value="${escapeHtml(form.rounds)}"></label>
            <label class="field"><span>限制频率(ms)</span><input name="frequencyMs" type="number" min="50" value="${escapeHtml(form.frequencyMs)}"></label>
          </div>
        </section>
      </div>
      <section class="advanced-settings">
        <div class="advanced-setting-row">
          <label class="compact-field"><span>发送模式</span><select name="executionMode"><option value="sequential" ${form.executionMode === 'sequential' ? 'selected' : ''}>普通模式</option><option value="burst" ${form.executionMode === 'burst' ? 'selected' : ''}>并发模式</option></select></label>
          <label class="compact-field"><span>确认模式</span><select name="waitMode"><option value="confirmed" ${form.waitMode === 'confirmed' ? 'selected' : ''}>等待确认</option><option value="zero-block" ${form.waitMode === 'zero-block' ? 'selected' : ''}>0 块</option></select></label>
          <label class="compact-field"><span>定时</span><input name="scheduleAt" type="datetime-local" value="${escapeHtml(form.scheduleAt)}"></label>
          <label class="toggle"><input name="preflight" type="checkbox" ${form.preflight ? 'checked' : ''}><span>交易前检查</span></label>
          <label class="toggle"><input name="prefetchNonce" type="checkbox" ${form.prefetchNonce ? 'checked' : ''}><span>提前获取 Nonce</span></label>
          <label class="toggle"><input name="allowGasFailure" type="checkbox" ${form.allowGasFailure ? 'checked' : ''}><span>允许低 Gas</span></label>
        </div>
        <div class="advanced-setting-row gas-row">
          <label class="toggle"><input name="autoGas" type="checkbox" ${form.autoGas ? 'checked' : ''} ${form.waitMode === 'zero-block' ? 'disabled' : ''}><span>Gas Limit 自动</span></label>
          <label class="compact-field"><span>Limit</span><input name="gasLimit" value="${escapeHtml(form.gasLimit)}" ${form.autoGas ? 'disabled' : ''} inputmode="numeric"></label>
          <label class="compact-field"><span>自动倍数</span><input name="gasMultiplier" value="${escapeHtml(form.gasMultiplier)}" disabled></label>
          <label class="toggle"><input name="autoFee" type="checkbox" ${form.autoFee ? 'checked' : ''}><span>Gas Fee 自动</span></label>
          <label class="toggle"><input name="eip1559" type="checkbox" ${form.eip1559 ? 'checked' : ''}><span>EIP-1559</span></label>
          ${form.eip1559 ? `<label class="compact-field"><span>Max</span><input name="maxFeeGwei" value="${escapeHtml(form.maxFeeGwei)}" ${form.autoFee ? 'disabled' : ''}></label><label class="compact-field"><span>Priority</span><input name="priorityFeeGwei" value="${escapeHtml(form.priorityFeeGwei)}" ${form.autoFee ? 'disabled' : ''}></label>` : `<label class="compact-field"><span>GasPrice</span><input name="gasPriceGwei" value="${escapeHtml(form.gasPriceGwei)}" ${form.autoFee ? 'disabled' : ''}></label>`}
        </div>
      </section>
      <section class="preview-panel"><header><h2>任务计划</h2>${form.job ? `<span class="status ${statusClass(form.job.status)}">${escapeHtml(statusLabel(form.job.status))}</span>` : ''}</header>${jobSummary(form.job)}</section>
      <section class="preview-panel advanced-logs"><header><h2>任务日志</h2><span>${escapeHtml(form.job?.id || '')}</span></header>${jobLogs(form.job)}</section>
    `,
    bind(root) {
      bindAdvancedFields(root, form, render);
      bindWalletTable(root, state, form.walletIds, { inputName, render, onChange: () => { form.job = null; } });
      root.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
        form.mode = button.dataset.mode;
        form.job = null;
        render();
      }));
      root.querySelector(`#${id('preview')}`)?.addEventListener('click', () => void runAction(async () => {
        const result = await api('/api/advanced-mint/preview', { method: 'POST', body: JSON.stringify(advancedMintPayload(form, state)) });
        form.job = result.job || result;
        return result;
      }, { success: '任务预览已生成' }));
      root.querySelector(`#${id('direct')}`)?.addEventListener('click', () => {
        if (form.job?.status && form.job.status !== 'previewed') return;
        void runAction(async () => {
          let job = form.job;
          if (!job?.confirmation?.confirmationToken) {
            const result = await api('/api/advanced-mint/preview', { method: 'POST', body: JSON.stringify(advancedMintPayload(form, state)) });
            job = result.job || result;
            form.job = job;
          }
          const planned = job.summary?.plannedTransactions || 0;
          if (!window.confirm(`确认直接发送 ${planned} 笔交易？`)) return job;
          const result = await api('/api/advanced-mint/send', { method: 'POST', body: JSON.stringify({
            jobId: job.id,
            previewId: job.confirmation.previewId,
            confirmationToken: job.confirmation.confirmationToken,
          }) });
          form.job = { ...result.job, confirmation: job.confirmation };
          startPolling(form, render);
          return result;
        }, { success: '任务已提交' });
      });
      root.querySelector(`#${id('execute')}`)?.addEventListener('click', () => {
        if (!form.job?.confirmation || !window.confirm(`确认发送 ${form.job.summary?.plannedTransactions || 0} 笔交易？`)) return;
        void runAction(async () => {
          const result = await api('/api/advanced-mint/send', { method: 'POST', body: JSON.stringify({
            jobId: form.job.id,
            previewId: form.job.confirmation.previewId,
            confirmationToken: form.job.confirmation.confirmationToken,
          }) });
          form.job = { ...result.job, confirmation: form.job.confirmation };
          startPolling(form, render);
          return result;
        }, { success: '任务已提交' });
      });
      root.querySelector(`#${id('stop')}`)?.addEventListener('click', () => void runAction(async () => {
        const result = await api(`/api/advanced-mint/jobs/${encodeURIComponent(form.job.id)}/stop`, { method: 'POST', body: '{}' });
        form.job = { ...result.job, confirmation: form.job.confirmation };
        return result;
      }, { success: '停止请求已记录' }));
      for (const kind of ['accelerate', 'cancel']) {
        root.querySelector(`#${id(kind)}`)?.addEventListener('click', () => {
          const pending = (form.job?.results || []).find((result) => result.status === 'confirmation_pending');
          if (!pending) return;
          const label = kind === 'accelerate' ? '加速' : '取消';
          if (!window.confirm(`${label}钱包 ${pending.walletId} 的待确认交易？`)) return;
          void runAction(async () => {
            const result = await api(`/api/advanced-mint/jobs/${encodeURIComponent(form.job.id)}/${kind}`, { method: 'POST', body: JSON.stringify({ walletId: pending.walletId, multiplier: 1.2 }) });
            form.job = { ...result.job, confirmation: form.job.confirmation };
            return result;
          }, { success: `${label}交易已提交` });
        });
      }
    },
  };
}

export function renderAdvancedMint({ state, render }, preset = {}) {
  const key = preset.formKey || `advanced:${state.routeName}`;
  const form = state.page[key] ||= createAdvancedForm(state, preset);
  const panel = renderAdvancedMintPanel({ state, render }, {
    form,
    title: preset.title || 'Mint 高级版',
    embedded: false,
    inputName: preset.inputName || 'advancedWallet',
    idPrefix: preset.idPrefix || 'advanced',
  });
  return {
    html: `${networkBar({ state, includeAsset: false })}${panel.html}`,
    bind: panel.bind,
  };
}

function signatureReport(report) {
  if (!report?.analysis) return '<div class="empty-state">等待交易哈希或 Calldata</div>';
  const analysis = report.analysis;
  return `
    <div class="signature-report-head"><div><span>${escapeHtml(analysis.provider)}</span><h2>${escapeHtml(analysis.method)}</h2><code>${escapeHtml(analysis.selector)}</code></div><span class="status ${analysis.signatureMode === 'unknown' ? 'danger' : 'success'}">${escapeHtml(analysis.signatureMode)}</span></div>
    <dl class="signature-data-grid">
      <div><dt>调用目标</dt><dd class="mono">${escapeHtml(analysis.to)}</dd></div>
      <div><dt>NFT 合约</dt><dd class="mono">${escapeHtml(analysis.nftContract || '-')}</dd></div>
      <div><dt>数量</dt><dd>${escapeHtml(analysis.quantity || '-')}</dd></div>
      <div><dt>调用价值</dt><dd>${escapeHtml(analysis.valueEth)}</dd></div>
      <div><dt>Fee Recipient</dt><dd class="mono">${escapeHtml(analysis.feeRecipient || '-')}</dd></div>
      <div><dt>签名字节</dt><dd>${escapeHtml(analysis.signature?.bytes || 0)}</dd></div>
      <div><dt>Merkle Proof</dt><dd>${escapeHtml(analysis.proofCount || 0)}</dd></div>
      <div><dt>阶段状态</dt><dd>${analysis.stageWindow?.ended ? '已结束' : analysis.stageWindow && !analysis.stageWindow.started ? '未开始' : '可检查'}</dd></div>
    </dl>
    ${(analysis.observations || []).map((item) => `<div class="signature-observation">${escapeHtml(item)}</div>`).join('')}
    ${report.preflight ? `<div class="table-scroll signature-preflight"><table><thead><tr><th>状态</th><th>钱包</th><th>地址</th><th>结果</th></tr></thead><tbody>${report.preflight.wallets.map((row) => `<tr><td><span class="status ${statusClass(row.status)}">${escapeHtml(statusLabel(row.status))}</span></td><td>${escapeHtml(row.walletId)}</td><td class="mono">${escapeHtml(shortAddress(row.address))}</td><td>${escapeHtml(row.reason || 'eth_call 通过')}</td></tr>`).join('')}</tbody></table></div>` : ''}
  `;
}

export function renderSignatureTask({ state, render }) {
  const form = state.page.signatureTask ||= {
    walletIds: selectedWalletSet(state),
    txHash: '',
    to: '',
    data: '0x',
    valueWei: '0',
    report: null,
  };
  return {
    html: `
      ${networkBar({ state, includeAsset: false })}
      <div class="signature-layout">
        <form class="form-panel signature-input" id="signature-form">
          <header><h2>签名任务模块</h2><div><button class="button secondary" data-sign-action="analyze" type="button">解析</button><button class="button primary" data-sign-action="preflight" type="button">逐钱包预检</button></div></header>
          <label class="field"><span>交易哈希</span><input name="txHash" value="${escapeHtml(form.txHash)}" placeholder="0x..." spellcheck="false"></label>
          <div class="signature-divider"><span>或手动输入</span></div>
          <label class="field"><span>调用目标</span><input name="to" value="${escapeHtml(form.to)}" placeholder="0x..." spellcheck="false"></label>
          <label class="field"><span>交易金额(wei)</span><input name="valueWei" value="${escapeHtml(form.valueWei)}" inputmode="numeric"></label>
          <label class="field"><span>Calldata</span><textarea name="data" rows="5" spellcheck="false">${escapeHtml(form.data)}</textarea></label>
          <section class="data-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'signature')}${walletTable(state, form.walletIds, { inputName: 'signatureWallet', compact: true })}</section>
        </form>
        <section class="signature-report">${signatureReport(form.report)}</section>
      </div>
    `,
    bind(root) {
      for (const name of ['txHash', 'to', 'data', 'valueWei']) root.querySelector(`[name="${name}"]`)?.addEventListener('input', (event) => { form[name] = event.target.value; form.report = null; });
      bindWalletTable(root, state, form.walletIds, { inputName: 'signatureWallet', render, onChange: () => { form.report = null; } });
      root.querySelectorAll('[data-sign-action]').forEach((button) => button.addEventListener('click', () => void runAction(async () => {
        const path = button.dataset.signAction === 'preflight' ? '/api/signature-lab/preflight' : '/api/signature-lab/analyze';
        form.report = await api(path, { method: 'POST', body: JSON.stringify({
          chainId: writeChainId(state),
          walletIds: [...form.walletIds],
          txHash: form.txHash,
          to: form.to,
          data: form.data,
          valueWei: form.valueWei,
        }) });
        return form.report;
      }, { success: button.dataset.signAction === 'preflight' ? '逐钱包预检已完成' : '交易已解析' })));
    },
  };
}

function freshLaunchpadForm(state) {
  return {
    walletIds: selectedWalletSet(state),
    collectionUrl: '',
    provider: '',
    stage: 'public',
    contractAddress: '',
    methodSignature: 'mint(uint256)',
    parameters: ['1'],
    valueEth: '0',
    quantity: '1',
    frequencyMs: '50',
    autoGas: true,
    gasLimit: '150000',
    autoFee: true,
    maxFeeGwei: '',
    priorityFeeGwei: '',
    resolved: null,
    job: null,
  };
}

export function renderLaunchpadMint({ state, render }) {
  const form = state.page.launchpad ||= freshLaunchpadForm(state);
  const chain = writeChain(state);
  return {
    html: `
      ${networkBar({ state, includeAsset: false })}
      <section class="launchpad-bar">
        <label class="field"><span>合集地址</span><input name="collectionUrl" value="${escapeHtml(form.collectionUrl)}" placeholder="https://opensea.io/collection/..." spellcheck="false"></label>
        <button class="button secondary" id="resolve-launchpad" type="button">获取合集信息</button>
        <span>${form.resolved ? `${escapeHtml(form.resolved.provider)} · ${escapeHtml(form.resolved.name || shortAddress(form.resolved.contractAddress))}` : ''}</span>
      </section>
      <div class="launchpad-stages segmented"><button data-stage="og" class="${form.stage === 'og' ? 'active' : ''}" type="button">OG Whitelist</button><button data-stage="allowlist" class="${form.stage === 'allowlist' ? 'active' : ''}" type="button">Whitelist</button><button data-stage="public" class="${form.stage === 'public' ? 'active' : ''}" type="button">Public</button></div>
      <div class="launchpad-layout">
        <section class="data-panel"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'launchpad')}${walletTable(state, form.walletIds, { inputName: 'launchpadWallet', compact: true })}</section>
        <form class="form-panel launchpad-form">
          <header><h2>铸造参数</h2><span>${escapeHtml(chain.name)}</span></header>
          <label class="field"><span>合约地址</span><input name="contractAddress" value="${escapeHtml(form.contractAddress)}" placeholder="解析后自动填入，或手动输入" spellcheck="false"></label>
          <label class="field"><span>调用方法</span><input name="methodSignature" value="${escapeHtml(form.methodSignature)}" spellcheck="false"></label>
          <div class="form-grid two"><label class="field"><span>金额(${escapeHtml(chain.nativeSymbol)})</span><input name="valueEth" value="${escapeHtml(form.valueEth)}"></label><label class="field"><span>数量</span><input name="quantity" type="number" min="1" value="${escapeHtml(form.quantity)}"></label></div>
          <label class="field"><span>限制频率(ms)</span><input name="frequencyMs" type="number" min="50" value="${escapeHtml(form.frequencyMs)}"></label>
          <div class="fee-strip"><label class="toggle"><input name="autoFee" type="checkbox" ${form.autoFee ? 'checked' : ''}><span>Gas Fee 自动</span></label><label class="compact-field"><span>Max</span><input name="maxFeeGwei" value="${escapeHtml(form.maxFeeGwei)}" ${form.autoFee ? 'disabled' : ''}></label><label class="compact-field"><span>Priority</span><input name="priorityFeeGwei" value="${escapeHtml(form.priorityFeeGwei)}" ${form.autoFee ? 'disabled' : ''}></label><label class="toggle"><input name="autoGas" type="checkbox" ${form.autoGas ? 'checked' : ''}><span>Gas Limit 自动</span></label><label class="compact-field"><span>Limit</span><input name="gasLimit" value="${escapeHtml(form.gasLimit)}" ${form.autoGas ? 'disabled' : ''}></label></div>
          <footer><button class="button secondary" id="preview-launchpad" type="button">生成预览</button><button class="button primary" id="execute-launchpad" type="button" ${form.job?.status === 'previewed' ? '' : 'disabled'}>开始任务</button></footer>
        </form>
      </div>
      <section class="preview-panel"><header><h2>任务状态</h2></header>${jobSummary(form.job)}</section>
    `,
    bind(root) {
      for (const name of ['collectionUrl', 'contractAddress', 'methodSignature', 'valueEth', 'quantity', 'frequencyMs', 'autoGas', 'gasLimit', 'autoFee', 'maxFeeGwei', 'priorityFeeGwei']) {
        const input = root.querySelector(`[name="${name}"]`);
        input?.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
          form[name] = input.type === 'checkbox' ? input.checked : input.value;
          form.job = null;
          if (['autoGas', 'autoFee'].includes(name)) render();
        });
      }
      bindWalletTable(root, state, form.walletIds, { inputName: 'launchpadWallet', render, onChange: () => { form.job = null; } });
      root.querySelectorAll('[data-stage]').forEach((button) => button.addEventListener('click', () => { form.stage = button.dataset.stage; form.job = null; render(); }));
      root.querySelector('#resolve-launchpad')?.addEventListener('click', () => void runAction(async () => {
        const result = await api('/api/launchpad/resolve', { method: 'POST', body: JSON.stringify({ url: form.collectionUrl, chainId: writeChainId(state), stage: form.stage }) });
        form.resolved = result.collection;
        form.provider = result.collection.provider;
        form.contractAddress = result.collection.contractAddress || form.contractAddress;
        form.methodSignature = result.collection.methodSignature || form.methodSignature;
        form.valueEth = result.collection.valueEth ?? form.valueEth;
        return result;
      }, { success: '合集信息已获取' }));
      root.querySelector('#preview-launchpad')?.addEventListener('click', () => void runAction(async () => {
        const params = methodParameterTypes(form.methodSignature).map((type) => type.includes('address') ? '&' : type.startsWith('uint') ? form.quantity : '');
        const result = await api('/api/advanced-mint/preview', { method: 'POST', body: JSON.stringify({
          chainId: writeChainId(state),
          walletIds: [...form.walletIds],
          contractAddress: form.contractAddress,
          mode: 'method',
          methodSignature: form.methodSignature,
          parameters: params,
          valueEth: form.valueEth,
          rounds: '1',
          frequencyMs: form.frequencyMs,
          executionMode: 'sequential',
          waitMode: 'confirmed',
          preflight: true,
          autoGas: form.autoGas,
          gasLimit: form.gasLimit,
          autoFee: form.autoFee,
          eip1559: true,
          maxFeeGwei: form.maxFeeGwei,
          priorityFeeGwei: form.priorityFeeGwei,
          prefetchNonce: true,
          rpcProfileId: writeProfileId(state),
          rpcProfileRef: writeProfileRef(state),
        }) });
        form.job = result.job;
        return result;
      }, { success: 'Launchpad 预览已生成' }));
      root.querySelector('#execute-launchpad')?.addEventListener('click', () => {
        if (!form.job?.confirmation || !window.confirm(`确认发送 ${form.job.summary?.plannedTransactions || 0} 笔铸造交易？`)) return;
        void runAction(async () => {
          const result = await api('/api/advanced-mint/send', { method: 'POST', body: JSON.stringify({ jobId: form.job.id, previewId: form.job.confirmation.previewId, confirmationToken: form.job.confirmation.confirmationToken }) });
          form.job = { ...result.job, confirmation: form.job.confirmation };
          startPolling(form, render);
          return result;
        }, { success: 'Launchpad 任务已提交' });
      });
    },
  };
}
