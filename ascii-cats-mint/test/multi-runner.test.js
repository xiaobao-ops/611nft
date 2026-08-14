import assert from 'node:assert/strict';
import test from 'node:test';

import { runMultiMint } from '../src/runner.js';

const VALID_SALT = `0x${'22'.repeat(32)}`;
const VALID_SIGNATURE = `0x${'33'.repeat(65)}`;
const VALID_TICKET = Object.freeze({
  ok: true,
  live: true,
  salt: VALID_SALT,
  signature: VALID_SIGNATURE,
});

function ticketFor(index) {
  return {
    ...VALID_TICKET,
    salt: `0x${String(index + 1).padStart(64, '0')}`,
  };
}

function addressFor(index) {
  return `0x${String(index + 1).padStart(40, '0')}`;
}

// A per-wallet fake whose chain mints successfully: hasMinted is false on the
// pre-send recheck and true on the post-send verify.
function makeWallet(index, calls, overrides = {}) {
  const address = addressFor(index);
  let mintedChecks = 0;
  let state = null;
  const txHash = `0x${String(index + 1).padStart(2, '0').repeat(32)}`;

  const chain = {
    async hasMinted() {
      mintedChecks += 1;
      calls.push(`w${index}:hasMinted:${mintedChecks}`);
      // 3 reads per success: phase-1 filter, pre-send recheck, post-send verify.
      return mintedChecks > 2;
    },
    async getFeeData() {
      return { maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, gasPrice: null };
    },
    async estimateMint() {
      calls.push(`w${index}:estimate`);
      return 250000n;
    },
    async verifyTicket() {
      calls.push(`w${index}:verifyTicket`);
    },
    async sendMint() {
      calls.push(`w${index}:send`);
      return { hash: txHash };
    },
    async waitForTransaction() {
      return { status: 1 };
    },
    async verifyMintReceipt() {
      calls.push(`w${index}:verifyMintReceipt`);
      return BigInt(index + 1);
    },
    async transactionStatus() {
      return 'pending';
    },
    ...overrides.chain,
  };

  const ticketClient = {
    async request() {
      calls.push(`w${index}:request`);
      return ticketFor(index);
    },
    ...overrides.ticketClient,
  };

  const stateStore = {
    async load() {
      return state;
    },
    async reservePrepared({ wallet }) {
      assert.equal(state, null);
      state = { status: 'prepared', wallet };
      calls.push(`w${index}:reserve`);
    },
    async markTicketRequested({ wallet }) {
      assert.equal(state?.status, 'prepared');
      assert.equal(state.wallet.toLowerCase(), wallet.toLowerCase());
      state = { status: 'ticket-requested', wallet };
      calls.push(`w${index}:ticket-requested`);
    },
    async saveSubmitted({ txHash, wallet }) {
      assert.equal(state?.status, 'ticket-requested');
      state = { status: 'submitted', txHash, wallet };
      calls.push(`w${index}:save`);
    },
    async clear() {
      state = null;
      calls.push(`w${index}:clear`);
    },
    ...overrides.stateStore,
  };

  return { index, address, chain, ticketClient, stateStore, txHash };
}

function makeMonitor(calls, { open = [true], totalMinted = 1n } = {}) {
  let reads = 0;
  return {
    async getChainId() {
      return 4663;
    },
    async isMintOpen() {
      const value = open[Math.min(reads, open.length - 1)];
      reads += 1;
      calls.push(`monitor:isMintOpen:${value}`);
      return value;
    },
    async totalMinted() {
      calls.push('monitor:totalMinted');
      return totalMinted;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    arm: true,
    mintConcurrency: 5,
    pollIntervalMs: 10,
    maxGasLimit: 500000n,
    maxFeePerGasGwei: 5,
    confirmations: 1,
    ...overrides,
  };
}

function runMultiMintWithReadyHook(options) {
  return runMultiMint({ beforeFanOut: async () => {}, ...options });
}

test('armed: mints every pending wallet once when Mint is open', async () => {
  const calls = [];
  const wallets = [0, 1, 2].map((i) => makeWallet(i, calls));
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets,
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.mode, 'armed');
  assert.equal(report.mintOpen, true);
  assert.equal(report.summary.minted, 3);
  assert.equal(report.results.length, 3);
  for (const [i, w] of wallets.entries()) {
    assert.deepEqual(report.results[i], { index: i, address: w.address, status: 'minted', txHash: w.txHash });
  }
  // Exactly one send per wallet.
  assert.equal(calls.filter((c) => c.endsWith(':send')).length, 3);
});

test('armed: emits one open event and one confirmed-success event per minted wallet', async () => {
  const calls = [];
  const events = [];
  const wallets = [0, 1, 2].map((i) => makeWallet(i, calls));

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets,
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
    onMintOpen: (event) => events.push({ type: 'open', ...event }),
    onMintSuccess: (event) => events.push({ type: 'success', ...event }),
  });

  assert.equal(report.summary.minted, 3);
  assert.deepEqual(events.filter((event) => event.type === 'open'), [
    { type: 'open', pendingCount: 3 },
  ]);
  const successes = events.filter((event) => event.type === 'success');
  assert.equal(successes.length, 3);
  assert.deepEqual(successes.map((event) => event.confirmedCount).sort((a, b) => a - b), [1, 2, 3]);
  assert.ok(successes.every((event) => event.totalCount === 3 && event.recovered === false));
});

test('armed: one wallet failure is isolated and the rest still mint', async () => {
  const calls = [];
  const wallets = [0, 1, 2].map((i) =>
    makeWallet(i, calls, i === 1
      ? { ticketClient: { async request() { calls.push('w1:request'); return { ok: true, live: true, salt: VALID_SALT, signature: 'bad' }; } } }
      : {}),
  );
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets,
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.summary.minted, 2);
  assert.equal(report.summary['needs-inspection'], 1);
  assert.equal(report.results[1].status, 'needs-inspection');
  assert.match(report.results[1].error, /invalid ticket signature/);
  // Wallet 1 retains the ambiguous Ticket state and never sends.
  assert.equal(calls.includes('w1:send'), false);
  assert.equal(calls.includes('w1:clear'), false);
  assert.equal(calls.filter((c) => c.endsWith(':send')).length, 2);
});

test('armed: redacts Ticket signatures embedded in per-wallet RPC errors', async () => {
  const calls = [];
  const wallet = makeWallet(0, calls, {
    chain: {
      async estimateMint() {
        throw new Error(`execution reverted transaction data=${VALID_SIGNATURE}`);
      },
    },
  });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets: [wallet],
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'needs-inspection');
  assert.equal(report.results[0].error.includes(VALID_SIGNATURE), false);
  assert.match(report.results[0].error, /\[redacted hex data\]/);
});

test('armed: redacts proxy credentials embedded in per-wallet network errors', async () => {
  const calls = [];
  const proxyUrl = 'socks5h://wallet-user:wallet-pass@127.0.0.1:1080';
  const wallet = makeWallet(0, calls, {
    ticketClient: {
      async request() {
        throw new Error(`proxy connection failed via ${proxyUrl}`);
      },
    },
  });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets: [wallet],
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'needs-inspection');
  assert.equal(report.results[0].error.includes('wallet-user'), false);
  assert.equal(report.results[0].error.includes('wallet-pass'), false);
  assert.match(report.results[0].error, /socks5h:\/\/\[redacted credentials\]@127\.0\.0\.1:1080/);
});

test('armed: treats unreadable state after a wallet error as needs-inspection', async () => {
  const calls = [];
  let loadCalls = 0;
  const wallet = makeWallet(0, calls, {
    ticketClient: {
      async request() {
        throw new Error('ticket response lost');
      },
    },
    stateStore: {
      async load() {
        loadCalls += 1;
        if (loadCalls === 1) return null;
        throw new Error('state file unreadable');
      },
    },
  });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets: [wallet],
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'needs-inspection');
  assert.match(report.results[0].error, /ticket response lost/);
  assert.equal(loadCalls, 2);
});

test('armed: recursively sanitizes known URLs in per-wallet nested errors', async () => {
  const calls = [];
  const proxyApiUrl =
    'https://api-user:api-pass@proxy-api.example.test/private/path?apikey=api-secret';
  const rpcUrl = 'https://rpc.example.test/v1/rpc-secret?token=query-secret';
  const wallet = makeWallet(0, calls, {
    ticketClient: {
      async request() {
        const error = new Error('ticket request failed', {
          cause: new Error(`proxy API failed at ${proxyApiUrl}`),
        });
        error.source = new Error('source exposed private and rpc-secret');
        error.errors = [new Error('nested exposed api-secret and query-secret')];
        throw error;
      },
    },
  });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig({ proxyApiUrl, rpcUrl }),
    wallets: [wallet],
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
  });

  const output = report.results[0].error;
  assert.equal(report.results[0].status, 'needs-inspection');
  assert.match(output, /ticket request failed/);
  assert.match(output, /proxy-api\.example\.test/);
  for (const secret of [
    proxyApiUrl,
    'api-user',
    'api-pass',
    'private',
    'path',
    'apikey',
    'api-secret',
    'rpc-secret',
    'token',
    'query-secret',
  ]) {
    assert.equal(output.includes(secret), false, `leaked ${secret}`);
  }
});

test('armed: duplicate salt returned to two wallets is claimed once before broadcast', async () => {
  const calls = [];
  const duplicateTicket = ticketFor(0);
  const wallets = [0, 1].map((i) =>
    makeWallet(i, calls, {
      ticketClient: {
        async request() {
          calls.push(`w${i}:request`);
          return duplicateTicket;
        },
      },
    }),
  );
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig({ mintConcurrency: 2 }),
    wallets,
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.summary.minted, 1);
  assert.equal(report.summary['needs-inspection'], 1);
  assert.match(
    report.results.find((result) => result.status === 'needs-inspection').error,
    /duplicate ticket salt in batch/,
  );
  assert.equal(calls.filter((call) => call.endsWith(':send')).length, 1);
});

test('dry-run: never requests a ticket, reserves, or sends', async () => {
  const calls = [];
  const wallets = [0, 1].map((i) => makeWallet(i, calls));
  const monitorChain = makeMonitor(calls, { open: [false] });
  let beforeFanOutCalls = 0;

  const report = await runMultiMintWithReadyHook({
    config: baseConfig({ arm: false }),
    wallets,
    monitorChain,
    sleep: async () => {},
    log: () => {},
    beforeFanOut: async () => {
      beforeFanOutCalls += 1;
    },
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.summary['dry-run-ready'], 2);
  assert.equal(beforeFanOutCalls, 0);
  assert.equal(calls.some((c) => c.endsWith(':request')), false);
  assert.equal(calls.some((c) => c.endsWith(':reserve')), false);
  assert.equal(calls.some((c) => c.endsWith(':send')), false);
});

test('dry-run: persisted submitted state is reported without waiting or clearing it', async () => {
  const calls = [];
  const wallet = makeWallet(0, calls, {
    stateStore: {
      async load() {
        calls.push('w0:load-submitted');
        return {
          status: 'submitted',
          txHash: `0x${'ab'.repeat(32)}`,
          wallet: addressFor(0),
        };
      },
      async clear() {
        calls.push('w0:clear');
      },
    },
    chain: {
      async transactionStatus() {
        calls.push('w0:transactionStatus');
        return 'confirmed';
      },
      async waitForTransaction() {
        calls.push('w0:waitForTransaction');
        return { status: 1 };
      },
    },
  });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig({ arm: false }),
    wallets: [wallet],
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'needs-inspection');
  assert.equal(calls.includes('w0:transactionStatus'), false);
  assert.equal(calls.includes('w0:waitForTransaction'), false);
  assert.equal(calls.includes('w0:clear'), false);
  assert.equal(calls.some((call) => /:reserve$|:request$|:send$/.test(call)), false);
});

test('filters out already-minted wallets without sending', async () => {
  const calls = [];
  const wallets = [0, 1].map((i) =>
    makeWallet(i, calls, i === 0
      ? { chain: { async hasMinted() { calls.push('w0:hasMinted'); return true; } } }
      : {}),
  );
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets,
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'already-minted');
  assert.equal(report.results[1].status, 'minted');
  assert.equal(calls.includes('w0:send'), false);
});

test('uses one shared monitor loop, not one per wallet', async () => {
  const calls = [];
  const wallets = [0, 1, 2].map((i) => makeWallet(i, calls));
  // Closed on the first read, open on the second — a single loop sleeps once.
  const monitorChain = makeMonitor(calls, { open: [false, true] });
  let sleeps = 0;

  await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets,
    monitorChain,
    sleep: async () => {
      sleeps += 1;
    },
    log: () => {},
  });

  // The monitor loop polled twice (one closed + one open) — shared across wallets.
  assert.equal(calls.filter((c) => c.startsWith('monitor:isMintOpen')).length, 2);
  assert.equal(sleeps, 1);
});

test('armed: runs beforeFanOut once after Mint opens and before wallet fan-out', async () => {
  const calls = [];
  const wallets = [0, 1].map((i) => makeWallet(i, calls));
  const monitorChain = makeMonitor(calls, { open: [false, true] });
  let beforeFanOutCalls = 0;
  let pendingEntries;

  await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets,
    monitorChain,
    sleep: async () => {
      assert.equal(beforeFanOutCalls, 0, 'proxy preflight ran while Mint was closed');
    },
    log: () => {},
    beforeFanOut: async ({ pending }) => {
      beforeFanOutCalls += 1;
      pendingEntries = pending;
      calls.push('proxy:preflight');
    },
  });

  assert.equal(beforeFanOutCalls, 1);
  assert.deepEqual(pendingEntries, wallets);
  const openIndex = calls.indexOf('monitor:isMintOpen:true');
  const preflightIndex = calls.indexOf('proxy:preflight');
  const firstFanOutIndex = calls.findIndex((call) =>
    /:reserve$|:request$|:send$/.test(call),
  );
  assert.ok(openIndex >= 0, 'Mint-open read was not recorded');
  assert.ok(preflightIndex > openIndex, 'proxy preflight must run after Mint opens');
  assert.ok(firstFanOutIndex > preflightIndex, 'proxy preflight must finish before wallet fan-out');
});

test('armed: beforeFanOut receives only wallets still pending after phase-one filtering', async () => {
  const calls = [];
  const alreadyMinted = makeWallet(0, calls, {
    chain: {
      async hasMinted() {
        calls.push('w0:hasMinted');
        return true;
      },
    },
  });
  const pending = makeWallet(1, calls);
  let hookPending;

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets: [alreadyMinted, pending],
    monitorChain: makeMonitor(calls, { open: [true] }),
    sleep: async () => {},
    log: () => {},
    async beforeFanOut(context) {
      hookPending = context.pending;
    },
  });

  assert.deepEqual(hookPending, [pending]);
  assert.equal(report.results[0].status, 'already-minted');
  assert.equal(report.results[1].status, 'minted');
});

test('armed: early proxy preparation receives only pending wallets and overlaps monitoring', async () => {
  const calls = [];
  const alreadyMinted = makeWallet(0, calls, {
    chain: {
      async hasMinted() {
        calls.push('w0:hasMinted');
        return true;
      },
    },
  });
  const pending = makeWallet(1, calls);
  let preparationPending;
  let releasePreparation;
  const preparation = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  let monitorObservedPreparation = false;
  const monitorChain = {
    async getChainId() {
      return 4663;
    },
    async isMintOpen() {
      monitorObservedPreparation = Boolean(preparationPending);
      releasePreparation();
      return true;
    },
    async totalMinted() {
      return 1n;
    },
  };

  await runMultiMint({
    config: baseConfig({ arm: true }),
    wallets: [alreadyMinted, pending],
    monitorChain,
    sleep: async () => {},
    log() {},
    prepareBeforeMintOpen: async ({ pending: entries }) => {
      preparationPending = entries;
      await preparation;
    },
    beforeFanOut: async () => {},
  });

  assert.deepEqual(preparationPending, [pending]);
  assert.equal(monitorObservedPreparation, true);
});

test('armed: beforeFanOut failure rejects the batch before any wallet side effect', async () => {
  const calls = [];
  const wallets = [0, 1].map((i) => makeWallet(i, calls));

  await assert.rejects(
    () =>
      runMultiMintWithReadyHook({
        config: baseConfig(),
        wallets,
        monitorChain: makeMonitor(calls, { open: [true] }),
        sleep: async () => {},
        log: () => {},
        beforeFanOut: async () => {
          calls.push('proxy:preflight');
          throw new Error('proxy not ready');
        },
      }),
    /proxy not ready/,
  );

  assert.equal(calls.filter((call) => call.endsWith(':request')).length, 0);
  assert.equal(calls.filter((call) => call.endsWith(':reserve')).length, 0);
  assert.equal(calls.filter((call) => call.endsWith(':send')).length, 0);
});

test('armed: missing beforeFanOut fails closed before any wallet side effect', async () => {
  const calls = [];
  const wallets = [makeWallet(0, calls)];

  await assert.rejects(
    () =>
      runMultiMint({
        config: baseConfig(),
        wallets,
        monitorChain: makeMonitor(calls, { open: [true] }),
        sleep: async () => {},
        log: () => {},
      }),
    /beforeFanOut is required in armed mode/,
  );

  assert.equal(calls.filter((call) => call.endsWith(':reserve')).length, 0);
  assert.equal(calls.filter((call) => call.endsWith(':request')).length, 0);
  assert.equal(calls.filter((call) => call.endsWith(':send')).length, 0);
});

test('recovers a wallet with a submitted transaction instead of resending', async () => {
  const calls = [];
  const recovering = makeWallet(0, calls, {
    stateStore: {
      async load() {
        return { status: 'submitted', txHash: `0x${'ab'.repeat(32)}`, wallet: addressFor(0), submittedAt: 'x' };
      },
      async clear() {
        calls.push('w0:clear');
      },
    },
    chain: {
      async transactionStatus() {
        return 'confirmed';
      },
      async waitForTransaction() {
        return { status: 1 };
      },
      async hasMinted() {
        return true;
      },
    },
  });
  const fresh = makeWallet(1, calls);
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets: [recovering, fresh],
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'minted');
  assert.equal(report.results[0].recovered, true);
  assert.equal(report.results[1].status, 'minted');
  assert.equal(calls.includes('w0:send'), false);
});

test('a wallet in prepared state is flagged for inspection without aborting others', async () => {
  const calls = [];
  const flagged = makeWallet(0, calls, {
    stateStore: {
      async load() {
        return { status: 'prepared', wallet: addressFor(0), preparedAt: 'x' };
      },
    },
  });
  const fresh = makeWallet(1, calls);
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig(),
    wallets: [flagged, fresh],
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.results[0].status, 'needs-inspection');
  assert.match(report.results[0].error, /prepared mint state requires manual inspection/);
  assert.equal(report.results[1].status, 'minted');
  assert.equal(calls.includes('w0:send'), false);
});

test('rejects the wrong chain before touching any wallet', async () => {
  const calls = [];
  const wallets = [makeWallet(0, calls)];
  const monitorChain = { ...makeMonitor(calls), async getChainId() { return 1; } };

  await assert.rejects(
    runMultiMintWithReadyHook({ config: baseConfig(), wallets, monitorChain, sleep: async () => {}, log: () => {} }),
    /wrong chain ID: expected 4663, received 1/,
  );
  assert.equal(calls.some((c) => c.endsWith(':send')), false);
});

test('never exceeds the configured mint concurrency during fan-out', async () => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const wallets = Array.from({ length: 8 }, (_, i) =>
    makeWallet(i, calls, {
      chain: {
        async hasMinted() {
          return false;
        },
        async estimateMint() {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return 250000n;
        },
        async getFeeData() {
          return { maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, gasPrice: null };
        },
        async sendMint() {
          return { hash: `0x${'cd'.repeat(32)}` };
        },
        async waitForTransaction() {
          return { status: 1 };
        },
      },
      // hasMinted always false would loop; override verify to true via stateStore-independent path:
    }),
  );
  // Post-send verify must pass; override hasMinted to a two-phase per wallet.
  for (const w of wallets) {
    let n = 0;
    w.chain.hasMinted = async () => {
      n += 1;
      return n > 2;
    };
  }
  const monitorChain = makeMonitor(calls, { open: [true] });

  const report = await runMultiMintWithReadyHook({
    config: baseConfig({ mintConcurrency: 3 }),
    wallets,
    monitorChain,
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(report.summary.minted, 8);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
});
