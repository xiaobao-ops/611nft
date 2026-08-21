import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage ||= {
  getItem: () => null,
  setItem: () => {},
};

const {
  bindWalletGroupBar,
  walletGroupBar,
  walletGroupState,
} = await import('../apps/nfttool/runtime/components.js');
const {
  groupWallets,
  normalizeWalletGroup,
  toggleWalletGroup,
} = await import('../apps/nfttool/runtime/wallet-groups.js');
const {
  collectionPreviewRequest,
  dispersePreviewBody,
  exchangePreviewRows,
  manyToManyPreviewBody,
  renderCollection,
  renderDisperse,
  renderExchangeDeposit,
  renderManyToMany,
} = await import('../apps/nfttool/runtime/transfer-pages.js');
const { renderWalletManager } = await import('../apps/nfttool/runtime/wallet-manager.js');

function makeState() {
  return {
    chainId: 1,
    chains: [{ id: 1, name: 'Ethereum', nativeSymbol: 'ETH' }],
    wallets: [
      { id: 'b', label: 'B', address: '0x0000000000000000000000000000000000000002', group: '乙组', exchangeAddress: '0x0000000000000000000000000000000000000012' },
      { id: 'a', label: 'A', address: '0x0000000000000000000000000000000000000001', group: ' 甲组 ', exchangeAddress: '0x0000000000000000000000000000000000000011' },
      { id: 'c', label: 'C', address: '0x0000000000000000000000000000000000000003', group: '', exchangeAddress: '0x0000000000000000000000000000000000000013' },
    ],
    selected: new Set(['a', 'b']),
    page: {},
  };
}

function fakeButton(action, key = '') {
  const handlers = {};
  return {
    dataset: { walletGroupAction: action, walletGroupKey: key },
    addEventListener(type, handler) { handlers[type] = handler; },
    click() { handlers.click(); },
  };
}

function fakeBar(prefix, buttons) {
  return {
    dataset: { walletGroupPrefix: prefix, walletGroupMode: 'select' },
    querySelectorAll: () => buttons,
  };
}

test('runtime groups normalize, sort, deduplicate, expose ungrouped, and honor exclusions', () => {
  const longName = 'x'.repeat(90);
  const wallets = [
    { id: 'a', group: ' 乙组\n' },
    { id: 'b', group: '甲\n组' },
    { id: 'c', group: '' },
    { id: 'd', group: '   ' },
    { id: 'a', group: '重复钱包不会再次出现' },
    { id: 'e', group: longName },
  ];

  assert.equal(normalizeWalletGroup(' 甲\n组\u0000 '), '甲 组');
  assert.equal(normalizeWalletGroup(longName).length, 80);
  assert.deepEqual(groupWallets(wallets).map(({ key }) => key), ['甲 组', '乙组', 'x'.repeat(80), '']);
  assert.deepEqual(groupWallets(wallets).at(-1), { key: '', label: '未分组', walletIds: ['c', 'd'] });
  assert.deepEqual(groupWallets(wallets, { excludedIds: new Set(['b', 'd']) }).map(({ key, walletIds }) => [key, walletIds]), [
    ['乙组', ['a']],
    ['x'.repeat(80), ['e']],
    ['', ['c']],
  ]);
});

test('runtime group toggle preserves other groups and reports partial selection', () => {
  const partial = walletGroupState(new Set(['outside', 'a']), ['a', 'b', 'b']);
  assert.deepEqual(partial, { selectedCount: 1, total: 2, checked: false, partial: true });

  const selected = toggleWalletGroup(['outside', 'a'], ['a', 'b', 'b']);
  assert.deepEqual([...selected], ['outside', 'a', 'b']);
  assert.deepEqual([...toggleWalletGroup(selected, ['a', 'b'])], ['outside']);

  const html = walletGroupBar({ wallets: [{ id: 'a', group: '主组' }, { id: 'b', group: '主组' }] }, new Set(['a']), 'partial-test');
  assert.match(html, /data-wallet-group-prefix="partial-test"/);
  assert.match(html, /class="group-check partial"[^>]+aria-pressed="mixed"/);
  assert.match(html, /<span>主组<\/span><small>1\/2<\/small>/);
});

test('prefixed runtime group binders keep two wallet selectors isolated and respect exclusions', () => {
  const senderGroup = fakeButton('toggle', '同组');
  const receiverGroup = fakeButton('toggle', '同组');
  const bars = [fakeBar('many-sender', [senderGroup]), fakeBar('many-receiver', [receiverGroup])];
  const root = { querySelectorAll: () => bars };
  const state = { wallets: [{ id: 'a', group: '同组' }, { id: 'b', group: '同组' }, { id: 'c', group: '其他' }] };
  const senderIds = new Set(['c']);
  const receiverIds = new Set(['b']);

  bindWalletGroupBar(root, state, senderIds, { prefix: 'many-sender', exclude: receiverIds });
  bindWalletGroupBar(root, state, receiverIds, { prefix: 'many-receiver', exclude: senderIds });
  senderGroup.click();
  assert.deepEqual([...senderIds], ['c', 'a']);
  assert.deepEqual([...receiverIds], ['b']);
  receiverGroup.click();
  assert.deepEqual([...senderIds], ['c', 'a']);
  assert.deepEqual([...receiverIds], []);
  senderGroup.click();
  assert.deepEqual([...senderIds], ['c', 'a', 'b']);
});

test('all four transfer entries render group controls with independent prefixes', () => {
  const disperse = renderDisperse({ state: makeState(), render() {} }).html;
  assert.match(disperse, /data-wallet-group-prefix="disperse-from"/);
  assert.match(disperse, /data-wallet-group-prefix="disperse-target"/);
  assert.match(disperse, /data-wallet-group-mode="filter"/);

  const collection = renderCollection({ state: makeState(), render() {} }).html;
  assert.match(collection, /data-wallet-group-prefix="collection-source"/);

  const many = renderManyToMany({ state: makeState(), render() {} }).html;
  assert.match(many, /data-wallet-group-prefix="many-sender"/);
  assert.match(many, /data-wallet-group-prefix="many-receiver"/);

  const exchange = renderExchangeDeposit({ state: makeState(), render() {} }).html;
  assert.match(exchange, /data-wallet-group-prefix="exchange"/);
  assert.match(exchange, /未分组/);
});

test('wallet module pages keep the send node control without duplicating Network', () => {
  const pages = [
    renderDisperse({ state: makeState(), render() {} }).html,
    renderCollection({ state: makeState(), render() {} }).html,
    renderManyToMany({ state: makeState(), render() {} }).html,
    renderExchangeDeposit({ state: makeState(), render() {} }).html,
  ];
  for (const html of pages) {
    assert.doesNotMatch(html, /Network|class="chain-select"/);
    assert.match(html, /发送节点/);
  }

  const manager = renderWalletManager({ state: makeState(), openDialog() {}, render() {}, toast() {} }).html;
  assert.doesNotMatch(manager, /Network|class="chain-select"/);
  assert.doesNotMatch(manager, /发送节点/);
});

test('transfer preview builders emit only valid, ordered, non-conflicting wallet ids', () => {
  const state = makeState();
  state.wallets.push({ ...state.wallets[1] });
  const common = { asset: 'native', tokenAddress: '', preflight: true, executionMode: 'sequential' };
  const disperse = dispersePreviewBody(state, {
    ...common,
    fromId: 'a',
    targetIds: new Set(['c', 'ghost', 'b', 'a']),
    amountMode: 'fixed',
    amount: '1',
    targetBalance: '0',
  });
  assert.deepEqual(disperse.targetIds, ['b', 'c']);

  const collection = collectionPreviewRequest(state, {
    mode: 'native',
    sourceIds: new Set(['a', 'b', 'c', 'ghost']),
    destinationWalletId: 'c',
    reserveEth: '0.1',
    gasMultiplier: '1.25',
    preflight: true,
  });
  assert.deepEqual(collection.body.sourceIds, ['b', 'a']);

  const many = manyToManyPreviewBody(state, {
    ...common,
    senderIds: new Set(['a', 'c', 'ghost']),
    receiverIds: new Set(['b']),
    amount: '1',
  });
  assert.deepEqual(many.senderIds, ['a', 'c']);
  assert.deepEqual(many.receiverIds, ['b']);
  assert.deepEqual(exchangePreviewRows(state, { walletIds: new Set(['a', 'c', 'ghost']) }).map(({ id }) => id), ['a', 'c']);
});

test('wallet manager exposes ungrouped filtering and a bulk clear action', () => {
  const state = makeState();
  const context = { state, openDialog() {}, render() {}, toast() {} };
  const all = renderWalletManager(context);
  assert.match(all.html, />未分组 \(1\)<\/option>/);
  assert.match(all.html, /id="clear-group"/);

  state.page.walletGroupFilter = 'group:';
  const ungrouped = renderWalletManager(context).html;
  assert.match(ungrouped, /data-wallet-row="c"/);
  assert.doesNotMatch(ungrouped, /data-wallet-row="a"/);
  assert.match(String(renderWalletManager), /walletIds: ids, group: ''/);
});
