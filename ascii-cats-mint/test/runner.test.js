import assert from 'node:assert/strict';
import test from 'node:test';

import { runAutoMint, runSingleMint, waitForMintOpen } from '../src/runner.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const TX_HASH = `0x${'aa'.repeat(32)}`;
const RETRY_TX_HASH = `0x${'bb'.repeat(32)}`;
const VALID_SALT = `0x${'22'.repeat(32)}`;
const VALID_SIGNATURE = `0x${'33'.repeat(65)}`;
const VALID_TICKET_PAYLOAD = Object.freeze({
  ok: true,
  live: true,
  salt: VALID_SALT,
  signature: VALID_SIGNATURE,
});

function createHarness(overrides = {}) {
  const calls = [];
  const config = {
    pollIntervalMs: 25,
    maxGasLimit: 500000n,
    maxFeePerGasGwei: 5,
    confirmations: 1,
    ...overrides.config,
  };
  const chain = {
    async getChainId() {
      calls.push('getChainId');
      return 4663;
    },
    async hasMinted(address) {
      calls.push(`hasMinted:${address}`);
      return false;
    },
    async isMintOpen() {
      calls.push('isMintOpen');
      return false;
    },
    async totalMinted() {
      calls.push('totalMinted');
      return 123n;
    },
    async getFeeData() {
      calls.push('getFeeData');
      return {
        maxFeePerGas: 4_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gasPrice: null,
      };
    },
    async estimateMint(ticket) {
      calls.push(`estimateMint:${ticket.salt}`);
      return 250000n;
    },
    async simulateMint(ticket, overrides) {
      calls.push(`simulateMint:${ticket.salt}:${overrides.gasLimit}`);
    },
    async verifyTicket(ticket, address) {
      calls.push(`verifyTicket:${ticket.salt}:${address}`);
    },
    async sendMint(ticket, overrides) {
      calls.push(`sendMint:${ticket.salt}:${overrides.gasLimit}`);
      return { hash: TX_HASH };
    },
    async waitForTransaction(txHash, confirmations) {
      calls.push(`waitForTransaction:${txHash}:${confirmations}`);
      return { status: 1 };
    },
    async verifyMintReceipt(receipt, address) {
      calls.push(`verifyMintReceipt:${address}`);
      return 42n;
    },
    async transactionStatus(txHash) {
      calls.push(`transactionStatus:${txHash}`);
      return 'pending';
    },
    ...overrides.chain,
  };
  const ticketClient = {
    async request(address) {
      calls.push(`request:${address}`);
      return VALID_TICKET_PAYLOAD;
    },
    ...overrides.ticketClient,
  };
  const stateStore = {
    async load() {
      calls.push('state.load');
      return null;
    },
    async reservePrepared({ wallet }) {
      calls.push(`state.reserve:${wallet}`);
    },
    async markTicketRequested({ wallet }) {
      calls.push(`state.ticket-requested:${wallet}`);
    },
    async saveSubmitted({ txHash, wallet }) {
      calls.push(`state.save:${txHash}:${wallet}`);
    },
    async clear() {
      calls.push('state.clear');
    },
    ...overrides.stateStore,
  };
  const sleep =
    overrides.sleep ||
    (async (milliseconds) => {
      calls.push(`sleep:${milliseconds}`);
      throw new Error('stop after sleep');
    });

  return {
    calls,
    options: {
      config,
      walletAddress: WALLET,
      chain,
      ticketClient,
      stateStore,
      sleep,
      log: () => {},
    },
  };
}

test('rejects a chain ID other than the configured ASCII Cats chain', async () => {
  const { calls, options } = createHarness();
  options.chain.getChainId = async () => {
    calls.push('getChainId');
    return 1;
  };

  await assert.rejects(runAutoMint(options), /wrong chain ID: expected 4663, received 1/);
  assert.deepEqual(calls, ['getChainId']);
});

test('exits when the wallet has already minted without requesting a ticket', async () => {
  const { calls, options } = createHarness();
  options.chain.hasMinted = async (address) => {
    calls.push(`hasMinted:${address}`);
    return true;
  };

  const result = await runAutoMint(options);

  assert.deepEqual(result, { status: 'already-minted' });
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
});

test('single-wallet dry-run never requests a ticket, reserves state, or sends', async () => {
  const { calls, options } = createHarness({
    config: { arm: false },
    chain: {
      async isMintOpen() {
        calls.push('isMintOpen');
        return true;
      },
    },
  });

  const result = await runSingleMint(options);

  assert.equal(result.status, 'dry-run-ready');
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('state.reserve:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
});

test('single-wallet armed mode delegates to the real mint state machine', async () => {
  const { calls, options } = openMintHarness({ config: { arm: true } });

  const result = await runSingleMint(options);

  assert.equal(result.status, 'minted');
  assert.equal(calls.filter((call) => call.startsWith('request:')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
});

test('sleeps after observing a closed Mint before polling again', async () => {
  const { calls, options } = createHarness();

  await assert.rejects(runAutoMint(options), /stop after sleep/);

  assert.deepEqual(calls, [
    'getChainId',
    'state.load',
    `hasMinted:${WALLET}`,
    'isMintOpen',
    'totalMinted',
    'sleep:25',
  ]);
});

test('returns immediately on an open Mint without waiting for informational totalMinted', async () => {
  const logs = [];
  await waitForMintOpen({
    chain: {
      async isMintOpen() {
        return true;
      },
      async totalMinted() {
        throw new Error('totalMinted should not be read after Mint is open');
      },
    },
    config: { pollIntervalMs: 500 },
    sleep: async () => {
      throw new Error('should not sleep after Mint opens');
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(logs, ['mintOpen=true totalMinted=skipped']);
});

test('treats totalMinted failure as unavailable telemetry instead of a monitor failure', async () => {
  const logs = [];
  await assert.rejects(
    waitForMintOpen({
      chain: {
        async isMintOpen() {
          return false;
        },
        async totalMinted() {
          throw new Error('temporary RPC 429');
        },
      },
      config: { pollIntervalMs: 500 },
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 500);
        throw new Error('stop after normal poll sleep');
      },
      log: (line) => logs.push(line),
    }),
    /stop after normal poll sleep/,
  );

  assert.deepEqual(logs, ['mintOpen=false totalMinted=unavailable']);
});

function openMintHarness(overrides = {}) {
  const harness = createHarness(overrides);
  harness.options.chain.isMintOpen = async () => {
    harness.calls.push('isMintOpen');
    return true;
  };
  let mintedChecks = 0;
  harness.options.chain.hasMinted = async (address) => {
    mintedChecks += 1;
    harness.calls.push(`hasMinted:${address}:${mintedChecks}`);
    return mintedChecks > 2;
  };
  return harness;
}

test('sends once, persists the hash before waiting, verifies mint, and clears state', async () => {
  const { calls, options } = openMintHarness();

  const result = await runAutoMint(options);

  assert.deepEqual(result, { status: 'minted', txHash: TX_HASH });
  assert.deepEqual(calls, [
    'getChainId',
    'state.load',
    `hasMinted:${WALLET}:1`,
    'isMintOpen',
    `hasMinted:${WALLET}:2`,
    `state.reserve:${WALLET}`,
    `state.ticket-requested:${WALLET}`,
    `request:${WALLET}`,
    `verifyTicket:${VALID_SALT}:${WALLET}`,
    `estimateMint:${VALID_SALT}`,
    'getFeeData',
    `sendMint:${VALID_SALT}:250000`,
    `state.save:${TX_HASH}:${WALLET}`,
    `waitForTransaction:${TX_HASH}:1`,
    `verifyMintReceipt:${WALLET}`,
    `hasMinted:${WALLET}:3`,
    'state.clear',
  ]);
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('request:')).length, 1);
});

test('sends with the configured EIP-1559 cap as headroom and preserves priority fee', async () => {
  const { options } = openMintHarness();
  const auditedFeeData = Object.freeze({
    maxFeePerGas: 4_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gasPrice: 3_000_000_000n,
  });
  let receivedOverrides;
  options.chain.getFeeData = async () => auditedFeeData;
  options.chain.sendMint = async (ticket, overrides) => {
    receivedOverrides = overrides;
    return { hash: TX_HASH };
  };

  await runAutoMint(options);

  assert.deepEqual(receivedOverrides, {
    gasLimit: 250000n,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: auditedFeeData.maxPriorityFeePerGas,
  });
  assert.equal(Object.isFrozen(receivedOverrides), true);
});

test('does not send when the Ticket is invalid', async () => {
  const { calls, options } = openMintHarness();
  options.ticketClient.request = async (address) => {
    calls.push(`request:${address}`);
    return { ok: true, live: true, salt: VALID_SALT, signature: 'not-a-signature' };
  };

  await assert.rejects(runAutoMint(options), /invalid ticket signature/);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.ok(calls.includes(`state.reserve:${WALLET}`));
  assert.ok(calls.includes(`state.ticket-requested:${WALLET}`));
  assert.equal(calls.includes('state.clear'), false);
});

test('does not estimate or send when the ticket signer does not match mintSigner', async () => {
  const { calls, options } = openMintHarness();
  options.chain.verifyTicket = async (ticket, address) => {
    calls.push(`verifyTicket:${ticket.salt}:${address}`);
    throw new Error('ticket signer does not match on-chain mintSigner');
  };

  await assert.rejects(
    runAutoMint(options),
    /ticket signer does not match on-chain mintSigner/,
  );
  assert.equal(calls.some((call) => call.startsWith('estimateMint:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('does not estimate or send when the ticket salt is already used', async () => {
  const { calls, options } = openMintHarness();
  options.chain.verifyTicket = async (ticket, address) => {
    calls.push(`verifyTicket:${ticket.salt}:${address}`);
    throw new Error('ticket salt already used');
  };

  await assert.rejects(runAutoMint(options), /ticket salt already used/);
  assert.equal(calls.some((call) => call.startsWith('estimateMint:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('does not send when gas safety limits are exceeded', async () => {
  const { calls, options } = openMintHarness();
  options.chain.estimateMint = async (ticket) => {
    calls.push(`estimateMint:${ticket.salt}`);
    return 500001n;
  };

  await assert.rejects(runAutoMint(options), /gas estimate exceeds configured limit/);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.ok(calls.includes(`state.reserve:${WALLET}`));
  assert.equal(calls.includes('state.clear'), false);
});

for (const [name, configure, message] of [
  [
    'Ticket network timeout',
    (options) => {
      options.ticketClient.request = async () => {
        throw new Error('Ticket request timed out');
      };
    },
    /Ticket request timed out/,
  ],
  [
    'Ticket HTTP error',
    (options) => {
      options.ticketClient.request = async () => {
        throw new Error('Ticket HTTP 503');
      };
    },
    /Ticket HTTP 503/,
  ],
  [
    'Ticket JSON error',
    (options) => {
      options.ticketClient.request = async () => {
        throw new Error('invalid Ticket JSON');
      };
    },
    /invalid Ticket JSON/,
  ],
  [
    'Ticket verification error',
    (options) => {
      options.chain.verifyTicket = async () => {
        throw new Error('Ticket verification failed');
      };
    },
    /Ticket verification failed/,
  ],
  [
    'gas preflight error',
    (options) => {
      options.chain.estimateMint = async () => {
        throw new Error('gas preflight failed');
      };
    },
    /gas preflight failed/,
  ],
  [
    'broadcast error',
    (options) => {
      options.chain.sendMint = async () => {
        throw new Error('broadcast failed');
      };
    },
    /broadcast failed/,
  ],
]) {
  test(`${name} preserves ticket-requested state`, async () => {
    let status = null;
    const { calls, options } = openMintHarness();
    options.stateStore = {
      async load() {
        return status;
      },
      async reservePrepared({ wallet }) {
        status = { status: 'prepared', wallet };
      },
      async markTicketRequested({ wallet }) {
        assert.equal(status?.status, 'prepared');
        status = { status: 'ticket-requested', wallet };
      },
      async saveSubmitted({ txHash, wallet }) {
        status = { status: 'submitted', txHash, wallet };
      },
      async clear() {
        calls.push('state.clear');
        status = null;
      },
    };
    configure(options);

    await assert.rejects(runAutoMint(options), message);

    assert.equal(status?.status, 'ticket-requested');
    assert.equal(calls.includes('state.clear'), false);
  });
}

test('a failed receipt stops after one send and preserves submitted state', async () => {
  const { calls, options } = openMintHarness();
  options.chain.waitForTransaction = async (txHash, confirmations) => {
    calls.push(`waitForTransaction:${txHash}:${confirmations}`);
    return { status: 0 };
  };

  await assert.rejects(runAutoMint(options), /mint transaction failed/);
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
  assert.equal(calls.includes('state.clear'), false);
});

test('a failed receipt retries once after fresh simulation succeeds', async () => {
  const { calls, options } = openMintHarness({
    config: { failedReceiptRetries: 1 },
  });
  let sends = 0;
  let waits = 0;
  options.chain.sendMint = async (ticket, overrides) => {
    sends += 1;
    const txHash = sends === 1 ? TX_HASH : RETRY_TX_HASH;
    calls.push(`sendMint:${sends}:${ticket.salt}:${overrides.gasLimit}`);
    return { hash: txHash };
  };
  options.chain.waitForTransaction = async (txHash, confirmations) => {
    waits += 1;
    calls.push(`waitForTransaction:${txHash}:${confirmations}`);
    return { status: waits === 1 ? 0 : 1 };
  };

  const result = await runAutoMint(options);

  assert.deepEqual(result, { status: 'minted', txHash: RETRY_TX_HASH });
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 2);
  assert.equal(calls.filter((call) => call.startsWith('simulateMint:')).length, 1);
  assert.ok(
    calls.indexOf(`simulateMint:${VALID_SALT}:250000`) <
      calls.indexOf(`sendMint:2:${VALID_SALT}:250000`),
  );
  assert.ok(calls.includes(`state.save:${TX_HASH}:${WALLET}`));
  assert.ok(calls.includes(`state.save:${RETRY_TX_HASH}:${WALLET}`));
  assert.ok(calls.includes('state.clear'));
});

test('a failed receipt does not retry when the fresh simulation fails', async () => {
  const { calls, options } = openMintHarness({
    config: { failedReceiptRetries: 1 },
  });
  options.chain.waitForTransaction = async (txHash, confirmations) => {
    calls.push(`waitForTransaction:${txHash}:${confirmations}`);
    return { status: 0 };
  };
  options.chain.simulateMint = async (ticket, overrides) => {
    calls.push(`simulateMint:${ticket.salt}:${overrides.gasLimit}`);
    throw new Error('retry simulation failed');
  };

  await assert.rejects(runAutoMint(options), /retry simulation failed/);

  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('simulateMint:')).length, 1);
  assert.equal(calls.includes('state.clear'), false);
});

for (const invalidHash of [undefined, null, '', '0x1234', `0x${'gg'.repeat(32)}`]) {
  test(`invalid broadcast hash ${String(invalidHash)} preserves ticket-requested state`, async () => {
    let status = null;
    let saveCalls = 0;
    const { options } = openMintHarness();
    options.stateStore = {
      async load() {
        return status;
      },
      async reservePrepared({ wallet }) {
        status = { status: 'prepared', wallet };
      },
      async markTicketRequested({ wallet }) {
        status = { status: 'ticket-requested', wallet };
      },
      async saveSubmitted() {
        saveCalls += 1;
      },
      async clear() {
        status = null;
      },
    };
    options.chain.sendMint = async () => ({ hash: invalidHash });

    await assert.rejects(runAutoMint(options), /invalid transaction hash/);

    assert.equal(status?.status, 'ticket-requested');
    assert.equal(saveCalls, 0);
  });
}

test('a post-submit wait error stops after one send with the hash already persisted', async () => {
  const { calls, options } = openMintHarness();
  options.chain.waitForTransaction = async (txHash, confirmations) => {
    calls.push(`waitForTransaction:${txHash}:${confirmations}`);
    throw new Error('RPC wait interrupted');
  };

  await assert.rejects(runAutoMint(options), /RPC wait interrupted/);
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
  assert.ok(
    calls.indexOf(`state.save:${TX_HASH}:${WALLET}`) <
      calls.indexOf(`waitForTransaction:${TX_HASH}:1`),
  );
  assert.equal(calls.includes('state.clear'), false);
});

test('a confirmed receipt without a valid Minted event preserves submitted state', async () => {
  const { calls, options } = openMintHarness();
  options.chain.verifyMintReceipt = async (receipt, address) => {
    calls.push(`verifyMintReceipt:${address}`);
    throw new Error('Minted event for wallet not found');
  };

  await assert.rejects(runAutoMint(options), /Minted event for wallet not found/);
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
  assert.ok(calls.includes(`state.save:${TX_HASH}:${WALLET}`));
  assert.equal(calls.includes('state.clear'), false);
});

test('a confirmed Minted token owned by another address preserves submitted state', async () => {
  const { calls, options } = openMintHarness();
  options.chain.verifyMintReceipt = async (receipt, address) => {
    calls.push(`verifyMintReceipt:${address}`);
    throw new Error('minted token owner mismatch');
  };

  await assert.rejects(runAutoMint(options), /minted token owner mismatch/);
  assert.equal(calls.filter((call) => call.startsWith('sendMint:')).length, 1);
  assert.equal(calls.includes('state.clear'), false);
});

test('resumes a pending submitted transaction without requesting or sending again', async () => {
  const { calls, options } = createHarness();
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'submitted',
      txHash: TX_HASH,
      wallet: WALLET,
      submittedAt: '2026-07-12T00:00:00.000Z',
    };
  };
  options.chain.hasMinted = async (address) => {
    calls.push(`hasMinted:${address}`);
    return true;
  };

  const result = await runAutoMint(options);

  assert.deepEqual(result, { status: 'minted', txHash: TX_HASH, recovered: true });
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.ok(calls.indexOf(`transactionStatus:${TX_HASH}`) < calls.indexOf('state.clear'));
});

test('waits for configured confirmation depth before clearing an already-confirmed submitted transaction', async () => {
  const { calls, options } = createHarness({ config: { confirmations: 5 } });
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'submitted',
      txHash: TX_HASH,
      wallet: WALLET,
      submittedAt: '2026-07-12T00:00:00.000Z',
    };
  };
  options.chain.transactionStatus = async (txHash) => {
    calls.push(`transactionStatus:${txHash}`);
    return 'confirmed';
  };
  options.chain.hasMinted = async (address) => {
    calls.push(`hasMinted:${address}`);
    return true;
  };

  const result = await runAutoMint(options);

  assert.deepEqual(result, { status: 'minted', txHash: TX_HASH, recovered: true });
  assert.ok(calls.includes(`waitForTransaction:${TX_HASH}:5`));
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.ok(
    calls.indexOf(`waitForTransaction:${TX_HASH}:5`) <
      calls.indexOf(`hasMinted:${WALLET}`),
  );
  assert.ok(calls.indexOf(`hasMinted:${WALLET}`) < calls.indexOf('state.clear'));
});

test('an already-confirmed recovery wait error preserves state and never resends', async () => {
  const { calls, options } = createHarness({ config: { confirmations: 5 } });
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'submitted',
      txHash: TX_HASH,
      wallet: WALLET,
      submittedAt: '2026-07-12T00:00:00.000Z',
    };
  };
  options.chain.transactionStatus = async (txHash) => {
    calls.push(`transactionStatus:${txHash}`);
    return 'confirmed';
  };
  options.chain.waitForTransaction = async (txHash, confirmations) => {
    calls.push(`waitForTransaction:${txHash}:${confirmations}`);
    throw new Error('confirmation depth unavailable');
  };

  await assert.rejects(runAutoMint(options), /confirmation depth unavailable/);
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('a pending recovery wait error preserves state and never sends a replacement', async () => {
  const { calls, options } = createHarness();
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'submitted',
      txHash: TX_HASH,
      wallet: WALLET,
      submittedAt: '2026-07-12T00:00:00.000Z',
    };
  };
  options.chain.waitForTransaction = async (txHash, confirmations) => {
    calls.push(`waitForTransaction:${txHash}:${confirmations}`);
    throw new Error('recovery wait interrupted');
  };

  await assert.rejects(runAutoMint(options), /recovery wait interrupted/);
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('a failed submitted transaction stops recovery without automatically replacing it', async () => {
  const { calls, options } = createHarness();
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'submitted',
      txHash: TX_HASH,
      wallet: WALLET,
      submittedAt: '2026-07-12T00:00:00.000Z',
    };
  };
  options.chain.transactionStatus = async (txHash) => {
    calls.push(`transactionStatus:${txHash}`);
    return 'failed';
  };

  await assert.rejects(runAutoMint(options), /submitted mint transaction failed/);
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('does not log the complete Ticket signature', async () => {
  const messages = [];
  const { options } = openMintHarness();
  options.log = (message) => messages.push(String(message));

  await runAutoMint(options);

  assert.equal(messages.join('\n').includes(VALID_SIGNATURE), false);
});

test('caps monitor read retry delays', async () => {
  const { calls, options } = createHarness({ config: { pollIntervalMs: 40000 } });
  options.chain.isMintOpen = async () => {
    calls.push('isMintOpen');
    throw new Error('temporary read failure');
  };
  let sleeps = 0;
  options.sleep = async (milliseconds) => {
    calls.push(`sleep:${milliseconds}`);
    sleeps += 1;
    if (sleeps === 2) throw new Error('stop after capped retry');
  };

  await assert.rejects(runAutoMint(options), /stop after capped retry/);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('sleep:')),
    ['sleep:40000', 'sleep:60000'],
  );
});

test('prepared startup state stops for manual inspection without Ticket or send', async () => {
  const { calls, options } = createHarness();
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'prepared',
      wallet: WALLET,
      preparedAt: '2026-07-12T00:00:00.000Z',
    };
  };

  await assert.rejects(
    runAutoMint(options),
    /prepared mint state requires manual inspection/,
  );
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('ticket-requested startup state stops without requesting a second Ticket or sending', async () => {
  const { calls, options } = createHarness();
  options.stateStore.load = async () => {
    calls.push('state.load');
    return {
      status: 'ticket-requested',
      wallet: WALLET,
      ticketRequestedAt: '2026-07-12T00:00:00.000Z',
    };
  };

  await assert.rejects(
    runAutoMint(options),
    /ticket-requested mint state requires manual inspection/,
  );
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
  assert.equal(calls.includes('state.clear'), false);
});

test('save failure after broadcast leaves ticket-requested state and restart cannot resend', async () => {
  let state = null;
  let requests = 0;
  let sends = 0;
  const sharedStateStore = {
    async load() {
      return state;
    },
    async reservePrepared({ wallet }) {
      if (state) throw new Error('mint state already exists; manual inspection required');
      state = { status: 'prepared', wallet, preparedAt: '2026-07-12T00:00:00.000Z' };
    },
    async markTicketRequested({ wallet }) {
      if (state?.status !== 'prepared') throw new Error('prepared state missing');
      state = {
        status: 'ticket-requested',
        wallet,
        ticketRequestedAt: '2026-07-12T00:00:00.500Z',
      };
    },
    async saveSubmitted() {
      throw new Error('simulated disk failure after broadcast');
    },
    async clear() {
      state = null;
    },
  };

  function failedSaveRun() {
    const { options } = openMintHarness();
    options.stateStore = sharedStateStore;
    options.chain.hasMinted = async () => false;
    options.ticketClient.request = async () => {
      requests += 1;
      return VALID_TICKET_PAYLOAD;
    };
    options.chain.sendMint = async () => {
      sends += 1;
      return { hash: TX_HASH };
    };
    return runAutoMint(options);
  }

  await assert.rejects(failedSaveRun(), /simulated disk failure after broadcast/);
  assert.equal(state?.status, 'ticket-requested');
  await assert.rejects(
    failedSaveRun(),
    /ticket-requested mint state requires manual inspection/,
  );
  assert.equal(requests, 1);
  assert.equal(sends, 1);
});

test('two concurrent runners sharing a state reservation request and send at most once', async () => {
  let state = null;
  let requests = 0;
  let sends = 0;
  const sharedStateStore = {
    async load() {
      return state;
    },
    async reservePrepared({ wallet }) {
      if (state) throw new Error('mint state already exists; manual inspection required');
      state = { status: 'prepared', wallet, preparedAt: '2026-07-12T00:00:00.000Z' };
    },
    async markTicketRequested({ wallet }) {
      if (state?.status !== 'prepared') throw new Error('prepared state missing');
      state = {
        status: 'ticket-requested',
        wallet,
        ticketRequestedAt: '2026-07-12T00:00:00.500Z',
      };
    },
    async saveSubmitted({ txHash, wallet }) {
      state = {
        status: 'submitted',
        txHash,
        wallet,
        submittedAt: '2026-07-12T00:00:01.000Z',
      };
    },
    async clear() {
      state = null;
    },
  };

  let waiting = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });

  function concurrentRun() {
    const { options } = openMintHarness();
    options.stateStore = sharedStateStore;
    let mintedChecks = 0;
    options.chain.hasMinted = async () => {
      mintedChecks += 1;
      if (mintedChecks === 2) {
        waiting += 1;
        if (waiting === 2) release();
        await barrier;
        return false;
      }
      return mintedChecks > 2;
    };
    options.ticketClient.request = async () => {
      requests += 1;
      return VALID_TICKET_PAYLOAD;
    };
    options.chain.sendMint = async () => {
      sends += 1;
      return { hash: TX_HASH };
    };
    return runAutoMint(options);
  }

  const results = await Promise.allSettled([concurrentRun(), concurrentRun()]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(requests, 1);
  assert.equal(sends, 1);
});

test('rechecks hasMinted after Mint opens and exits before reservation or Ticket', async () => {
  const { calls, options } = createHarness();
  let openChecks = 0;
  options.chain.isMintOpen = async () => {
    calls.push('isMintOpen');
    openChecks += 1;
    return openChecks > 1;
  };
  let mintedChecks = 0;
  options.chain.hasMinted = async (address) => {
    calls.push(`hasMinted:${address}`);
    mintedChecks += 1;
    return mintedChecks > 1;
  };
  options.sleep = async (milliseconds) => {
    calls.push(`sleep:${milliseconds}`);
  };

  const result = await runAutoMint(options);

  assert.deepEqual(result, { status: 'already-minted' });
  assert.equal(calls.filter((call) => call.startsWith(`hasMinted:${WALLET}`)).length, 2);
  assert.equal(calls.some((call) => call.startsWith('state.reserve:')), false);
  assert.equal(calls.some((call) => call.startsWith('request:')), false);
  assert.equal(calls.some((call) => call.startsWith('sendMint:')), false);
});
