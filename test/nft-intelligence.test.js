import assert from 'node:assert/strict';
import test from 'node:test';
import {getAddress} from 'viem';
import {allowListLeaf} from '../server/opensea-mint/seadrop.js';
import {inspectNftIntelligence, parseCredentialBundle} from '../server/opensea-mint/intelligence.js';

const NFT = getAddress('0x1000000000000000000000000000000000000001');
const WALLET = getAddress('0x2000000000000000000000000000000000000002');
const FEE = getAddress('0x3000000000000000000000000000000000000003');
const PARAMS = {
  mintPrice: 2n,
  maxTotalMintableByWallet: 3n,
  startTime: 100n,
  endTime: 200n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 10n,
  feeBps: 250n,
  restrictFeeRecipients: true,
};

test('parses mixed credential bundles by SeaDrop mode', () => {
  const bundle = parseCredentialBundle([
    {address: WALLET, mintParams: PARAMS, proof: []},
    {address: FEE, mintParams: PARAMS, salt: 1, signature: `0x${'11'.repeat(65)}`},
  ]);
  assert.equal(bundle.allowlist.size, 1);
  assert.equal(bundle.signed.size, 1);
});

test('reports NFT stages and recommends the lowest-priced live eligible route', async () => {
  const root = allowListLeaf(WALLET, PARAMS);
  const client = {
    chain: {id: 1},
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: 150n}; },
    async readContract({functionName, args}) {
      if (functionName === 'name') return 'Sniper NFT';
      if (functionName === 'symbol') return 'SNIPE';
      if (functionName === 'totalSupply') return 2n;
      if (functionName === 'getPublicDrop') return {
        mintPrice: 5n,
        startTime: 100,
        endTime: 200,
        maxTotalMintableByWallet: 3n,
        feeBps: 250,
        restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [FEE];
      if (functionName === 'getCreatorPayoutAddress') return FEE;
      if (functionName === 'getAllowListMerkleRoot') return root;
      if (functionName === 'getSigners') return [];
      if (functionName === 'getMintStats') return args[0] === '0x0000000000000000000000000000000000000000'
        ? [0n, 2n, 20n]
        : [0n, 2n, 20n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
  };
  const credentials = parseCredentialBundle([{
    address: WALLET,
    feeRecipient: FEE,
    mintParams: PARAMS,
    proof: [],
  }]);
  const result = await inspectNftIntelligence({
    publicClient: client,
    contractAddress: NFT,
    accounts: [{address: WALLET}],
    quantity: 1n,
    credentials,
  });
  assert.equal(result.name, 'Sniper NFT');
  assert.equal(result.currentSupply, '2');
  assert.equal(result.supplyLeft, '18');
  assert.ok(result.stages.some((stage) => stage.type === 'public' && stage.status === 'live'));
  const allowlist = result.stages.find((stage) => stage.type === 'allowlist');
  assert.equal(allowlist.mintPrice, '2');
  assert.equal(result.wallets[0].status, 'eligible');
  assert.equal(result.wallets[0].recommendedStageId, allowlist.id);
});

test('uses the OpenSea stage catalog without inventing a Signed sales stage', async () => {
  const client = {
    chain: {id: 1},
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: 250n}; },
    async readContract({functionName, args}) {
      if (functionName === 'name') return 'TANKTESTIMG';
      if (functionName === 'symbol') return 'TANK';
      if (functionName === 'totalSupply') return 0n;
      if (functionName === 'getPublicDrop') return {
        mintPrice: 0n,
        startTime: 400,
        endTime: 800,
        maxTotalMintableByWallet: 1000n,
        feeBps: 250,
        restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [FEE];
      if (functionName === 'getCreatorPayoutAddress') return FEE;
      if (functionName === 'getAllowListMerkleRoot') return `0x${'00'.repeat(32)}`;
      if (functionName === 'getSigners') return [FEE];
      if (functionName === 'getMintStats') return args[0] === '0x0000000000000000000000000000000000000000'
        ? [0n, 0n, 3333n]
        : [0n, 0n, 3333n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
  };
  const result = await inspectNftIntelligence({
    publicClient: client,
    contractAddress: NFT,
    accounts: [{address: WALLET}],
    quantity: 1n,
    openSeaCatalog: {
      slug: 'tanktestimg',
      name: 'TANKTESTIMG',
      source: 'opensea-drops-api',
      activeStageUuid: 'test2',
      totalSupply: '0',
      maxSupply: '3333',
      stages: [
        {uuid: 'test1', label: 'test1', category: 'allowlist', mintPrice: '0', maxPerWallet: '1', startTime: 100, endTime: 199},
        {uuid: 'test2', label: 'test2', category: 'allowlist', mintPrice: '0', maxPerWallet: '1', startTime: 200, endTime: 299},
        {uuid: 'test4', label: 'test4', category: 'allowlist', mintPrice: '0', maxPerWallet: '1', startTime: 300, endTime: 399},
        {uuid: 'public', label: 'public', category: 'public', mintPrice: '0', maxPerWallet: '1000', startTime: 400, endTime: 800},
      ],
    },
  });
  assert.equal(result.stages.length, 4);
  assert.deepEqual(result.stages.map((stage) => stage.label), [
    'test1 · Allowlist',
    'test2 · Allowlist',
    'test4 · Allowlist',
    'public · Public',
  ]);
  assert.equal(result.stages.some((stage) => stage.label === 'Signed 签名阶段'), false);
  assert.equal(result.credentialCapabilities.signed, true);
  assert.equal(result.wallets[0].status, 'upcoming');
  assert.equal(result.wallets[0].recommendedStageId, 'opensea:public');
});

test('uses OpenSea future-stage eligibility without requiring manual credentials', async () => {
  const otherWallet = getAddress('0x5000000000000000000000000000000000000005');
  const client = {
    chain: {id: 1},
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: 250n}; },
    async readContract({functionName, args}) {
      if (functionName === 'name') return 'TANKTESTIMG';
      if (functionName === 'symbol') return 'TANK';
      if (functionName === 'totalSupply') return 0n;
      if (functionName === 'getPublicDrop') return {
        mintPrice: 0n,
        startTime: 400,
        endTime: 800,
        maxTotalMintableByWallet: 1000n,
        feeBps: 250,
        restrictFeeRecipients: true,
      };
      if (functionName === 'getAllowedFeeRecipients') return [FEE];
      if (functionName === 'getCreatorPayoutAddress') return FEE;
      if (functionName === 'getAllowListMerkleRoot') return `0x${'00'.repeat(32)}`;
      if (functionName === 'getSigners') return [FEE];
      if (functionName === 'getMintStats') return args[0] === '0x0000000000000000000000000000000000000000'
        ? [0n, 0n, 3333n]
        : [0n, 0n, 3333n];
      throw new Error(`Unexpected function: ${functionName}`);
    },
  };
  const catalog = {
    slug: 'tanktestimg',
    name: 'TANKTESTIMG',
    source: 'opensea-drops-api',
    activeStageUuid: null,
    totalSupply: '0',
    maxSupply: '3333',
    stages: [
      {uuid: 'test1', label: 'test1', category: 'allowlist', mintPrice: '0', maxPerWallet: '3333', startTime: 300, endTime: 350},
      {uuid: 'test2', label: 'test2', category: 'allowlist', mintPrice: '0', maxPerWallet: '3333', startTime: 360, endTime: 390},
      {uuid: 'public', label: 'public', category: 'public', mintPrice: '0', maxPerWallet: '1000', startTime: 400, endTime: 800},
    ],
  };
  const result = await inspectNftIntelligence({
    publicClient: client,
    contractAddress: NFT,
    accounts: [{address: WALLET}, {address: otherWallet}],
    quantity: 1n,
    openSeaCatalog: catalog,
    openSeaWalletEligibilities: [{
      address: WALLET,
      status: 'ready',
      stages: [
        {stageUuid: 'test1', isEligible: true},
        {stageUuid: 'test2', isEligible: false},
      ],
    }, {
      address: otherWallet,
      status: 'ready',
      stages: [
        {stageUuid: 'test1', isEligible: false},
        {stageUuid: 'test2', isEligible: false},
      ],
    }],
  });

  const firstStage = result.stages.find((stage) => stage.uuid === 'test1');
  assert.equal(firstStage.qualificationState, 'checked');
  assert.equal(firstStage.walletCount, 1);
  assert.equal(result.wallets[0].status, 'upcoming');
  assert.deepEqual(result.wallets[0].qualifiedStageIds, ['opensea:test1', 'opensea:public']);
  assert.equal(result.wallets[0].recommendedStageId, 'opensea:test1');
  assert.equal(result.wallets[0].stages.find((stage) => stage.stageId === 'opensea:test1').qualified, true);
  assert.equal(result.wallets[1].stages.find((stage) => stage.stageId === 'opensea:test1').status, 'ineligible');
});
