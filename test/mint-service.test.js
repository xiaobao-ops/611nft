import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeEventTopics, getAddress, keccak256, parseTransaction} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
  executeScheduledMintPlans,
  executeScheduledOpenSeaMintPlans,
  enforceSniperProtections,
  extractMintedErc721Tokens,
  assertSupportedMintSelector,
  assertOpenSeaCredentialMinimum,
  normalizeSubmission,
  previewMint,
  resolveScheduledAt,
  waitForChainTimestamp,
  ZERO_ADDRESS,
} from '../server/opensea-mint/mint-service.js';
import {encodeMintPublic} from '../server/opensea-mint/seadrop.js';

const CONTRACT = getAddress('0x1000000000000000000000000000000000000001');
const OWNER = getAddress('0x2000000000000000000000000000000000000002');
const SEADROP = getAddress('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');
const TRANSFER_ABI = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    {name: 'from', type: 'address', indexed: true},
    {name: 'to', type: 'address', indexed: true},
    {name: 'tokenId', type: 'uint256', indexed: true},
  ],
}];

test('normalizes a same-chain OpenSea transaction', () => {
  const transaction = normalizeSubmission({
    __typename: 'TransactionAction',
    transactionSubmissionData: {
      to: CONTRACT,
      data: '0x12345678',
      value: '100',
      chain: {identifier: 'ethereum', networkId: 1},
    },
  }, {chainIdentifier: 'ethereum', chainId: 1});
  assert.equal(transaction.to, CONTRACT);
  assert.equal(transaction.value, 100n);
});

test('rejects a transaction for a different chain', () => {
  assert.throws(() => normalizeSubmission({
    transactionSubmissionData: {
      to: CONTRACT,
      data: '0x12345678',
      value: '0',
      chain: {identifier: 'ethereum', networkId: 1},
    },
  }, {chainIdentifier: 'robinhood', chainId: 4663}), /expected robinhood/);
});

test('rejects OpenSea transaction selectors outside the SeaDrop mint adapter', () => {
  assert.throws(() => assertSupportedMintSelector('0x12345678'), /unsupported mint selector/);
});

test('enforces the configured OpenSea credential wallet minimum', () => {
  assert.throws(() => assertOpenSeaCredentialMinimum(1, 2), /credentials for 1 wallet.*minimum is 2/);
  assert.doesNotThrow(() => assertOpenSeaCredentialMinimum(2, 2));
});

test('extracts only ERC-721 tokens minted to the expected wallet', () => {
  const matchingTopics = encodeEventTopics({
    abi: TRANSFER_ABI,
    eventName: 'Transfer',
    args: {from: ZERO_ADDRESS, to: OWNER, tokenId: 42n},
  });
  const otherOwnerTopics = encodeEventTopics({
    abi: TRANSFER_ABI,
    eventName: 'Transfer',
    args: {from: ZERO_ADDRESS, to: CONTRACT, tokenId: 99n},
  });
  const receipt = {
    logs: [
      {address: CONTRACT, data: '0x', topics: matchingTopics},
      {address: CONTRACT, data: '0x', topics: otherOwnerTopics},
    ],
  };
  assert.deepEqual(extractMintedErc721Tokens(receipt, CONTRACT, OWNER), ['42']);
});

test('uses the on-chain start time for scheduled Mint and rejects unsafe timing', () => {
  const inspection = {drop: {startTime: 200, endTime: 300}};
  const scheduling = {preflightLeadMs: 3000, maxWaitMs: 120000};
  assert.equal(resolveScheduledAt({
    requestedScheduleAt: null,
    inspection,
    scheduling,
    nowMs: 150000,
  }), '1970-01-01T00:03:20.000Z');
  assert.throws(() => resolveScheduledAt({
    requestedScheduleAt: '1970-01-01T00:02:31.000Z',
    inspection,
    scheduling,
    nowMs: 150000,
  }), /inside the selected sale window/);
  assert.throws(() => resolveScheduledAt({
    requestedScheduleAt: '1970-01-01T00:03:20.000Z',
    inspection,
    scheduling,
    nowMs: 197000,
  }), /too close/);
});

test('enforces sniper price, gas, total, wallet-count, and supply limits', () => {
  const plans = [{
    account: {address: OWNER},
    transaction: {value: 4n},
    gasPrice: 3n,
    estimatedTotal: 10n,
  }];
  assert.throws(() => enforceSniperProtections({readyPlans: plans, quantity: 1n, protections: {maxMintPriceWei: 3n}}), /Mint price exceeds/);
  assert.throws(() => enforceSniperProtections({readyPlans: plans, quantity: 1n, protections: {maxGasPriceWei: 2n}}), /gas price exceeds/);
  assert.throws(() => enforceSniperProtections({readyPlans: plans, quantity: 1n, protections: {maxTotalWei: 9n}}), /batch total/);
  assert.throws(() => enforceSniperProtections({readyPlans: plans, quantity: 1n, protections: {minEligibleWallets: 2}}), /at least 2 eligible/);
  assert.throws(() => enforceSniperProtections({readyPlans: plans, quantity: 1n, inspection: {supplyLeft: '4'}, protections: {minSupply: 5n}}), /below the sniper minimum/);
});

test('uses sampled chain time while arming a scheduled Mint', async () => {
  const samples = [1000, 1060];
  const result = await waitForChainTimestamp({
    publicClient: {async getBlock() { return {timestamp: 1n}; }},
    targetMs: 1050,
    now: () => samples.shift() ?? 1060,
  });
  assert.ok(result.estimatedChainTime >= 1050);
  assert.equal(result.blockTimestamp, 1);
});

test('uses the local chain-time estimate inside the final second', async () => {
  let blockReads = 0;
  const result = await waitForChainTimestamp({
    publicClient: {async getBlock() { blockReads += 1; return {timestamp: 1n}; }},
    targetMs: 1500,
    now: () => 1000,
  });
  assert.equal(blockReads, 1);
  assert.equal(result.estimatedChainTime, 1500);
});

test('stops chain-time waiting when the scheduled task is aborted', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Stopped by test.', 'AbortError'));
  let blockReads = 0;
  await assert.rejects(waitForChainTimestamp({
    publicClient: {async getBlock() { blockReads += 1; return {timestamp: 1n}; }},
    targetMs: 5000,
    signal: controller.signal,
  }), (error) => error?.name === 'AbortError');
  assert.equal(blockReads, 0);
});

test('runs scheduled recheck, local signing, broadcast, and receipt flow', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const targetTimestamp = Math.floor(Date.now() / 1000);
  const feeRecipient = getAddress('0x3000000000000000000000000000000000000003');
  const seaDrop = getAddress('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');
  const data = encodeMintPublic({nftContract: CONTRACT, feeRecipient, quantity: 1n});
  let nonceReads = 0;
  let publicDropReads = 0;
  let sentRequest = null;
  const publicClient = {
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: BigInt(targetTimestamp)}; },
    async readContract({functionName, args}) {
      if (functionName === 'getPublicDrop') {
        publicDropReads += 1;
        return {
        mintPrice: 2n, startTime: targetTimestamp - 5, endTime: targetTimestamp + 60,
        maxTotalMintableByWallet: 3n, feeBps: 250, restrictFeeRecipients: true,
        };
      }
      if (functionName === 'getAllowedFeeRecipients') return [feeRecipient];
      if (functionName === 'getCreatorPayoutAddress') return account.address;
      if (functionName === 'name') return 'Scheduled NFT';
      if (functionName === 'getMintStats') return args[0] === ZERO_ADDRESS ? [0n, 1n, 10n] : [0n, 0n, 10n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
    async estimateFeesPerGas() { return {maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}; },
    async getTransactionCount() { nonceReads += 1; return 7; },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async sendRawTransaction({serializedTransaction}) {
      assert.match(serializedTransaction, /^0x[0-9a-f]+$/i);
      sentRequest = parseTransaction(serializedTransaction);
      return `0x${'ab'.repeat(32)}`;
    },
    async waitForTransactionReceipt() {
      return {status: 'success', blockNumber: 99n, logs: []};
    },
  };
  const plan = {
    account,
    transaction: {to: seaDrop, data, value: 2n},
    estimatedFee: 500000n,
    estimatedTotal: 2n,
    gasLimit: 250000n,
    directSeaDrop: {nftContract: CONTRACT, feeRecipient, quantity: 1n},
  };
  const stages = [];
  const wallets = [];
  const result = await executeScheduledMintPlans({
    preview: {publicClient, chain: {id: 1}, concurrency: 0, protections: {gasPriceWei: 5n, maxGasPriceWei: 5n}},
    plans: [plan],
    contractAddress: CONTRACT,
    scheduledAt: new Date((targetTimestamp - 1) * 1000).toISOString(),
    preflightLeadMs: 3000,
    signLeadMs: 200,
    onStage: (stage) => stages.push(stage),
    onWallet: (event) => wallets.push(event.status),
  });
  assert.deepEqual(stages, ['preflighting', 'signing', 'broadcasting']);
  assert.equal(result.results[0].type, 'confirmed');
  assert.equal(result.results[0].result.chainTimestamp, targetTimestamp);
  assert.equal(result.results[0].result.mintedAt, new Date(targetTimestamp * 1000).toISOString());
  assert.equal(publicDropReads, 1, 'public stage should only be checked during the preflight window');
  assert.ok(result.results[0].result.timestamps.preflightAt);
  assert.ok(result.results[0].result.timestamps.signedAt);
  assert.ok(result.results[0].result.timestamps.broadcastSubmittedAt);
  assert.equal(sentRequest.maxFeePerGas, 5n, 'public scheduled Mint should use the configured fixed gas');
  assert.equal(sentRequest.maxPriorityFeePerGas, 5n, 'fixed gas should also set the EIP-1559 priority fee');
  assert.deepEqual(wallets, ['preflighted', 'signed', 'sending', 'confirmed']);
  assert.equal(nonceReads, 1);
});

test('releases a public broadcast slot as soon as the RPC returns a hash', async () => {
  const accounts = [
    privateKeyToAccount(`0x${'21'.repeat(32)}`),
    privateKeyToAccount(`0x${'22'.repeat(32)}`),
  ];
  const targetTimestamp = Math.floor(Date.now() / 1000);
  const feeRecipient = getAddress('0x3100000000000000000000000000000000000003');
  const data = encodeMintPublic({nftContract: CONTRACT, feeRecipient, quantity: 1n});
  let broadcasts = 0;
  let releaseFirstReceipt;
  let markSecondBroadcast;
  const firstReceiptGate = new Promise((resolve) => { releaseFirstReceipt = resolve; });
  const secondBroadcasted = new Promise((resolve) => { markSecondBroadcast = resolve; });
  const publicClient = {
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: BigInt(targetTimestamp)}; },
    async readContract({functionName, args}) {
      if (functionName === 'getPublicDrop') return {
        mintPrice: 0n, startTime: targetTimestamp - 5, endTime: targetTimestamp + 60,
        maxTotalMintableByWallet: 3n, feeBps: 250, restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [feeRecipient];
      if (functionName === 'getCreatorPayoutAddress') return accounts[0].address;
      if (functionName === 'name') return 'Concurrent NFT';
      if (functionName === 'getMintStats') return args[0] === ZERO_ADDRESS ? [0n, 0n, 10n] : [0n, 0n, 10n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
    async estimateFeesPerGas() { return {maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}; },
    async getTransactionCount({address}) { return address === accounts[0].address ? 7 : 9; },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async sendRawTransaction() {
      broadcasts += 1;
      if (broadcasts === 2) markSecondBroadcast();
      return broadcasts === 1 ? `0x${'21'.repeat(32)}` : `0x${'22'.repeat(32)}`;
    },
    async waitForTransactionReceipt({hash}) {
      if (hash === `0x${'21'.repeat(32)}`) await firstReceiptGate;
      return {status: 'success', blockNumber: 101n, logs: []};
    },
  };
  const plans = accounts.map((account) => ({
    account,
    transaction: {to: SEADROP, data, value: 0n},
    gasLimit: 250000n,
    directSeaDrop: {nftContract: CONTRACT, feeRecipient, quantity: 1n},
  }));
  const execution = executeScheduledMintPlans({
    preview: {publicClient, chain: {id: 1}, concurrency: 2},
    plans,
    contractAddress: CONTRACT,
    scheduledAt: new Date(targetTimestamp * 1000).toISOString(),
    preflightLeadMs: 3000,
    signLeadMs: 1500,
    broadcastLeadMs: 100,
    broadcastConcurrency: 1,
    receiptConcurrency: 1,
    waitForTarget: async () => {},
  });
  let observationError = null;
  try {
    await Promise.race([
      secondBroadcasted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Second broadcast was blocked by the first receipt.')), 500)),
    ]);
    assert.equal(broadcasts, 2);
  } catch (error) {
    observationError = error;
  } finally {
    releaseFirstReceipt();
  }
  const result = await execution;
  if (observationError) throw observationError;
  assert.equal(result.results.filter((item) => item.type === 'confirmed').length, 2);
});

test('revalidates and signs a fresh nonce after a scheduled transaction reverts', async () => {
  const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
  const targetTimestamp = Math.floor(Date.now() / 1000);
  const feeRecipient = getAddress('0x4000000000000000000000000000000000000004');
  const data = encodeMintPublic({nftContract: CONTRACT, feeRecipient, quantity: 1n});
  let nonceReads = 0;
  let broadcasts = 0;
  const publicClient = {
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: BigInt(targetTimestamp)}; },
    async readContract({functionName, args}) {
      if (functionName === 'getPublicDrop') return {
        mintPrice: 0n, startTime: targetTimestamp - 5, endTime: targetTimestamp + 60,
        maxTotalMintableByWallet: 3n, feeBps: 250, restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [feeRecipient];
      if (functionName === 'getCreatorPayoutAddress') return account.address;
      if (functionName === 'name') return 'Retry NFT';
      if (functionName === 'getMintStats') return args[0] === ZERO_ADDRESS ? [0n, 1n, 10n] : [0n, 0n, 10n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
    async estimateFeesPerGas() { return {maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}; },
    async getTransactionCount() { nonceReads += 1; return nonceReads === 1 ? 7 : 8; },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async sendRawTransaction({serializedTransaction}) {
      broadcasts += 1;
      const request = parseTransaction(serializedTransaction);
      assert.equal(request.nonce, broadcasts === 1 ? 7 : 8);
      assert.equal(request.maxFeePerGas, 5n);
      assert.equal(request.maxPriorityFeePerGas, 5n);
      return broadcasts === 1 ? `0x${'aa'.repeat(32)}` : `0x${'bb'.repeat(32)}`;
    },
    async waitForTransactionReceipt({hash}) {
      return {
        status: hash === `0x${'aa'.repeat(32)}` ? 'reverted' : 'success',
        blockNumber: 100n,
        logs: [],
      };
    },
  };
  const plan = {
    account,
    transaction: {to: SEADROP, data, value: 0n},
    estimatedFee: 500000n,
    estimatedTotal: 500000n,
    gasLimit: 250000n,
    directSeaDrop: {nftContract: CONTRACT, feeRecipient, quantity: 1n},
  };
  const walletStates = [];
  const result = await executeScheduledMintPlans({
    preview: {publicClient, chain: {id: 1}, concurrency: 1, protections: {gasPriceWei: 5n}},
    plans: [plan],
    contractAddress: CONTRACT,
    scheduledAt: new Date(targetTimestamp * 1000).toISOString(),
    preflightLeadMs: 3000,
    signLeadMs: 1500,
    broadcastLeadMs: 1000,
    retry: {maxAttempts: 2, delayMs: 0},
    waitForTarget: async () => {},
    onWallet: ({status}) => walletStates.push(status),
  });
  assert.equal(result.results[0].type, 'confirmed');
  assert.equal(result.results[0].result.attempts, 2);
  assert.equal(broadcasts, 2);
  assert.equal(nonceReads, 2);
  assert.deepEqual(walletStates, ['preflighted', 'signed', 'sending', 'retrying', 'sending', 'confirmed']);
});

test('refreshes a stale nonce after a nonce-too-low broadcast rejection', async () => {
  const account = privateKeyToAccount(`0x${'55'.repeat(32)}`);
  const targetTimestamp = Math.floor(Date.now() / 1000);
  const feeRecipient = getAddress('0x4500000000000000000000000000000000000004');
  const data = encodeMintPublic({nftContract: CONTRACT, feeRecipient, quantity: 1n});
  let nonceReads = 0;
  let broadcasts = 0;
  const publicClient = {
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: BigInt(targetTimestamp)}; },
    async readContract({functionName, args}) {
      if (functionName === 'getPublicDrop') return {
        mintPrice: 0n, startTime: targetTimestamp - 5, endTime: targetTimestamp + 60,
        maxTotalMintableByWallet: 3n, feeBps: 250, restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [feeRecipient];
      if (functionName === 'getCreatorPayoutAddress') return account.address;
      if (functionName === 'name') return 'Nonce Retry NFT';
      if (functionName === 'getMintStats') return args[0] === ZERO_ADDRESS ? [0n, 0n, 10n] : [0n, 0n, 10n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
    async estimateFeesPerGas() { return {maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}; },
    async getTransactionCount() { nonceReads += 1; return nonceReads === 1 ? 3 : 4; },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async sendRawTransaction({serializedTransaction}) {
      broadcasts += 1;
      const request = parseTransaction(serializedTransaction);
      if (broadcasts === 1) {
        assert.equal(request.nonce, 3);
        throw new Error('nonce too low: next nonce 4, tx nonce 3');
      }
      assert.equal(request.nonce, 4);
      assert.equal(request.maxFeePerGas, 6n);
      assert.equal(request.maxPriorityFeePerGas, 6n);
      return `0x${'dd'.repeat(32)}`;
    },
    async waitForTransactionReceipt() {
      return {status: 'success', blockNumber: 102n, logs: []};
    },
  };
  const walletStates = [];
  const result = await executeScheduledMintPlans({
    preview: {publicClient, chain: {id: 1}, concurrency: 1, protections: {gasPriceWei: 6n}},
    plans: [{
      account,
      transaction: {to: SEADROP, data, value: 0n},
      gasLimit: 250000n,
      directSeaDrop: {nftContract: CONTRACT, feeRecipient, quantity: 1n},
    }],
    contractAddress: CONTRACT,
    scheduledAt: new Date(targetTimestamp * 1000).toISOString(),
    preflightLeadMs: 3000,
    signLeadMs: 1500,
    broadcastLeadMs: 100,
    retry: {maxAttempts: 2, delayMs: 0},
    waitForTarget: async () => {},
    onWallet: ({status}) => walletStates.push(status),
  });
  assert.equal(result.results[0].type, 'confirmed');
  assert.equal(result.results[0].result.attempts, 2);
  assert.equal(nonceReads, 2);
  assert.equal(broadcasts, 2);
  assert.deepEqual(walletStates, ['preflighted', 'signed', 'retrying', 'sending', 'confirmed']);
});

test('does not retry a public Mint after a permanent sold-out revert', async () => {
  const account = privateKeyToAccount(`0x${'77'.repeat(32)}`);
  const targetTimestamp = Math.floor(Date.now() / 1000);
  const feeRecipient = getAddress('0x5000000000000000000000000000000000000005');
  const data = encodeMintPublic({nftContract: CONTRACT, feeRecipient, quantity: 1n});
  let broadcasts = 0;
  const publicClient = {
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: BigInt(targetTimestamp)}; },
    async readContract({functionName, args}) {
      if (functionName === 'getPublicDrop') return {
        mintPrice: 0n, startTime: targetTimestamp - 5, endTime: targetTimestamp + 60,
        maxTotalMintableByWallet: 3n, feeBps: 250, restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [feeRecipient];
      if (functionName === 'getCreatorPayoutAddress') return account.address;
      if (functionName === 'name') return 'Sold Out NFT';
      if (functionName === 'getMintStats') return args[0] === ZERO_ADDRESS ? [0n, 0n, 10n] : [0n, 0n, 10n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
    async estimateFeesPerGas() { return {maxFeePerGas: 2n, maxPriorityFeePerGas: 1n}; },
    async getTransactionCount() { return 7; },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async call() { throw new Error('NFT sold out'); },
    async sendRawTransaction() {
      broadcasts += 1;
      return `0x${'cc'.repeat(32)}`;
    },
    async waitForTransactionReceipt() {
      return {status: 'reverted', blockNumber: 100n, logs: []};
    },
  };
  const walletStates = [];
  const result = await executeScheduledMintPlans({
    preview: {publicClient, chain: {id: 1}, concurrency: 1},
    plans: [{
      account,
      transaction: {to: SEADROP, data, value: 0n},
      gasLimit: 250000n,
      directSeaDrop: {nftContract: CONTRACT, feeRecipient, quantity: 1n},
    }],
    contractAddress: CONTRACT,
    scheduledAt: new Date(targetTimestamp * 1000).toISOString(),
    preflightLeadMs: 3000,
    signLeadMs: 1500,
    broadcastLeadMs: 1000,
    retry: {maxAttempts: 2, delayMs: 0},
    waitForTarget: async () => {},
    onWallet: ({status}) => walletStates.push(status),
  });
  assert.equal(result.results[0].type, 'failed');
  assert.equal(broadcasts, 1);
  assert.deepEqual(walletStates, ['preflighted', 'signed', 'sending', 'failed']);
});

test('polls OpenSea at the selected stage and forwards only matching wallet credentials', async () => {
  const account = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const stage = {
    uuid: 'stage-1', category: 'allowlist', label: 'test1', mintPrice: '0', maxPerWallet: '3333',
    startTime: 100, endTime: 200,
  };
  const catalog = {
    slug: 'drop', contractAddress: CONTRACT, totalSupply: '0', maxSupply: '100', stages: [stage],
  };
  const placeholder = {
    account,
    transaction: {to: SEADROP, data: null, value: 0n},
    balance: 10n ** 18n,
    gasPrice: 1n,
    gasLimit: 250000n,
    estimatedFee: 250000n,
    estimatedTotal: 250000n,
  };
  let clock = 0;
  let routeCalls = 0;
  let waitCalls = 0;
  const stages = [];
  const walletStates = [];
  const result = await executeScheduledOpenSeaMintPlans({
    preview: {
      publicClient: {
        async getGasPrice() { return 1n; },
        async getBalance() { return 10n ** 18n; },
        async getBytecode() { return '0x01'; },
      },
      chainConfig: {chainIdentifier: 'ethereum'},
      openSeaCatalog: catalog,
      openSeaStage: stage,
      protections: {minEligibleWallets: 1},
      quantity: 1n,
      concurrency: 1,
    },
    plans: [placeholder],
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    signLeadMs: 200,
    opensea: {},
    seaDropAddress: SEADROP,
    credentialPolling: {intervalMs: 500, timeoutMs: 2000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async () => {
      routeCalls += 1;
      if (routeCalls === 1) return [{address: account.address, status: 'not_active', reason: 'Not active'}];
      return [{
        address: account.address,
        status: 'ready',
        mode: 'signed',
        transaction: {to: SEADROP, data: '0x12345678', value: 0n},
        credential: {
          address: account.address,
          feeRecipient: OWNER,
          mintParams: {
            startTime: 100n,
            endTime: 200n,
            mintPrice: 0n,
            maxTotalMintableByWallet: 2n,
          },
        },
      }];
    },
    executeWalletPlan: async ({plan, onStage, onWallet}) => {
      onStage('signing');
      onWallet({plan, status: 'signed', nonce: 0});
      onStage('broadcasting');
      const result = {
        address: plan.account.address,
        hash: '0xabc',
        status: 'confirmed',
        blockNumber: '1',
        attempts: 1,
      };
      onWallet({plan, status: 'sending', hash: result.hash, attempt: 1});
      onWallet({plan, status: 'confirmed', result});
      return {type: 'confirmed', plan, result};
    },
    waitForTarget: async () => { waitCalls += 1; },
    sleep: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
    onStage: (value) => stages.push(value),
    onWallet: ({status}) => walletStates.push(status),
  });
  assert.equal(result.inspection.supplyLeft, '100');
  assert.equal(routeCalls, 2);
  assert.equal(waitCalls, 1, 'OpenSea flow should only wait once for the T-10 preflight boundary');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].plan.directSeaDrop.mode, 'signed');
  assert.equal(result.results[0].plan.directSeaDrop.credential.mintParams.maxTotalMintableByWallet, 2n);
  assert.deepEqual(stages, ['preflighting', 'credential_polling', 'signing', 'broadcasting']);
  assert.deepEqual(walletStates, ['preflighted', 'credential_waiting', 'credential_ready', 'signed', 'sending', 'confirmed']);
});

test('rejects OpenSea credentials that belong to a different stage', async () => {
  const account = privateKeyToAccount(`0x${'33'.repeat(32)}`);
  const stage = {
    uuid: 'stage-1', category: 'allowlist', label: 'test1', mintPrice: '0', maxPerWallet: '2',
    startTime: 100, endTime: 200,
  };
  const catalog = {slug: 'drop', contractAddress: CONTRACT, totalSupply: '0', maxSupply: '100', stages: [stage]};
  const placeholder = {
    account,
    transaction: {to: SEADROP, data: null, value: 0n},
    balance: 10n ** 18n,
    gasPrice: 1n,
    gasLimit: 250000n,
    estimatedFee: 250000n,
    estimatedTotal: 250000n,
  };
  let clock = 0;
  await assert.rejects(executeScheduledOpenSeaMintPlans({
    preview: {
      publicClient: {
        async getGasPrice() { return 1n; },
        async getBalance() { return 10n ** 18n; },
        async getBytecode() { return '0x01'; },
      },
      chainConfig: {chainIdentifier: 'ethereum'},
      openSeaCatalog: catalog,
      openSeaStage: stage,
      protections: {minEligibleWallets: 1},
      quantity: 1n,
      concurrency: 1,
    },
    plans: [placeholder],
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    signLeadMs: 200,
    opensea: {},
    seaDropAddress: SEADROP,
    credentialPolling: {intervalMs: 500, timeoutMs: 1000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async () => [{
      address: account.address,
      status: 'ready',
      mode: 'signed',
      transaction: {to: SEADROP, data: '0x12345678', value: 0n},
      credential: {
        address: account.address,
        feeRecipient: OWNER,
        mintParams: {startTime: 101n, endTime: 200n, mintPrice: 0n, maxTotalMintableByWallet: 2n},
      },
    }],
    waitForTarget: async () => {},
    sleep: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
  }), /returned credentials for 0 wallet/);
});

test('reuses OpenSea workers as each wallet reaches a terminal state', async () => {
  const accounts = [
    privateKeyToAccount(`0x${'44'.repeat(32)}`),
    privateKeyToAccount(`0x${'55'.repeat(32)}`),
    privateKeyToAccount(`0x${'66'.repeat(32)}`),
  ];
  const stage = {
    uuid: 'stage-workers', category: 'allowlist', label: 'workers', mintPrice: '0', maxPerWallet: '2',
    startTime: 100, endTime: 200,
  };
  const catalog = {slug: 'drop', contractAddress: CONTRACT, totalSupply: '0', maxSupply: '100', stages: [stage]};
  const plans = accounts.map((account) => ({
    account,
    transaction: {to: SEADROP, data: null, value: 0n},
    balance: 10n ** 18n,
    gasPrice: 1n,
    gasLimit: 250000n,
    estimatedFee: 250000n,
    estimatedTotal: 250000n,
  }));
  let active = 0;
  let maxActive = 0;
  const started = [];
  const finished = [];
  const result = await executeScheduledOpenSeaMintPlans({
    preview: {
      publicClient: {
        async getGasPrice() { return 1n; },
        async getBalance() { return 10n ** 18n; },
        async getBytecode() { return '0x01'; },
      },
      chainConfig: {chainIdentifier: 'ethereum'},
      openSeaCatalog: catalog,
      openSeaStage: stage,
      protections: {minEligibleWallets: 1},
      quantity: 1n,
      concurrency: 1,
    },
    plans,
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    signLeadMs: 200,
    opensea: {},
    seaDropAddress: SEADROP,
    workerCount: 2,
    credentialPolling: {intervalMs: 1, timeoutMs: 1000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async ({accounts: routeAccounts}) => routeAccounts.map((account) => ({
      address: account.address,
      status: 'ready',
      mode: 'signed',
      transaction: {to: SEADROP, data: '0x12345678', value: 0n},
      credential: {
        address: account.address,
        feeRecipient: OWNER,
        mintParams: {startTime: 100n, endTime: 200n, mintPrice: 0n, maxTotalMintableByWallet: 2n},
      },
    })),
    executeWalletPlan: async ({plan}) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(plan.account.address);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      finished.push(plan.account.address);
      return {type: 'confirmed', plan, result: {address: plan.account.address, status: 'confirmed'}};
    },
    waitForTarget: async () => {},
  });
  assert.equal(result.results.length, 3);
  assert.equal(maxActive, 2);
  assert.equal(started.length, 3);
  assert.equal(finished.length, 3);
  assert.ok(started.indexOf(accounts[2].address) >= 2, 'third wallet should wait for a worker to free up');
});

function securedOpenSeaStage(overrides = {}) {
  return {
    uuid: 'stage-secure',
    category: 'allowlist',
    label: 'Secure allowlist',
    stageType: 'og',
    kind: 'og',
    mintPrice: '0',
    currencyAddress: ZERO_ADDRESS,
    maxPerWallet: '2',
    stageSupply: '100',
    feeBps: '250',
    feeRecipient: OWNER,
    restrictFeeRecipients: true,
    startTime: 100,
    endTime: 200,
    ...overrides,
  };
}

function securedOpenSeaCatalog(stages) {
  return {
    slug: 'secure-drop',
    contractAddress: CONTRACT,
    totalSupply: '0',
    maxSupply: '100',
    stages,
  };
}

function securedOpenSeaPlaceholder(account, stage) {
  return {
    account,
    transaction: {to: SEADROP, data: null, value: BigInt(stage.mintPrice)},
    balance: 10n ** 18n,
    gasPrice: 1n,
    gasLimit: 250000n,
    estimatedFee: 250000n,
    estimatedTotal: 250000n + BigInt(stage.mintPrice),
    openSeaStageUuid: stage.uuid,
    openSeaStage: stage,
  };
}

function securedOpenSeaRoute(account, stage) {
  return {
    address: account.address,
    stageUuid: stage.uuid,
    status: 'ready',
    mode: 'signed',
    transaction: {
      to: SEADROP,
      data: '0x12345678',
      value: BigInt(stage.mintPrice),
    },
    credential: {
      address: account.address,
      feeRecipient: stage.feeRecipient,
      mintParams: {
        startTime: BigInt(stage.startTime),
        endTime: BigInt(stage.endTime),
        mintPrice: BigInt(stage.mintPrice),
        maxTotalMintableByWallet: BigInt(stage.maxPerWallet),
        maxTokenSupplyForStage: BigInt(stage.stageSupply),
        feeBps: BigInt(stage.feeBps),
        restrictFeeRecipients: stage.restrictFeeRecipients,
      },
    },
  };
}

function securedOpenSeaPreview(publicClient, catalog, protections = {minEligibleWallets: 1}) {
  return {
    publicClient,
    chain: {id: 1},
    chainConfig: {chainId: 1, chainIdentifier: 'ethereum'},
    openSeaCatalog: catalog,
    openSeaStage: catalog.stages.length === 1 ? catalog.stages[0] : null,
    protections,
    quantity: 1n,
    concurrency: 2,
  };
}

function openSeaReadClient(overrides = {}) {
  return {
    async getGasPrice() { return 1n; },
    async getBalance() { return 10n ** 18n; },
    async getBytecode() { return '0x01'; },
    ...overrides,
  };
}

test('previews wallet stage selections without a global OpenSea stage uuid', async () => {
  const accounts = [
    privateKeyToAccount(`0x${'12'.repeat(32)}`),
    privateKeyToAccount(`0x${'34'.repeat(32)}`),
  ];
  const stages = [
    securedOpenSeaStage({uuid: 'stage-og', kind: 'og', stageType: 'og'}),
    securedOpenSeaStage({uuid: 'stage-wl', kind: 'wl', stageType: 'allowlist'}),
  ];
  const catalog = securedOpenSeaCatalog(stages);
  const publicClient = openSeaReadClient({
    chain: {id: 1, name: 'Ethereum'},
    async getBlock() { return {timestamp: 50n}; },
  });

  const preview = await previewMint({
    contractAddress: CONTRACT,
    quantity: 1n,
    tokenId: '0',
    chainId: 1,
    concurrency: 2,
    accounts,
    clientForChain: () => publicClient,
    writeRpcForChain: () => 'http://127.0.0.1:8545',
    executionMode: 'scheduled',
    saleMode: 'auto',
    openSeaCatalog: catalog,
    openSeaStageSelections: accounts.map((account, index) => ({account, stage: stages[index]})),
    env: {},
    clock: () => 50_000,
  });

  assert.equal(preview.mintRoute, 'opensea_scheduled');
  assert.equal(preview.openSeaStage, null);
  assert.equal(preview.inspection.stageUuid, null);
  assert.deepEqual(preview.readyPlans.map((plan) => plan.openSeaStageUuid), ['stage-og', 'stage-wl']);
  assert.deepEqual(preview.openSeaStageGroups.map((group) => group.walletAddresses), accounts.map((account) => [account.address]));
});

test('does not execute any OpenSea wallet when the credential minimum is missed', async () => {
  const accounts = [
    privateKeyToAccount(`0x${'77'.repeat(32)}`),
    privateKeyToAccount(`0x${'88'.repeat(32)}`),
  ];
  const stage = securedOpenSeaStage();
  const catalog = securedOpenSeaCatalog([stage]);
  const publicClient = openSeaReadClient();
  let executeCalls = 0;

  await assert.rejects(executeScheduledOpenSeaMintPlans({
    preview: securedOpenSeaPreview(publicClient, catalog, {minEligibleWallets: 2}),
    plans: accounts.map((account) => securedOpenSeaPlaceholder(account, stage)),
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    opensea: {},
    seaDropAddress: SEADROP,
    credentialPolling: {intervalMs: 1, timeoutMs: 1000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async ({accounts: [account]}) => account.address === accounts[0].address
      ? [securedOpenSeaRoute(account, stage)]
      : [{address: account.address, stageUuid: stage.uuid, status: 'ineligible', reason: 'No allocation'}],
    executeWalletPlan: async () => {
      executeCalls += 1;
      throw new Error('must not execute');
    },
    waitForTarget: async () => {},
  }), /credentials for 1 wallet.*minimum is 2/);
  assert.equal(executeCalls, 0);
});

for (const [field, changedValue] of [['feeBps', '251'], ['stageSupply', '101']]) {
  test(`rejects a refreshed OpenSea stage when only ${field} changed`, async () => {
    const account = privateKeyToAccount(`0x${'99'.repeat(32)}`);
    const stage = securedOpenSeaStage();
    const catalog = securedOpenSeaCatalog([stage]);
    const refreshedCatalog = securedOpenSeaCatalog([{...stage, [field]: changedValue}]);
    let routeCalls = 0;
    let executeCalls = 0;

    await assert.rejects(executeScheduledOpenSeaMintPlans({
      preview: securedOpenSeaPreview(openSeaReadClient(), catalog),
      plans: [securedOpenSeaPlaceholder(account, stage)],
      contractAddress: CONTRACT,
      scheduledAt: '1970-01-01T00:01:40.000Z',
      preflightLeadMs: 3000,
      opensea: {},
      seaDropAddress: SEADROP,
      credentialPolling: {intervalMs: 1, timeoutMs: 1000},
      fetchCatalog: async () => refreshedCatalog,
      fetchRoutes: async () => { routeCalls += 1; return []; },
      executeWalletPlan: async () => { executeCalls += 1; return null; },
      waitForTarget: async () => {},
    }), /armed OpenSea stage changed/);
    assert.equal(routeCalls, 0);
    assert.equal(executeCalls, 0);
  });
}

test('executes wallet-specific OpenSea stages instead of one global stage', async () => {
  const accounts = [
    privateKeyToAccount(`0x${'aa'.repeat(32)}`),
    privateKeyToAccount(`0x${'bb'.repeat(32)}`),
  ];
  const stages = [
    securedOpenSeaStage({uuid: 'stage-og', kind: 'og', stageType: 'og'}),
    securedOpenSeaStage({uuid: 'stage-wl', kind: 'wl', stageType: 'allowlist'}),
  ];
  const catalog = securedOpenSeaCatalog(stages);
  const assigned = new Map(accounts.map((account, index) => [account.address.toLowerCase(), stages[index]]));
  const executed = [];

  const result = await executeScheduledOpenSeaMintPlans({
    preview: securedOpenSeaPreview(openSeaReadClient(), catalog, {minEligibleWallets: 2}),
    plans: accounts.map((account, index) => securedOpenSeaPlaceholder(account, stages[index])),
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    opensea: {},
    seaDropAddress: SEADROP,
    credentialPolling: {intervalMs: 1, timeoutMs: 1000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async ({accounts: [account], catalog: routeCatalog}) => {
      const stage = assigned.get(account.address.toLowerCase());
      assert.equal(routeCatalog.activeStageUuid, stage.uuid);
      return [securedOpenSeaRoute(account, stage)];
    },
    executeWalletPlan: async ({plan}) => {
      executed.push([plan.account.address, plan.openSeaStageUuid]);
      return {type: 'confirmed', plan, result: {address: plan.account.address, status: 'confirmed'}};
    },
    waitForTarget: async () => {},
  });

  assert.equal(result.results.length, 2);
  assert.deepEqual(executed, accounts.map((account, index) => [account.address, stages[index].uuid]));
  assert.deepEqual(result.executionGroups, accounts.map((account, index) => ({
    walletAddress: account.address,
    openSeaStageIdentity: {
      chainId: 1,
      contractAddress: CONTRACT.toLowerCase(),
      uuid: stages[index].uuid,
      kind: stages[index].kind,
      startTime: 100,
      endTime: 200,
      mintPrice: '0',
      currencyAddress: ZERO_ADDRESS,
      maxPerWallet: '2',
      stageSupply: '100',
      feeBps: '250',
      feeRecipient: OWNER.toLowerCase(),
      restrictFeeRecipients: true,
    },
    planCount: 1,
    nonceScope: 'wallet',
  })));
});

test('blocks later plans for one wallet after an ambiguous raw transaction submission', async () => {
  const sourceAccount = privateKeyToAccount(`0x${'cc'.repeat(32)}`);
  let signCalls = 0;
  const account = {
    ...sourceAccount,
    async signTransaction(request) {
      signCalls += 1;
      return sourceAccount.signTransaction(request);
    },
  };
  const stage = securedOpenSeaStage();
  const catalog = securedOpenSeaCatalog([stage]);
  let sendCalls = 0;
  let serializedTransaction = null;
  let observedHash = null;
  const nonceReads = [];
  const publicClient = openSeaReadClient({
    async getTransactionCount({blockTag}) {
      nonceReads.push(blockTag);
      return blockTag === 'latest' ? 7 : 8;
    },
    async sendRawTransaction({serializedTransaction: raw}) {
      sendCalls += 1;
      serializedTransaction = raw;
      observedHash = keccak256(raw);
      throw new Error('RPC timeout after upstream accepted the raw transaction');
    },
    async getTransactionReceipt({hash}) {
      assert.equal(hash, observedHash);
      return null;
    },
    async getTransaction({hash}) {
      assert.equal(hash, observedHash);
      return null;
    },
  });

  const result = await executeScheduledOpenSeaMintPlans({
    preview: securedOpenSeaPreview(publicClient, catalog),
    plans: [
      securedOpenSeaPlaceholder(account, stage),
      securedOpenSeaPlaceholder(account, stage),
    ],
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    signLeadMs: 200,
    retry: {maxAttempts: 3, delayMs: 0},
    opensea: {},
    seaDropAddress: SEADROP,
    credentialPolling: {intervalMs: 1, timeoutMs: 1000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async ({accounts: [routeAccount]}) => [securedOpenSeaRoute(routeAccount, stage)],
    waitForTarget: async () => {},
  });

  assert.equal(signCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(parseTransaction(serializedTransaction).nonce, 8);
  assert.equal(result.results[0].code, 'MINT_SUBMISSION_UNKNOWN');
  assert.equal(result.results[0].hash, observedHash);
  assert.equal(result.results[0].nonceBlocked, true);
  assert.equal(result.results[1].code, 'MINT_NONCE_BLOCKED');
  assert.equal(result.results[1].nonceBlocked, true);
  assert.deepEqual(nonceReads, ['latest', 'pending', 'latest', 'pending']);
});

test('continues the wallet nonce sequence when the local hash is accepted but confirmation is pending', async () => {
  const sourceAccount = privateKeyToAccount(`0x${'dd'.repeat(32)}`);
  const signedNonces = [];
  const account = {
    ...sourceAccount,
    async signTransaction(request) {
      signedNonces.push(request.nonce);
      return sourceAccount.signTransaction(request);
    },
  };
  const stage = securedOpenSeaStage();
  const catalog = securedOpenSeaCatalog([stage]);
  const sentHashes = [];
  const publicClient = openSeaReadClient({
    async getTransactionCount({blockTag}) {
      return blockTag === 'latest' ? 7 : 8;
    },
    async sendRawTransaction({serializedTransaction}) {
      const hash = keccak256(serializedTransaction);
      sentHashes.push(hash);
      if (sentHashes.length === 1) throw new Error('RPC timeout after upstream accepted the raw transaction');
      return hash;
    },
    async getTransactionReceipt({hash}) {
      assert.equal(hash, sentHashes[0]);
      return null;
    },
    async getTransaction({hash}) {
      assert.equal(hash, sentHashes[0]);
      return {hash, nonce: 8, blockNumber: 123n};
    },
    async waitForTransactionReceipt({hash}) {
      assert.equal(hash, sentHashes[1]);
      return {status: 'success', blockNumber: 1n, logs: []};
    },
  });

  const result = await executeScheduledOpenSeaMintPlans({
    preview: securedOpenSeaPreview(publicClient, catalog),
    plans: [
      securedOpenSeaPlaceholder(account, stage),
      securedOpenSeaPlaceholder(account, stage),
    ],
    contractAddress: CONTRACT,
    scheduledAt: '1970-01-01T00:01:40.000Z',
    preflightLeadMs: 3000,
    signLeadMs: 200,
    retry: {maxAttempts: 3, delayMs: 0},
    opensea: {},
    seaDropAddress: SEADROP,
    credentialPolling: {intervalMs: 1, timeoutMs: 1000},
    fetchCatalog: async () => catalog,
    fetchRoutes: async ({accounts: [routeAccount]}) => [securedOpenSeaRoute(routeAccount, stage)],
    waitForTarget: async () => {},
  });

  assert.deepEqual(signedNonces, [8, 9]);
  assert.equal(sentHashes.length, 2);
  assert.equal(result.results[0].type, 'confirmation_pending');
  assert.equal(result.results[0].result.status, 'confirmation_pending');
  assert.equal(result.results[0].result.accepted, true);
  assert.equal(result.results[0].nonceBlocked, false);
  assert.equal(result.results[0].result.observation.transaction.blockNumber, '123');
  assert.doesNotThrow(() => JSON.stringify(result.results[0].result));
  assert.equal(result.results[1].type, 'confirmed');
  assert.deepEqual(result.results[1].result.openSeaStageIdentity, result.executionGroups[0].openSeaStageIdentity);
});
