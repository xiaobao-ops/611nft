import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Interface,
  Wallet,
  getBytes,
  solidityPackedKeccak256,
} from 'ethers';

import { createEthersChain, createMonitorChain, createTicketClient } from '../src/adapters.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SALT = `0x${'22'.repeat(32)}`;
const SIGNATURE = `0x${'33'.repeat(65)}`;
const TX_HASH = `0x${'44'.repeat(32)}`;
const CONTRACT_ADDRESS = '0xa3F56AdB32D3A8F3b41462e3fBF17f36829325bE';

test('Ticket client sends the wallet address as JSON and returns parsed JSON', async () => {
  const calls = [];
  const payload = { ok: true, live: true, salt: SALT, signature: SIGNATURE };
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
  });

  assert.deepEqual(await client.request(ADDRESS), payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/mint-ticket');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json' });
  assert.equal(calls[0].options.body, JSON.stringify({ address: ADDRESS }));
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test('Ticket client rejects HTTP failures without trusting the response body', async () => {
  let parsed = false;
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    fetchFn: async () => ({
      ok: false,
      status: 503,
      async json() {
        parsed = true;
        return { signature: SIGNATURE };
      },
    }),
  });

  await assert.rejects(client.request(ADDRESS), /Ticket API HTTP 503/);
  assert.equal(parsed, false);
});

test('Ticket client rejects a non-JSON success response', async () => {
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token');
      },
    }),
  });

  await assert.rejects(client.request(ADDRESS), /Ticket API returned invalid JSON/);
});

test('chain adapter passes Ticket fields to estimate and send exactly once', async () => {
  const calls = [];
  const mint = async (...args) => {
    calls.push(['mint', ...args]);
    return { hash: TX_HASH };
  };
  mint.estimateGas = async (...args) => {
    calls.push(['estimateGas', ...args]);
    return 250000n;
  };
  mint.staticCall = async (...args) => {
    calls.push(['staticCall', ...args]);
    return [];
  };
  const chain = createEthersChain({
    provider: {},
    wallet: { address: ADDRESS },
    contract: { mint },
  });
  const ticket = { salt: SALT, signature: SIGNATURE };

  assert.equal(await chain.estimateMint(ticket), 250000n);
  const overrides = Object.freeze({
    gasLimit: 250000n,
    maxFeePerGas: 4_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  assert.deepEqual(await chain.simulateMint(ticket, overrides), []);
  assert.deepEqual(await chain.sendMint(ticket, overrides), { hash: TX_HASH });
  assert.deepEqual(calls, [
    ['estimateGas', SALT, SIGNATURE],
    ['staticCall', SALT, SIGNATURE, overrides],
    ['mint', SALT, SIGNATURE, overrides],
  ]);
});

test('chain adapter exposes runner reads and maps transaction receipt status', async () => {
  const receipts = new Map([
    ['0xpending', null],
    ['0xconfirmed', { status: 1 }],
    ['0xfailed', { status: 0 }],
  ]);
  const provider = {
    async getNetwork() {
      return { chainId: 4663n };
    },
    async getFeeData() {
      return { maxFeePerGas: 2n, gasPrice: 1n };
    },
    async getTransactionReceipt(hash) {
      return receipts.get(hash);
    },
    async waitForTransaction(hash, confirmations) {
      return { hash, confirmations, status: 1 };
    },
  };
  const mint = async () => ({ hash: TX_HASH });
  mint.estimateGas = async () => 1n;
  const contract = {
    mint,
    async mintSigner() {
      return '0x2222222222222222222222222222222222222222';
    },
    async saltUsed(salt) {
      return salt === SALT;
    },
    async mintOpen() {
      return true;
    },
    async totalMinted() {
      return 21n;
    },
    async hasMinted(address) {
      return address === ADDRESS;
    },
  };
  const chain = createEthersChain({ provider, wallet: { address: ADDRESS }, contract });

  assert.equal(await chain.getChainId(), 4663n);
  assert.equal(await chain.isMintOpen(), true);
  assert.equal(await chain.totalMinted(), 21n);
  assert.equal(await chain.hasMinted(ADDRESS), true);
  assert.equal(
    await chain.getMintSigner(),
    '0x2222222222222222222222222222222222222222',
  );
  assert.equal(await chain.isSaltUsed(SALT), true);
  assert.deepEqual(await chain.getFeeData(), { maxFeePerGas: 2n, gasPrice: 1n });
  assert.equal(await chain.transactionStatus('0xpending'), 'pending');
  assert.equal(await chain.transactionStatus('0xconfirmed'), 'confirmed');
  assert.equal(await chain.transactionStatus('0xfailed'), 'failed');
  assert.deepEqual(await chain.waitForTransaction(TX_HASH, 2), {
    hash: TX_HASH,
    confirmations: 2,
    status: 1,
  });
});

test('chain adapter verifies the Minted event and final token owner from a receipt', async () => {
  const iface = new Interface([
    'event Minted(uint256 indexed id, address indexed to)',
  ]);
  const tokenId = 42n;
  const encoded = iface.encodeEventLog(iface.getEvent('Minted'), [tokenId, ADDRESS]);
  const contract = {
    target: CONTRACT_ADDRESS,
    interface: iface,
    async ownerOf(id, overrides) {
      assert.equal(id, tokenId);
      assert.deepEqual(overrides, { blockTag: 123 });
      return ADDRESS;
    },
    mint: Object.assign(async () => ({ hash: TX_HASH }), {
      estimateGas: async () => 1n,
    }),
  };
  const chain = createEthersChain({ provider: {}, wallet: { address: ADDRESS }, contract });

  assert.equal(
    await chain.verifyMintReceipt(
      {
        status: 1,
        blockNumber: 123,
        logs: [{ address: CONTRACT_ADDRESS, topics: encoded.topics, data: encoded.data }],
      },
      ADDRESS,
    ),
    tokenId,
  );
});

test('chain adapter validates a ticket against live chain id, contract, mintSigner, and salt state', async () => {
  const signer = new Wallet(`0x${'01'.repeat(32)}`);
  const digest = solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'bytes32'],
    ['ASCIICATS_MINT', 4663, CONTRACT_ADDRESS, ADDRESS, SALT],
  );
  const signature = await signer.signMessage(getBytes(digest));
  const calls = [];
  const contract = {
    target: CONTRACT_ADDRESS,
    async mintSigner() {
      calls.push('mintSigner');
      return signer.address;
    },
    async saltUsed(salt) {
      calls.push(`saltUsed:${salt}`);
      return false;
    },
    mint: Object.assign(async () => ({ hash: TX_HASH }), {
      estimateGas: async () => 1n,
    }),
  };
  const provider = {
    async getNetwork() {
      calls.push('getNetwork');
      return { chainId: 4663n };
    },
  };
  const chain = createEthersChain({ provider, wallet: { address: ADDRESS }, contract });

  await chain.verifyTicket({ salt: SALT, signature }, ADDRESS);
  assert.deepEqual(calls.sort(), ['getNetwork', 'mintSigner', `saltUsed:${SALT}`].sort());
});

test('chain adapter rejects a ticket whose salt is already used', async () => {
  const contract = {
    target: CONTRACT_ADDRESS,
    async mintSigner() {
      return '0x2222222222222222222222222222222222222222';
    },
    async saltUsed() {
      return true;
    },
    mint: Object.assign(async () => ({ hash: TX_HASH }), {
      estimateGas: async () => 1n,
    }),
  };
  const provider = {
    async getNetwork() {
      return { chainId: 4663n };
    },
  };
  const chain = createEthersChain({ provider, wallet: { address: ADDRESS }, contract });

  await assert.rejects(
    chain.verifyTicket({ salt: SALT, signature: SIGNATURE }, ADDRESS),
    /ticket salt already used/,
  );
});

test('chain adapter rejects a successful receipt without this wallet Minted event', async () => {
  const iface = new Interface([
    'event Minted(uint256 indexed id, address indexed to)',
  ]);
  const other = '0x2222222222222222222222222222222222222222';
  const encoded = iface.encodeEventLog(iface.getEvent('Minted'), [42n, other]);
  const contract = {
    target: CONTRACT_ADDRESS,
    interface: iface,
    async ownerOf() {
      return other;
    },
    mint: Object.assign(async () => ({ hash: TX_HASH }), {
      estimateGas: async () => 1n,
    }),
  };
  const chain = createEthersChain({ provider: {}, wallet: { address: ADDRESS }, contract });

  await assert.rejects(
    chain.verifyMintReceipt(
      {
        status: 1,
        blockNumber: 123,
        logs: [{ address: CONTRACT_ADDRESS, topics: encoded.topics, data: encoded.data }],
      },
      ADDRESS,
    ),
    /Minted event for wallet not found/,
  );
});

test('chain adapter rejects a Minted token not owned by the wallet', async () => {
  const iface = new Interface([
    'event Minted(uint256 indexed id, address indexed to)',
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent('Minted'), [42n, ADDRESS]);
  const contract = {
    target: CONTRACT_ADDRESS,
    interface: iface,
    async ownerOf() {
      return '0x2222222222222222222222222222222222222222';
    },
    mint: Object.assign(async () => ({ hash: TX_HASH }), {
      estimateGas: async () => 1n,
    }),
  };
  const chain = createEthersChain({ provider: {}, wallet: { address: ADDRESS }, contract });

  await assert.rejects(
    chain.verifyMintReceipt(
      {
        status: 1,
        blockNumber: 123,
        logs: [{ address: CONTRACT_ADDRESS, topics: encoded.topics, data: encoded.data }],
      },
      ADDRESS,
    ),
    /minted token owner mismatch/,
  );
});

test('chain adapter ignores a forged Minted-shaped log from another contract', async () => {
  const iface = new Interface([
    'event Minted(uint256 indexed id, address indexed to)',
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent('Minted'), [42n, ADDRESS]);
  const contract = {
    target: CONTRACT_ADDRESS,
    interface: iface,
    async ownerOf() {
      return ADDRESS;
    },
    mint: Object.assign(async () => ({ hash: TX_HASH }), {
      estimateGas: async () => 1n,
    }),
  };
  const chain = createEthersChain({ provider: {}, wallet: { address: ADDRESS }, contract });

  await assert.rejects(
    chain.verifyMintReceipt(
      {
        status: 1,
        blockNumber: 123,
        logs: [
          {
            address: '0x9999999999999999999999999999999999999999',
            topics: encoded.topics,
            data: encoded.data,
          },
        ],
      },
      ADDRESS,
    ),
    /Minted event for wallet not found/,
  );
});

test('chain adapter rejects an unknown receipt status', async () => {
  const mint = async () => ({ hash: TX_HASH });
  mint.estimateGas = async () => 1n;
  const chain = createEthersChain({
    provider: {
      async getTransactionReceipt() {
        return { status: 7 };
      },
    },
    wallet: { address: ADDRESS },
    contract: { mint },
  });

  await assert.rejects(
    chain.transactionStatus(TX_HASH),
    /unknown transaction receipt status/,
  );
});

test('Ticket client routes the request through a per-wallet dispatcher when provided', async () => {
  const calls = [];
  const dispatcher = { id: 'wallet-proxy' };
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    dispatcher,
    fetchFn: async (url, options) => {
      calls.push(options);
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    },
  });

  await client.request(ADDRESS);
  assert.equal(calls[0].dispatcher, dispatcher);
  assert.equal(calls[0].body, JSON.stringify({ address: ADDRESS }));
});

test('Ticket client reads the runtime dispatcher for every request', async () => {
  const dispatchers = [{ id: 'proxy-1' }, { id: 'proxy-2' }];
  const seen = [];
  let getterCalls = 0;
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    getDispatcher() {
      return dispatchers[getterCalls++];
    },
    fetchFn: async (url, options) => {
      seen.push(options.dispatcher);
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    },
  });

  await client.request(ADDRESS);
  await client.request(ADDRESS);

  assert.equal(getterCalls, 2);
  assert.deepEqual(seen, dispatchers);
});

test('Ticket client rejects ambiguous static and runtime dispatcher configuration', () => {
  assert.throws(
    () => createTicketClient({
      url: 'https://example.test/mint-ticket',
      dispatcher: { id: 'static-proxy' },
      getDispatcher() {
        return { id: 'runtime-proxy' };
      },
      fetchFn: async () => ({ ok: true, status: 200, async json() { return {}; } }),
    }),
    /dispatcher and getDispatcher cannot both be provided/,
  );
});

test('Ticket client does not fetch when a required dispatcher getter throws', async () => {
  let fetchCalls = 0;
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    requireDispatcher: true,
    getDispatcher() {
      throw new Error('proxy pool is not ready');
    },
    fetchFn: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });

  await assert.rejects(client.request(ADDRESS), /proxy pool is not ready/);
  assert.equal(fetchCalls, 0);
});

test('Ticket client fails closed when a required runtime dispatcher is unavailable', async () => {
  let fetchCalls = 0;
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    requireDispatcher: true,
    getDispatcher() {
      return undefined;
    },
    fetchFn: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });

  await assert.rejects(client.request(ADDRESS), /Ticket dispatcher is required/);
  assert.equal(fetchCalls, 0);
});

test('Ticket client omits the dispatcher key when none is configured', async () => {
  const calls = [];
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    fetchFn: async (url, options) => {
      calls.push(options);
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    },
  });

  await client.request(ADDRESS);
  assert.equal('dispatcher' in calls[0], false);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
});

test('Ticket client aborts a request at the configured timeout', async () => {
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    timeoutMs: 5,
    fetchFn: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  await assert.rejects(
    client.request(ADDRESS),
    /Ticket API request failed or timed out/,
  );
});

test('Ticket client timeout also covers a stalled JSON response body', async () => {
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    timeoutMs: 5,
    fetchFn: async (url, options) => ({
      ok: true,
      status: 200,
      json: async () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    }),
  });

  await assert.rejects(
    client.request(ADDRESS),
    /Ticket API request failed or timed out/,
  );
});

test('Ticket client composes caller cancellation with its hard timeout', async () => {
  const controller = new AbortController();
  let requestSignal;
  const client = createTicketClient({
    url: 'https://example.test/mint-ticket',
    timeoutMs: 60_000,
    signal: controller.signal,
    fetchFn: async (url, options) => {
      requestSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });

  const request = client.request(ADDRESS);
  controller.abort();
  await assert.rejects(request, /Ticket API request aborted/);
  assert.equal(requestSignal.aborted, true);
});

test('Ticket client rejects an invalid timeout before fetching', () => {
  assert.throws(
    () => createTicketClient({
      url: 'https://example.test/mint-ticket',
      timeoutMs: 0,
      fetchFn: async () => ({}),
    }),
    /Ticket API timeout must be a positive integer/,
  );
});

test('Ticket client rejects signal-shaped objects without AbortSignal methods', () => {
  assert.throws(
    () => createTicketClient({
      url: 'https://example.test/mint-ticket',
      signal: { aborted: false },
      fetchFn: async () => ({}),
    }),
    /Ticket API signal must be an AbortSignal/,
  );
});

test('monitor chain exposes read-only chain state without a wallet', async () => {
  const contract = {
    async mintOpen() {
      return false;
    },
    async totalMinted() {
      return 1n;
    },
  };
  const provider = {
    async getNetwork() {
      return { chainId: 4663n };
    },
  };
  const monitor = createMonitorChain({ provider, contract });

  assert.equal(await monitor.getChainId(), 4663n);
  assert.equal(await monitor.isMintOpen(), false);
  assert.equal(await monitor.totalMinted(), 1n);
});
