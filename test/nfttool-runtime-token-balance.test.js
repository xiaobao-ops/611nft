import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage ||= {
  getItem: () => null,
  setItem: () => {},
};

const {
  assetBalanceColumn,
  holdingAmounts,
  nativeBalanceColumn,
  renderCollection,
  renderDisperse,
  renderManyToMany,
} = await import('../public/nfttool-runtime/transfer-pages.js');

const TOKEN = '0x00000000000000000000000000000000000000AA';
const TOKEN_KEY = TOKEN.toLowerCase();

function makeState() {
  return {
    chainId: 1,
    transactionChainId: 1,
    chains: [{ id: 1, name: 'Ethereum', nativeSymbol: 'ETH' }],
    wallets: [
      {
        id: 'a',
        label: 'A',
        address: '0x0000000000000000000000000000000000000001',
        group: '甲组',
        balances: [
          { chainId: 1, tokenKey: 'native', symbol: 'ETH', formatted: '1.5' },
          { chainId: 1, tokenKey: TOKEN_KEY, symbol: 'USDC', formatted: '250.75' },
        ],
      },
      {
        id: 'b',
        label: 'B',
        address: '0x0000000000000000000000000000000000000002',
        group: '甲组',
        balances: [{ chainId: 1, tokenKey: 'native', symbol: 'ETH', formatted: '0.25' }],
      },
    ],
    selected: new Set(['a', 'b']),
    page: {},
  };
}

test('the amount column follows the selected asset instead of always reading native', () => {
  const state = makeState();

  const native = nativeBalanceColumn(state);
  assert.equal(native.label, 'ETH');
  assert.equal(native.valueFor(state.wallets[0]), '1.5');

  const token = assetBalanceColumn(state, { asset: 'erc20', tokenAddress: TOKEN });
  assert.equal(token.label, 'USDC');
  assert.equal(token.valueFor(state.wallets[0]), '250.75');
  // A wallet with no cached row for this token must read '-', not the ETH balance.
  assert.equal(token.valueFor(state.wallets[1]), undefined);

  // Customize with an incomplete address falls back to native rather than rendering an
  // empty column while the operator is still typing.
  assert.equal(assetBalanceColumn(state, { asset: 'erc20', tokenAddress: '0x123' }).label, 'ETH');
  assert.equal(assetBalanceColumn(state, { asset: 'native', tokenAddress: TOKEN }).label, 'ETH');

  // Before any refresh has cached a row the symbol is unknown, but the header must not
  // claim the balance is denominated in ETH.
  const unpriced = assetBalanceColumn(state, { asset: 'erc20', tokenAddress: '0x00000000000000000000000000000000000000bb' });
  assert.equal(unpriced.label, 'Token');
  assert.equal(unpriced.valueFor(state.wallets[0]), undefined);
});

test('disperse renders the token symbol and balance once Customize is chosen', () => {
  const state = makeState();
  assert.match(renderDisperse({ state, render() {} }).html, /金额\(ETH\)/);

  state.page.disperse.asset = 'erc20';
  state.page.disperse.tokenAddress = TOKEN;
  const html = renderDisperse({ state, render() {} }).html;
  assert.match(html, /金额\(USDC\)/);
  assert.doesNotMatch(html, /金额\(ETH\)/);
  assert.match(html, />250\.75</);
  assert.doesNotMatch(html, />1\.5</);
});

test('many-to-many follows Customize and can refresh the token balance it displays', () => {
  const state = makeState();
  const native = renderManyToMany({ state, render() {} }).html;
  assert.match(native, /金额\(ETH\)/);
  assert.match(native, /id="refresh-many-balances"/);

  state.page.many.asset = 'erc20';
  state.page.many.tokenAddress = TOKEN;
  const html = renderManyToMany({ state, render() {} }).html;
  assert.match(html, /金额\(USDC\)/);
  assert.match(html, />250\.75</);
});

test('collection in token mode shows the queried holding, not the native balance', () => {
  assert.deepEqual([...holdingAmounts({
    standard: 'ERC721',
    rows: [
      { walletId: 'a', tokenId: '1', count: '1' },
      { walletId: 'a', tokenId: '7', count: '1' },
      { walletId: 'b', tokenId: '9', count: '1' },
    ],
  })], [['a', '2'], ['b', '1']]);
  assert.deepEqual([...holdingAmounts({ standard: 'ERC20', rows: [{ walletId: 'a', formatted: '12.5' }] })], [['a', '12.5']]);
  assert.deepEqual([...holdingAmounts(undefined)], []);

  const state = makeState();
  // Token mode with nothing queried yet must not pass the ETH balance off as a holding.
  const empty = renderCollection({ state, render() {} }).html;
  assert.match(empty, /金额\(持仓\)/);
  assert.doesNotMatch(empty, />1\.5</);

  state.page.collection.snapshot = {
    snapshotId: 's1',
    holdings: { standard: 'ERC721', symbol: 'PUNK', totalFormatted: '3', rows: [
      { id: 'a:1', walletId: 'a', tokenId: '1', count: '1', formatted: '1' },
      { id: 'a:7', walletId: 'a', tokenId: '7', count: '1', formatted: '1' },
    ] },
  };
  const queried = renderCollection({ state, render() {} }).html;
  assert.match(queried, /金额\(PUNK\)/);
  assert.match(queried, /<td class="number-cell">2<\/td>/);

  // Native mode keeps the chain symbol and the cached native balance. Wallet 'a' is the
  // default recipient, so the source picker shows 'b'.
  state.page.collection.mode = 'native';
  const nativeMode = renderCollection({ state, render() {} }).html;
  assert.match(nativeMode, /金额\(ETH\)/);
  assert.match(nativeMode, />0\.25</);
});
