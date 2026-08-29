import { api, escapeHtml, networkBar, openDialog, runAction, shortAddress, writeChain, writeChainId, writeProfileId, writeProfileRef } from './core.js';
import {
  bindWalletTable,
  formatDateTime,
  selectedWalletSet,
  statusClass,
  statusLabel,
  walletGroupBar,
  walletTable,
} from './components.js';

function freshForm(state) {
  return {
    name: '',
    sourceContract: '',
    targetContract: '',
    quantity: '1',
    tokenId: '0',
    concurrency: '5',
    minTriggerQuantity: '1',
    maxTriggerQuantity: '',
    maxMintCostEth: '',
    eventValueMode: 'free',
    maxEventValueEth: '',
    maxGasLimit: '',
    parameterCount: '',
    minMaxSupply: '',
    timeStart: '',
    timeEnd: '',
    blockedKeywords: '',
    excludeErc1155: false,
    excludedPlatforms: [],
    confirmedOnly: true,
    notifyOnly: false,
    cooldownSeconds: '60',
    enabled: true,
    oneShot: true,
    walletIds: selectedWalletSet(state),
    rpcProfileId: writeProfileId(state),
    rpcProfileRef: writeProfileRef(state),
  };
}

function rulePayload(form, state) {
  return {
    name: form.name,
    chainId: writeChainId(state),
    rpcProfileId: writeProfileId(state),
    rpcProfileRef: writeProfileRef(state),
    sourceContract: form.sourceContract,
    targetContract: form.targetContract,
    walletIds: [...form.walletIds],
    quantity: form.quantity,
    tokenId: form.tokenId,
    concurrency: form.concurrency,
    minTriggerQuantity: form.minTriggerQuantity,
    maxTriggerQuantity: form.maxTriggerQuantity,
    maxMintCostEth: form.maxMintCostEth,
    eventValueMode: form.eventValueMode,
    maxEventValueEth: form.maxEventValueEth,
    maxGasLimit: form.maxGasLimit,
    parameterCount: form.parameterCount,
    minMaxSupply: form.minMaxSupply,
    timeStart: form.timeStart,
    timeEnd: form.timeEnd,
    blockedKeywords: form.blockedKeywords,
    excludeErc1155: form.excludeErc1155,
    excludedPlatforms: form.excludedPlatforms,
    confirmedOnly: form.confirmedOnly,
    notifyOnly: form.notifyOnly,
    cooldownSeconds: form.cooldownSeconds,
    enabled: form.enabled,
    oneShot: form.oneShot,
  };
}

async function loadRules(page, render, quiet = false) {
  if (page.loading) return;
  page.loading = !quiet;
  if (!quiet) render();
  try {
    const result = await api('/api/follow-mint');
    page.rules = result.rules || [];
    page.runs = result.runs || [];
    page.error = '';
  } catch (error) {
    page.error = error.message;
  } finally {
    page.loading = false;
    render();
  }
}

function ruleCard(rule, runs) {
  const armed = rule.mode === 'armed' && Date.parse(rule.armedUntil || 0) > Date.now();
  return `
    <article class="follow-rule-card">
      <header>
        <div><strong>${escapeHtml(rule.name)}</strong><span>${rule.notifyOnly ? '仅通知' : `${rule.walletIds?.length || 0} 个执行钱包`}</span></div>
        <span class="status ${statusClass(rule.enabled ? (armed ? 'armed' : 'running') : 'stopped')}">${rule.enabled ? (armed ? '自动执行' : '监听中') : '已暂停'}</span>
      </header>
      <dl>
        <div><dt>监听地址</dt><dd class="mono" title="${escapeHtml(rule.sourceContract)}">${escapeHtml(shortAddress(rule.sourceContract || rule.targetContract))}</dd></div>
        <div><dt>目标地址</dt><dd class="mono" title="${escapeHtml(rule.targetContract)}">${escapeHtml(shortAddress(rule.targetContract || rule.sourceContract))}</dd></div>
        <div><dt>数量</dt><dd>${escapeHtml(rule.quantity)}</dd></div>
        <div><dt>冷却</dt><dd>${escapeHtml(rule.cooldownSeconds)} 秒</dd></div>
        <div><dt>价值</dt><dd>${rule.eventValueMode === 'free' ? '仅免费' : rule.eventValueMode === 'max' ? `≤ ${escapeHtml(rule.maxEventValueEth)}` : '任意'}</dd></div>
        <div><dt>最近命中</dt><dd>${escapeHtml(formatDateTime(rule.lastTriggeredAt, '从未'))}</dd></div>
      </dl>
      <div class="follow-rule-actions">
        <button class="button secondary rule-preview" data-rule="${escapeHtml(rule.id)}" type="button">测试预览</button>
        <button class="button ${rule.enabled ? '' : 'primary'} rule-toggle" data-rule="${escapeHtml(rule.id)}" type="button">${rule.enabled ? '暂停' : '开始监听'}</button>
        ${rule.notifyOnly ? '' : armed
          ? `<button class="button rule-disarm" data-rule="${escapeHtml(rule.id)}" type="button">关闭自动执行</button>`
          : `<button class="button rule-arm" data-rule="${escapeHtml(rule.id)}" type="button">临时自动执行</button>`}
        <button class="button danger rule-delete" data-rule="${escapeHtml(rule.id)}" type="button">删除</button>
      </div>
      <div class="follow-rule-runs">
        ${(runs || []).slice(0, 4).map((run) => `<div><time>${escapeHtml(formatDateTime(run.createdAt))}</time><span class="status ${statusClass(run.status)}">${escapeHtml(statusLabel(run.status))}</span><code>${escapeHtml(run.jobId ? shortAddress(run.jobId) : run.error || run.snapshot?.decision?.reason || '-')}</code></div>`).join('') || '<span>暂无命中记录</span>'}
      </div>
    </article>
  `;
}

function formFields(form, chain) {
  return `
    <label class="field span-2"><span>任务名称</span><input name="name" value="${escapeHtml(form.name)}" placeholder="任务名称"></label>
    <label class="field"><span>监听地址</span><input name="sourceContract" value="${escapeHtml(form.sourceContract)}" placeholder="0x..." spellcheck="false"></label>
    <label class="field"><span>铸造地址</span><input name="targetContract" value="${escapeHtml(form.targetContract)}" placeholder="留空则使用监听地址" spellcheck="false"></label>
    <label class="field"><span>每账号数量</span><input name="quantity" type="number" min="1" value="${escapeHtml(form.quantity)}"></label>
    <label class="field"><span>Token ID</span><input name="tokenId" type="number" min="0" value="${escapeHtml(form.tokenId)}"></label>
    <label class="field"><span>并发</span><input name="concurrency" type="number" min="0" max="32" value="${escapeHtml(form.concurrency)}"></label>
    <label class="field"><span>冷却(秒)</span><input name="cooldownSeconds" type="number" min="5" value="${escapeHtml(form.cooldownSeconds)}"></label>
    <label class="field"><span>开始时间</span><input name="timeStart" type="time" value="${escapeHtml(form.timeStart)}"></label>
    <label class="field"><span>结束时间</span><input name="timeEnd" type="time" value="${escapeHtml(form.timeEnd)}"></label>
    <label class="field"><span>Value 过滤</span><select name="eventValueMode"><option value="free" ${form.eventValueMode === 'free' ? 'selected' : ''}>只跟 free mint</option><option value="any" ${form.eventValueMode === 'any' ? 'selected' : ''}>不筛选</option><option value="max" ${form.eventValueMode === 'max' ? 'selected' : ''}>不超过上限</option></select></label>
    <label class="field"><span>Value 上限(${escapeHtml(chain.nativeSymbol)})</span><input name="maxEventValueEth" value="${escapeHtml(form.maxEventValueEth)}" ${form.eventValueMode === 'max' ? '' : 'disabled'} placeholder="空表示不筛选"></label>
    <label class="field"><span>执行成本上限(${escapeHtml(chain.nativeSymbol)})</span><input name="maxMintCostEth" value="${escapeHtml(form.maxMintCostEth)}" placeholder="空表示不限制"></label>
    <label class="field"><span>Gas Limit 不能大于</span><input name="maxGasLimit" value="${escapeHtml(form.maxGasLimit)}" inputmode="numeric" placeholder="空表示不筛选"></label>
    <label class="field"><span>参数数量</span><input name="parameterCount" value="${escapeHtml(form.parameterCount)}" inputmode="numeric" placeholder="空表示不筛选"></label>
    <label class="field"><span>Mint 数量范围</span><span class="range-input"><input name="minTriggerQuantity" type="number" min="1" value="${escapeHtml(form.minTriggerQuantity)}"><b>至</b><input name="maxTriggerQuantity" type="number" min="1" value="${escapeHtml(form.maxTriggerQuantity)}" placeholder="不限"></span></label>
    <label class="field"><span>MaxSupply 不小于</span><input name="minMaxSupply" value="${escapeHtml(form.minMaxSupply)}" inputmode="numeric" placeholder="空表示不筛选"></label>
    <label class="field span-2"><span>关键词过滤</span><input name="blockedKeywords" value="${escapeHtml(form.blockedKeywords)}" placeholder="逗号分隔"></label>
  `;
}

function bindForm(root, form, render) {
  const rerenderFields = new Set(['eventValueMode', 'notifyOnly']);
  root.querySelectorAll('[name]').forEach((input) => {
    if (['followWallet', 'excludedPlatform'].includes(input.name)) return;
    const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      if (!(input.name in form)) return;
      form[input.name] = input.type === 'checkbox' ? input.checked : input.value;
      if (rerenderFields.has(input.name)) render();
    });
  });
  root.querySelectorAll('[name="excludedPlatform"]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked && !form.excludedPlatforms.includes(input.value)) form.excludedPlatforms.push(input.value);
    if (!input.checked) form.excludedPlatforms = form.excludedPlatforms.filter((value) => value !== input.value);
  }));
}

export function renderFollowMint({ state, render }) {
  const page = state.page.followMint ||= {
    form: freshForm(state),
    rules: [],
    runs: [],
    loaded: false,
    loading: false,
    error: '',
    pollTimer: null,
  };
  const form = page.form;
  const chain = writeChain(state);
  const rules = page.rules.filter((rule) => Number(rule.chainId) === Number(writeChainId(state)));
  const runsByRule = new Map();
  for (const run of page.runs) {
    if (!runsByRule.has(run.ruleId)) runsByRule.set(run.ruleId, []);
    runsByRule.get(run.ruleId).push(run);
  }
  return {
    html: `
      ${networkBar({ state, includeAsset: false, mode: 'writeProfile' })}
      <div class="follow-status-rail">
        <div><span>监听任务</span><strong>${rules.filter((rule) => rule.enabled).length}</strong></div>
        <div><span>命中记录</span><strong>${page.runs.filter((run) => run.status !== 'skipped').length}</strong></div>
        <div><span>跳过记录</span><strong>${page.runs.filter((run) => run.status === 'skipped').length}</strong></div>
        <button class="button secondary" id="refresh-follow" type="button">刷新</button>
      </div>
      ${page.error ? `<div class="inline-alert">${escapeHtml(page.error)}</div>` : ''}
      <div class="follow-layout">
        <form class="form-panel follow-form" id="follow-form">
          <header><h2>创建任务</h2><span>${form.notifyOnly ? '仅通知' : '默认仅预览'}</span></header>
          <div class="form-grid two">${formFields(form, chain)}</div>
          <section class="follow-check-panel">
            <label class="toggle"><input name="confirmedOnly" type="checkbox" ${form.confirmedOnly ? 'checked' : ''}><span>只跟 Confirmed</span></label>
            <label class="toggle"><input name="excludeErc1155" type="checkbox" ${form.excludeErc1155 ? 'checked' : ''}><span>不跟 ERC1155</span></label>
            ${['artblocks', 'bueno', 'zora'].map((platform) => `<label class="toggle"><input name="excludedPlatform" value="${platform}" type="checkbox" ${form.excludedPlatforms.includes(platform) ? 'checked' : ''}><span>不跟 ${platform}</span></label>`).join('')}
            <label class="toggle"><input name="notifyOnly" type="checkbox" ${form.notifyOnly ? 'checked' : ''}><span>仅通知</span></label>
            <label class="toggle"><input name="oneShot" type="checkbox" ${form.oneShot ? 'checked' : ''}><span>单合约只跟一次</span></label>
            <label class="toggle"><input name="enabled" type="checkbox" ${form.enabled ? 'checked' : ''}><span>保存后开始监听</span></label>
          </section>
          <section class="data-panel follow-wallets"><header><h2>账号</h2><span>${form.walletIds.size} 个</span></header>${walletGroupBar(state, form.walletIds, 'follow')}${walletTable(state, form.walletIds, { inputName: 'followWallet', compact: true })}</section>
          <footer><button class="button primary" type="submit">保存任务</button></footer>
        </form>
        <section class="follow-rule-list">
          <header><h2>任务列表</h2><span>${rules.length} 条</span></header>
          ${rules.map((rule) => ruleCard(rule, runsByRule.get(rule.id))).join('') || '<div class="empty-state">当前链尚未创建跟单任务</div>'}
        </section>
      </div>
    `,
    bind(root) {
      if (!page.loaded) {
        page.loaded = true;
        void loadRules(page, render);
      }
      if (!page.pollTimer) {
        page.pollTimer = window.setInterval(() => void loadRules(page, render, true), 5000);
      }
      bindForm(root, form, render);
      bindWalletTable(root, state, form.walletIds, { inputName: 'followWallet', render });
      root.querySelector('#refresh-follow')?.addEventListener('click', () => void loadRules(page, render));
      root.querySelector('#follow-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        void runAction(async () => {
          const result = await api('/api/follow-mint/rules', { method: 'POST', body: JSON.stringify(rulePayload(form, state)) });
          page.form = freshForm(state);
          await loadRules(page, render, true);
          return result;
        }, { success: '跟单任务已保存' });
      });
      const byId = (button) => page.rules.find((rule) => rule.id === button.dataset.rule);
      root.querySelectorAll('.rule-preview').forEach((button) => button.addEventListener('click', () => void runAction(async () => {
        const result = await api(`/api/follow-mint/rules/${encodeURIComponent(button.dataset.rule)}/preview`, { method: 'POST', body: '{}' });
        await loadRules(page, render, true);
        return result;
      }, { success: '真实预检已完成' })));
      root.querySelectorAll('.rule-toggle').forEach((button) => button.addEventListener('click', () => {
        const rule = byId(button);
        void runAction(async () => {
          const result = await api(`/api/follow-mint/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ ...rule, enabled: !rule.enabled, mode: rule.mode }) });
          await loadRules(page, render, true);
          return result;
        }, { success: rule.enabled ? '任务已暂停' : '任务已开始监听' });
      }));
      root.querySelectorAll('.rule-arm').forEach((button) => button.addEventListener('click', () => {
        const rule = byId(button);
        openDialog({
          title: `临时自动执行：${rule.name}`,
          body: '<p class="dialog-warning">自动执行将在一小时后到期。</p><label class="field"><span>确认短语</span><input name="phrase" autocomplete="off"></label>',
          confirmText: '启用',
          onSubmit: async ({ phrase }) => Boolean(await runAction(async () => {
            const result = await api(`/api/follow-mint/rules/${encodeURIComponent(rule.id)}/arm`, { method: 'POST', body: JSON.stringify({ phrase }) });
            await loadRules(page, render, true);
            return result;
          }, { success: '临时自动执行已启用' })),
        });
      }));
      root.querySelectorAll('.rule-disarm').forEach((button) => button.addEventListener('click', () => void runAction(async () => {
        const result = await api(`/api/follow-mint/rules/${encodeURIComponent(button.dataset.rule)}/disarm`, { method: 'POST', body: '{}' });
        await loadRules(page, render, true);
        return result;
      }, { success: '自动执行已关闭' })));
      root.querySelectorAll('.rule-delete').forEach((button) => button.addEventListener('click', () => {
        const rule = byId(button);
        if (!window.confirm(`删除任务“${rule.name}”？`)) return;
        void runAction(async () => {
          const result = await api(`/api/follow-mint/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
          await loadRules(page, render, true);
          return result;
        }, { success: '任务已删除' });
      }));
    },
  };
}
