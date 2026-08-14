import assert from 'node:assert/strict';
import test from 'node:test';

import * as cli from '../src/index.js';
import { createTicketClient } from '../src/adapters.js';
import {
  assertProxyPreflightReady,
  closeProxyDispatchers,
  createProxyDispatchers,
  multiConfigurationLines,
  publicConfigurationLines,
  reportGasBalances,
  resolveArmed,
  runMultiWallet,
  sanitizeFatalError,
  verifyStablePoolEgress,
} from '../src/index.js';

const PRIVATE_KEY = `0x${'ab'.repeat(32)}`;
const TICKET_SIGNATURE = `0x${'cd'.repeat(65)}`;
const RPC_URL =
  'https://rpc-user:rpc-password@rpc.example.test/v1/rpc-path-key?apiKey=rpc-query-key';
const TICKET_URL =
  'https://ticket-user:ticket-password@tickets.example.test/backend/ticket-path-key?token=ticket-query-key';
const PROXY_API_URL =
  'https://proxy-api.example.test/white/private-path-key?proxyApiSecretKey=proxy-api-query-key';

test('fatal error redacts configured secrets and non-hex URL credentials', () => {
  const error = new Error(
    [
      `private=${PRIVATE_KEY}`,
      `rpc=${RPC_URL}`,
      `ticket=${TICKET_URL}`,
      'userinfo=rpc-user rpc-password ticket-user ticket-password',
      'paths=rpc-path-key ticket-path-key',
      'queries=rpc-query-key ticket-query-key',
      `signature=${TICKET_SIGNATURE}`,
    ].join(' '),
  );

  const output = sanitizeFatalError(error, {
    privateKey: PRIVATE_KEY,
    rpcUrl: RPC_URL,
    ticketUrl: TICKET_URL,
  });

  for (const secret of [
    PRIVATE_KEY,
    RPC_URL,
    TICKET_URL,
    'rpc-user',
    'rpc-password',
    'ticket-user',
    'ticket-password',
    'rpc-path-key',
    'ticket-path-key',
    'rpc-query-key',
    'ticket-query-key',
    TICKET_SIGNATURE,
  ]) {
    assert.equal(output.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(output, /rpc\.example\.test/);
  assert.match(output, /tickets\.example\.test/);
});

test('fatal error redacts the mnemonic and proxy credentials', () => {
  const MNEMONIC = 'test test test test test test test test test test test junk';
  const PROXY = 'http://proxy-user:proxy-pass@proxy.example.test:8080';
  const error = new Error(
    `phrase=${MNEMONIC} proxy=${PROXY} creds=proxy-user proxy-pass`,
  );

  const output = sanitizeFatalError(error, {
    mnemonic: MNEMONIC,
    proxyUrls: [PROXY],
  });

  for (const secret of [MNEMONIC, PROXY, 'proxy-user', 'proxy-pass']) {
    assert.equal(output.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(output, /proxy\.example\.test/);
});

test('fatal error redacts proxy API path and query from message, cause, and nested source', () => {
  const error = new Error(`proxy pool failed at ${PROXY_API_URL}`);
  error.cause = {
    message: 'upstream request failed',
    source: new Error(
      'nested source private-path-key proxyApiSecretKey proxy-api-query-key',
    ),
  };

  const output = sanitizeFatalError(error, { proxyApiUrl: PROXY_API_URL });

  for (const secret of [
    PROXY_API_URL,
    'private-path-key',
    'proxyApiSecretKey',
    'proxy-api-query-key',
  ]) {
    assert.equal(output.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(output, /proxy-api\.example\.test/);
});

test('multi configuration summary exposes only non-secret fields', () => {
  const lines = multiConfigurationLines({
    config: {
      rpcUrl: 'https://rpc-user:rpc-password@rpc.example.test/v1/key?apiKey=secret',
      ticketTimeoutMs: 6000,
      proxyPreheat: true,
      proxyPreheatRecheckMs: 3600000,
      mintConcurrency: 10,
      pollIntervalMs: 5000,
      maxGasLimit: 500000n,
      maxFeePerGasGwei: 5,
      confirmations: 1,
      failedReceiptRetries: 1,
    },
    walletCount: 50,
    proxyCount: 50,
    armed: false,
  });

  assert.ok(lines.includes('mode=multi'));
  assert.ok(lines.includes('armed=false'));
  assert.ok(lines.includes('wallets=50'));
  assert.ok(lines.includes('proxies=50'));
  assert.ok(lines.includes('proxyPreheat=true'));
  assert.ok(lines.includes('proxyPreheatRecheckMs=3600000'));
  assert.ok(lines.includes('rpcHost=rpc.example.test'));
  assert.ok(lines.includes('ticketTimeoutMs=6000'));
  const joined = lines.join('\n');
  assert.equal(joined.includes('rpc-password'), false);
  assert.equal(joined.includes('secret'), false);
});

test('public configuration contains only the approved non-secret fields', () => {
  const lines = publicConfigurationLines({
    walletAddress: '0x1111111111111111111111111111111111111111',
    armed: false,
    config: {
      privateKey: PRIVATE_KEY,
      rpcUrl: RPC_URL,
      ticketUrl: TICKET_URL,
      ticketTimeoutMs: 6000,
      pollIntervalMs: 5000,
      maxGasLimit: 500000n,
      maxFeePerGasGwei: 5,
      confirmations: 1,
      failedReceiptRetries: 0,
    },
  });

  assert.deepEqual(lines, [
    'mode=single',
    'armed=false',
    'wallet=0x1111111111111111111111111111111111111111',
    'chainId=4663',
    'contract=0xa3F56AdB32D3A8F3b41462e3fBF17f36829325bE',
    'rpcHost=rpc.example.test',
    'ticketTimeoutMs=6000',
    'pollIntervalMs=5000',
    'maxGasLimit=500000',
    'maxFeePerGasGwei=5',
    'confirmations=1',
    'failedReceiptRetries=0',
    'discordNotifications=false',
  ]);
  assert.equal(lines.join('\n').includes(PRIVATE_KEY), false);
  assert.equal(lines.join('\n').includes('rpc-query-key'), false);
  assert.equal(lines.join('\n').includes('ticket-query-key'), false);
});

test('ARM=true and --arm share one fail-closed entry gate', () => {
  assert.equal(resolveArmed({ arm: false }, ['node', 'src/index.js']), false);
  assert.equal(resolveArmed({ arm: true }, ['node', 'src/index.js']), true);
  assert.equal(resolveArmed({ arm: false }, ['node', 'src/index.js', '--arm']), true);
});

test('armed proxy gate accepts only a complete unique stable report', () => {
  const report = {
    ready: true,
    results: [{}, {}],
    duplicates: [],
    failedIndices: [],
    unstableIndices: [],
  };

  assert.doesNotThrow(() => assertProxyPreflightReady(report, 2));
});

test('armed proxy gate fails closed before mint when any proxy is unavailable', () => {
  const report = {
    ready: false,
    results: [{}, {}],
    duplicates: [],
    failedIndices: [1],
    unstableIndices: [],
  };

  assert.throws(
    () => assertProxyPreflightReady(report, 2),
    /proxy preflight not ready.*failed=1/,
  );
});

test('armed proxy gate fails closed on duplicate or unstable egress IPs', () => {
  assert.throws(
    () =>
      assertProxyPreflightReady(
        {
          ready: false,
          results: [{}, {}],
          duplicates: ['1.1.1.1'],
          failedIndices: [],
          unstableIndices: [0],
        },
        2,
      ),
    /duplicates=1.*unstable=1/,
  );
});

test('armed proxy gate fails closed when fewer proxies were checked than wallets', () => {
  assert.throws(
    () =>
      assertProxyPreflightReady(
        {
          ready: true,
          results: [{}],
          duplicates: [],
          failedIndices: [],
          unstableIndices: [],
        },
        2,
      ),
    /checked=1\/2/,
  );
});

test('proxy cleanup closes every live dispatcher once', async () => {
  const calls = [];
  const first = { async close() { calls.push('first'); } };
  const second = { async close() { calls.push('second'); } };

  await closeProxyDispatchers([first, undefined, second, first]);

  assert.deepEqual(calls.sort(), ['first', 'second']);
});

test('proxy cleanup attempts every close and does not throw when one close fails', async () => {
  const calls = [];
  await assert.doesNotReject(() =>
    closeProxyDispatchers([
      { async close() { calls.push('bad'); throw new Error('close failed'); } },
      { async close() { calls.push('good'); } },
    ]),
  );
  assert.deepEqual(calls.sort(), ['bad', 'good']);
});

test('dispatcher construction failure closes dispatchers already created', async () => {
  const calls = [];
  let created = 0;
  await assert.rejects(
    () =>
      createProxyDispatchers({
        wallets: [{}, {}],
        proxies: ['first', 'bad'],
        config: { walletCount: 2, allowProxyReuse: false },
        armed: true,
        log() {},
        create() {
          created += 1;
          if (created === 2) throw new Error('invalid proxy');
          return { async close() { calls.push('closed'); } };
        },
      }),
    /invalid proxy/,
  );
  assert.deepEqual(calls, ['closed']);
});

test('armed proxy preflight is deferred until the Mint-open hook runs', async () => {
  assert.equal(typeof cli.prepareProxyPreflight, 'function');
  let reportCalls = 0;
  const beforeFanOut = await cli.prepareProxyPreflight({
    armed: true,
    dispatchers: [{}, {}],
    expectedCount: 2,
    log() {},
    async report() {
      reportCalls += 1;
      return {
        ready: true,
        results: [{}, {}],
        duplicates: [],
        failedIndices: [],
        unstableIndices: [],
      };
    },
  });

  assert.equal(reportCalls, 0);
  assert.equal(typeof beforeFanOut, 'function');
  await beforeFanOut();
  assert.equal(reportCalls, 1);
});

test('dry-run proxy preflight performs no report or egress work and returns no Mint-open hook', async () => {
  assert.equal(typeof cli.prepareProxyPreflight, 'function');
  let reportCalls = 0;
  const beforeFanOut = await cli.prepareProxyPreflight({
    armed: false,
    dispatchers: [{}, {}],
    expectedCount: 2,
    log() {},
    async report() {
      reportCalls += 1;
      return { ready: false };
    },
  });

  assert.equal(reportCalls, 0);
  assert.equal(beforeFanOut, undefined);
});

function addressFor(index) {
  return `0x${String(index + 1).padStart(40, '0')}`;
}

function multiConfig(overrides = {}) {
  return {
    mode: 'multi',
    arm: false,
    mnemonic: 'test test test test test test test test test test test junk',
    walletCount: 3,
    derivationPathBase: "m/44'/60'/0'/0",
    proxyFile: 'ignored-by-injected-loader.txt',
    staticProxyCount: 2,
    dynamicProxyCount: 1,
    proxyApiUrl: PROXY_API_URL,
    proxyApiTimeoutMs: 1234,
    proxyCheckTimeoutMs: 2345,
    proxyMaxReplacements: 4,
    proxyPoolDeadlineMs: 3456,
    proxyPreheat: false,
    proxyPreheatRecheckMs: 0,
    mintConcurrency: 2,
    rpcUrl: 'https://rpc.example.test',
    ticketUrl: 'https://tickets.example.test',
    ticketTimeoutMs: 6789,
    pollIntervalMs: 10,
    maxGasLimit: 500000n,
    maxFeePerGasGwei: 5,
    confirmations: 1,
    ...overrides,
  };
}

function makeWalletEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    address: addressFor(index),
    wallet: {
      chain: {
        async hasMinted() {
          return false;
        },
      },
    },
  }));
}

function makeBaseDependencies({
  wallets = makeWalletEntries(3),
  proxies = ['socks5h://static-0.test:1080', 'socks5h://static-1.test:1080'],
  provider = { async getBalance() { return 3_000_000_000_000_000n; } },
  pool,
  fetchFn = async () => ({ ok: true, status: 200, async json() { return {}; } }),
  monitorChain = {
    async getChainId() { return 4663; },
    async isMintOpen() { return false; },
    async totalMinted() { return 1n; },
  },
  runMultiMint: runMultiMintOverride,
  verifyEgressIps: verifyEgressIpsOverride,
  createProxyApiClient: createProxyApiClientOverride,
} = {}) {
  const stateStores = wallets.map(() => ({
    async load() { return null; },
    async reservePrepared() {},
    async markTicketRequested() {},
  }));
  return {
    fetchFn,
    createProvider() { return provider; },
    deriveWallets() { return wallets; },
    async loadProxies() { return proxies; },
    createContract() { return {}; },
    createMonitorChain() { return monitorChain; },
    createEthersChain({ wallet }) { return wallet.chain; },
    async createWalletStateStores() { return stateStores; },
    createTicketClient,
    createDispatcher(url) { return { url, async close() {} }; },
    createProxyApiClient: createProxyApiClientOverride ?? (() => ({
      async acquire() {
        throw new Error('unexpected proxy API call');
      },
    })),
    createHybridProxyPool() {
      return pool ?? {
        async prepare() { throw new Error('unexpected proxy pool prepare'); },
        dispatcherFor() { throw new Error('proxy pool is not prepared and locked'); },
        async close() {},
      };
    },
    verifyEgressIps: verifyEgressIpsOverride ?? (async () => {
      throw new Error('unexpected egress verification');
    }),
    ...(runMultiMintOverride ? { runMultiMint: runMultiMintOverride } : {}),
  };
}

test('gas preflight uses mintConcurrency and treats RPC failures as not ready', async () => {
  const wallets = makeWalletEntries(5);
  let active = 0;
  let peak = 0;
  const provider = {
    async getBalance(address) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const index = wallets.findIndex((wallet) => wallet.address === address);
      if (index === 2) throw new Error('RPC unavailable');
      if (index === 1) return 1n;
      return 3_000_000_000_000_000n;
    },
  };

  const report = await reportGasBalances({
    provider,
    wallets,
    config: multiConfig({ walletCount: 5, staticProxyCount: 5, dynamicProxyCount: 0 }),
    log() {},
  });

  assert.ok(peak <= 2, `peak gas concurrency ${peak} exceeded 2`);
  assert.equal(report.underfunded, 1);
  assert.equal(report.unavailable, 1);
  assert.equal(report.ready, false);
});

test('multi runner requires exactly STATIC_PROXY_COUNT entries before creating a pool', async () => {
  let poolCreations = 0;
  const deps = makeBaseDependencies({ proxies: ['socks5h://only-one.test:1080'] });
  deps.createHybridProxyPool = () => {
    poolCreations += 1;
    throw new Error('pool should not be created');
  };

  await assert.rejects(
    () => runMultiWallet({
      config: multiConfig(),
      log() {},
      signal: new AbortController().signal,
      deps,
    }),
    /expected exactly 2 static proxies, found 1/,
  );
  assert.equal(poolCreations, 0);
});

test('multi runner can source wallets from a private key file loader', async () => {
  let loadedFilePath = '';
  let deriveCalls = 0;
  const wallets = makeWalletEntries(2);
  const deps = makeBaseDependencies({
    wallets,
    proxies: ['socks5h://static-0.test:1080', 'socks5h://static-1.test:1080'],
    runMultiMint: async ({ wallets: runtimeWallets }) => ({
      results: runtimeWallets.map(({ index, address }) => ({
        index,
        address,
        status: 'dry-run-ready',
      })),
      summary: { 'dry-run-ready': runtimeWallets.length },
    }),
  });
  deps.deriveWallets = () => {
    deriveCalls += 1;
    throw new Error('deriveWallets should not be called');
  };
  deps.loadPrivateKeyWallets = async ({ filePath, count }) => {
    loadedFilePath = filePath;
    assert.equal(count, 2);
    return wallets;
  };

  const report = await runMultiWallet({
    config: multiConfig({
      mnemonic: undefined,
      privateKeysFile: 'wallets.txt',
      walletCount: 2,
      staticProxyCount: 2,
      dynamicProxyCount: 0,
      proxyApiUrl: undefined,
    }),
    log() {},
    signal: new AbortController().signal,
    deps,
  });

  assert.equal(deriveCalls, 0);
  assert.match(loadedFilePath, /wallets\.txt$/);
  assert.equal(report.summary['dry-run-ready'], 2);
});

test('multi runner passes deduplicated reserve proxies as replacement client', async () => {
  const wallets = makeWalletEntries(2);
  let reserveInput = null;
  let replacementClientSeen = null;
  const replacementClient = { async acquire() { return []; } };
  const pool = {
    async prepare() {},
    dispatcherFor() { throw new Error('proxy pool is not prepared and locked'); },
    async close() {},
  };
  const deps = makeBaseDependencies({
    wallets,
    pool,
    runMultiMint: async ({ wallets: runtimeWallets }) => ({
      results: runtimeWallets.map(({ index, address }) => ({
        index,
        address,
        status: 'dry-run-ready',
      })),
      summary: { 'dry-run-ready': runtimeWallets.length },
    }),
  });
  deps.loadProxies = async (filePath) => {
    if (filePath === 'main-proxies.txt') {
      return ['socks5h://static-0.test:1080', 'socks5h://static-1.test:1080'];
    }
    if (filePath === 'reserve-proxies.txt') {
      return [
        'socks5h://static-0.test:1080',
        'socks5h://reserve-0.test:1080',
        'socks5h://reserve-0.test:1080',
        'socks5h://reserve-1.test:1080',
      ];
    }
    throw new Error(`unexpected proxy file ${filePath}`);
  };
  deps.createReserveProxyClient = ({ proxyUrls }) => {
    reserveInput = proxyUrls;
    return replacementClient;
  };
  deps.createHybridProxyPool = (options) => {
    replacementClientSeen = options.replacementClient;
    return pool;
  };

  await runMultiWallet({
    config: multiConfig({
      walletCount: 2,
      staticProxyCount: 2,
      dynamicProxyCount: 0,
      proxyApiUrl: undefined,
      proxyFile: 'main-proxies.txt',
      proxyReserveFile: 'reserve-proxies.txt',
    }),
    log() {},
    signal: new AbortController().signal,
    deps,
  });

  assert.deepEqual(reserveInput, [
    'socks5h://reserve-0.test:1080',
    'socks5h://reserve-1.test:1080',
  ]);
  assert.equal(replacementClientSeen, replacementClient);
});

test('multi dry-run defers dynamic API and egress until Mint opens and never silently direct-connects Ticket', async () => {
  let apiClientCreations = 0;
  let apiCalls = 0;
  let prepareCalls = 0;
  let egressCalls = 0;
  let closeCalls = 0;
  let ticketFetchCalls = 0;
  const ticketClients = [];
  const logs = [];
  const pool = {
    async prepare() { prepareCalls += 1; },
    dispatcherFor() { throw new Error('proxy pool is not prepared and locked'); },
    async close() { closeCalls += 1; },
  };
  const deps = makeBaseDependencies({
    pool,
    fetchFn: async () => {
      ticketFetchCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
    createProxyApiClient(options) {
      apiClientCreations += 1;
      assert.equal(options.timeoutMs, 1234);
      return { async acquire() { apiCalls += 1; return []; } };
    },
    verifyEgressIps: async () => {
      egressCalls += 1;
      return { results: [] };
    },
  });
  deps.createTicketClient = (options) => {
    assert.equal(options.requireDispatcher, true);
    assert.equal(typeof options.getDispatcher, 'function');
    assert.equal(options.timeoutMs, 6789);
    assert.equal(options.signal instanceof AbortSignal, true);
    const client = createTicketClient(options);
    ticketClients.push(client);
    return client;
  };

  const report = await runMultiWallet({
    config: multiConfig(),
    log(line) { logs.push(line); },
    signal: new AbortController().signal,
    deps,
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(apiClientCreations, 1);
  assert.equal(apiCalls, 0);
  assert.equal(prepareCalls, 0);
  assert.equal(egressCalls, 0);
  assert.equal(ticketFetchCalls, 0);
  assert.equal(closeCalls, 1);
  assert.ok(logs.some((line) => line.includes('dynamic proxies deferred until mintOpen')));
  await assert.rejects(ticketClients[0].request(addressFor(0)), /not prepared and locked/);
  assert.equal(ticketFetchCalls, 0);
});

test('multi runner preserves its primary failure when proxy pool cleanup also fails', async () => {
  const primaryError = new Error('primary runner failure');
  let closeCalls = 0;
  const deps = makeBaseDependencies({
    pool: {
      async prepare() {},
      dispatcherFor() { return {}; },
      async close() {
        closeCalls += 1;
        throw new Error('proxy pool cleanup failure');
      },
    },
    runMultiMint: async () => {
      throw primaryError;
    },
  });

  await assert.rejects(
    () => runMultiWallet({
      config: multiConfig(),
      log() {},
      signal: new AbortController().signal,
      deps,
    }),
    (error) => {
      assert.equal(error, primaryError);
      return true;
    },
  );
  assert.equal(closeCalls, 1);
});

test('stable pool egress requires the same successful IP in two rounds', async () => {
  let calls = 0;
  const stable = await verifyStablePoolEgress(['d0', 'd1'], {
    verify: async () => {
      calls += 1;
      return {
        results: [
          { index: 0, ok: true, ip: '203.0.113.1' },
          { index: 1, ok: true, ip: calls === 1 ? '203.0.113.2' : '203.0.113.3' },
        ],
      };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(stable.results, [
    { index: 0, ok: true, ip: '203.0.113.1' },
    { index: 1, ok: false, ip: null },
  ]);
});

test('armed runner starts monitoring while gas checks run, then uses two egress rounds before fan-out', async () => {
  const wallets = makeWalletEntries(3);
  let releaseBalances;
  const balanceGate = new Promise((resolve) => {
    releaseBalances = resolve;
  });
  const provider = {
    async getBalance() {
      await balanceGate;
      return 3_000_000_000_000_000n;
    },
  };
  let runnerEntered = false;
  let prepareCalls = 0;
  let closeCalls = 0;
  let verifyCalls = 0;
  let poolOptions;
  const deps = makeBaseDependencies({
    wallets,
    provider,
    monitorChain: {},
    runMultiMint: async ({ wallets: walletUnits, beforeFanOut }) => {
      runnerEntered = true;
      await beforeFanOut({ pending: walletUnits });
      return Object.freeze({
        mode: 'armed',
        mintOpen: true,
        results: [],
        summary: {},
      });
    },
    verifyEgressIps: async (dispatchers, options) => {
      verifyCalls += 1;
      assert.equal(options.timeoutMs, 2345);
      assert.equal(dispatchers.length, 1);
      return { results: [{ index: 0, ok: true, ip: '203.0.113.1' }] };
    },
  });
  deps.createHybridProxyPool = (options) => {
    poolOptions = options;
    return {
      async prepare({ indexes }) {
        prepareCalls += 1;
        assert.deepEqual(indexes, [0, 1, 2]);
        await options.verifyEgressIps([{ id: 'dispatcher' }]);
      },
      dispatcherFor(index) { return { index }; },
      async close() { closeCalls += 1; },
    };
  };

  const runPromise = runMultiWallet({
    config: multiConfig({ arm: true }),
    log() {},
    signal: new AbortController().signal,
    deps,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runnerEntered, true, 'runMultiMint did not start while gas RPC reads were pending');
  assert.equal(prepareCalls, 0, 'proxy pool prepared before gas preflight completed');
  releaseBalances();
  await runPromise;

  assert.equal(prepareCalls, 1);
  assert.equal(verifyCalls, 2);
  assert.equal(poolOptions.maxReplacements, 4);
  assert.equal(poolOptions.deadlineMs, 3456);
  assert.equal(closeCalls, 1);
});

test('armed runner can preheat proxy pool once before Mint-open fan-out', async () => {
  const wallets = makeWalletEntries(3);
  let prepareCalls = 0;
  let preparedResolve;
  const prepared = new Promise((resolve) => {
    preparedResolve = resolve;
  });
  const deps = makeBaseDependencies({
    wallets,
    runMultiMint: async ({ wallets: walletUnits, prepareBeforeMintOpen, beforeFanOut }) => {
      await prepareBeforeMintOpen({ pending: [walletUnits[1], walletUnits[2]] });
      await prepared;
      assert.equal(prepareCalls, 1);
      await beforeFanOut({ pending: [walletUnits[1], walletUnits[2]] });
      return Object.freeze({
        mode: 'armed',
        mintOpen: true,
        results: [],
        summary: {},
      });
    },
  });
  deps.createHybridProxyPool = () => ({
    async prepare({ indexes }) {
      prepareCalls += 1;
      assert.deepEqual(indexes, [1, 2]);
      preparedResolve();
      return Object.freeze({ ready: true, indexes, replacementCount: 0 });
    },
    dispatcherFor(index) { return { index }; },
    async close() {},
  });

  await runMultiWallet({
    config: multiConfig({ arm: true, proxyPreheat: true }),
    log() {},
    signal: new AbortController().signal,
    deps,
  });

  assert.equal(prepareCalls, 1);
});

test('armed runner rechecks only pending preheated assignments and stops the timer before fan-out', async () => {
  const wallets = makeWalletEntries(3);
  let prepareCalls = 0;
  let refreshCalls = 0;
  let refreshCountAtFanOut = 0;
  const deps = makeBaseDependencies({
    wallets,
    runMultiMint: async ({ wallets: walletUnits, prepareBeforeMintOpen, beforeFanOut }) => {
      const pending = [walletUnits[2]];
      await prepareBeforeMintOpen({ pending });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(refreshCalls >= 1);
      await beforeFanOut({ pending });
      refreshCountAtFanOut = refreshCalls;
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(refreshCalls, refreshCountAtFanOut);
      return Object.freeze({
        mode: 'armed',
        mintOpen: true,
        results: [],
        summary: {},
      });
    },
  });
  deps.createHybridProxyPool = () => ({
    async prepare({ indexes }) {
      prepareCalls += 1;
      assert.deepEqual(indexes, [2]);
      return Object.freeze({ ready: true, indexes, replacementCount: 0 });
    },
    async refresh({ indexes }) {
      refreshCalls += 1;
      assert.deepEqual(indexes, [2]);
      return Object.freeze({ ready: true, refreshed: true, indexes, replacementCount: 0 });
    },
    dispatcherFor(index) { return { index }; },
    async close() {},
  });

  await runMultiWallet({
    config: multiConfig({
      arm: true,
      proxyPreheat: true,
      proxyPreheatRecheckMs: 5,
    }),
    log() {},
    signal: new AbortController().signal,
    deps,
  });

  assert.equal(prepareCalls, 1);
  assert.ok(refreshCountAtFanOut >= 1);
});

test('armed gas failure stops before pool preparation and wallet side effects', async () => {
  const calls = [];
  const wallets = makeWalletEntries(3);
  wallets.forEach((entry) => {
    entry.wallet.chain = {
      async hasMinted() { return false; },
    };
  });
  const stateStores = wallets.map((entry) => ({
    async load() { return null; },
    async reservePrepared() { calls.push(`w${entry.index}:reserve`); },
    async markTicketRequested() { calls.push(`w${entry.index}:ticket-requested`); },
  }));
  let prepareCalls = 0;
  let ticketFetchCalls = 0;
  const deps = makeBaseDependencies({
    wallets,
    provider: {
      async getBalance(address) {
        if (address === wallets[0].address) return 1n;
        if (address === wallets[1].address) throw new Error('RPC unavailable');
        return 3_000_000_000_000_000n;
      },
    },
    pool: {
      async prepare() { prepareCalls += 1; },
      dispatcherFor() { return {}; },
      async close() {},
    },
    fetchFn: async () => {
      ticketFetchCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
    monitorChain: {
      async getChainId() { return 4663; },
      async isMintOpen() { return true; },
      async totalMinted() { return 1n; },
    },
  });
  deps.createWalletStateStores = async () => stateStores;

  await assert.rejects(
    () => runMultiWallet({
      config: multiConfig({ arm: true }),
      log() {},
      signal: new AbortController().signal,
      deps,
    }),
    /gas preflight not ready: underfunded=1 unavailable=1/,
  );

  assert.equal(prepareCalls, 0);
  assert.equal(ticketFetchCalls, 0);
  assert.equal(calls.filter((call) => call.endsWith(':reserve')).length, 0);
  assert.equal(calls.filter((call) => call.endsWith(':ticket-requested')).length, 0);
});
