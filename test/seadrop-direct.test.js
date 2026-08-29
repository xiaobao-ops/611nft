import assert from 'node:assert/strict';
import test from 'node:test';
import {getAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
  aggregateSupplyBlocker,
  aggregateCredentialSupplyBlocker,
  allowListLeaf,
  buildSeaDropCredentialPlans,
  classifyDropPhase,
  decodeMintAllowList,
  decodeMintPublic,
  decodeMintSigned,
  encodeMintAllowList,
  encodeMintPublic,
  encodeMintSigned,
  parseSeaDropCredentials,
  revalidateDirectSeaDropPlan,
  ZERO_ADDRESS,
} from '../server/opensea-mint/seadrop.js';

const NFT = getAddress('0x1000000000000000000000000000000000000001');
const WALLET = getAddress('0x2000000000000000000000000000000000000002');
const FEE_RECIPIENT = getAddress('0x3000000000000000000000000000000000000003');
const SEADROP = getAddress('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');

const MINT_PARAMS = {
  mintPrice: 2n,
  maxTotalMintableByWallet: 3n,
  startTime: 100n,
  endTime: 200n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 10n,
  feeBps: 250n,
  restrictFeeRecipients: true,
};

const SIGNED_MINT_TYPES = {
  MintParams: [
    {name: 'mintPrice', type: 'uint256'},
    {name: 'maxTotalMintableByWallet', type: 'uint256'},
    {name: 'startTime', type: 'uint256'},
    {name: 'endTime', type: 'uint256'},
    {name: 'dropStageIndex', type: 'uint256'},
    {name: 'maxTokenSupplyForStage', type: 'uint256'},
    {name: 'feeBps', type: 'uint256'},
    {name: 'restrictFeeRecipients', type: 'bool'},
  ],
  SignedMint: [
    {name: 'nftContract', type: 'address'},
    {name: 'minter', type: 'address'},
    {name: 'feeRecipient', type: 'address'},
    {name: 'mintParams', type: 'MintParams'},
    {name: 'salt', type: 'uint256'},
  ],
};

test('encodes and decodes SeaDrop mintPublic calldata', () => {
  const data = encodeMintPublic({nftContract: NFT, feeRecipient: FEE_RECIPIENT, quantity: 2n});
  const decoded = decodeMintPublic(data);
  assert.equal(decoded.nftContract, NFT);
  assert.equal(decoded.feeRecipient, FEE_RECIPIENT);
  assert.equal(decoded.minterIfNotPayer, ZERO_ADDRESS);
  assert.equal(decoded.quantity, 2n);
});

test('encodes and decodes SeaDrop allowlist and signed calldata', () => {
  const proof = [`0x${'ab'.repeat(32)}`];
  const allowlistData = encodeMintAllowList({
    nftContract: NFT,
    feeRecipient: FEE_RECIPIENT,
    quantity: 2n,
    mintParams: MINT_PARAMS,
    proof,
  });
  const allowlist = decodeMintAllowList(allowlistData);
  assert.equal(allowlist.nftContract, NFT);
  assert.equal(allowlist.quantity, 2n);
  assert.deepEqual(allowlist.proof, proof);
  assert.deepEqual(allowlist.mintParams, MINT_PARAMS);

  const signature = `0x${'11'.repeat(65)}`;
  const signedData = encodeMintSigned({
    nftContract: NFT,
    feeRecipient: FEE_RECIPIENT,
    quantity: 1n,
    mintParams: MINT_PARAMS,
    salt: 9n,
    signature,
  });
  const signed = decodeMintSigned(signedData);
  assert.equal(signed.nftContract, NFT);
  assert.equal(signed.salt, 9n);
  assert.equal(signed.signature, signature);
});

test('parses wallet-keyed credentials and rejects duplicates or malformed signatures', () => {
  const parsed = parseSeaDropCredentials({
    [WALLET]: {mintParams: MINT_PARAMS, proof: []},
  }, 'allowlist');
  assert.equal(parsed.get(WALLET.toLowerCase()).address, WALLET);
  assert.throws(() => parseSeaDropCredentials([
    {address: WALLET, mintParams: MINT_PARAMS, proof: []},
    {address: WALLET, mintParams: MINT_PARAMS, proof: []},
  ], 'allowlist'), /Duplicate whitelist credential/);
  assert.throws(() => parseSeaDropCredentials([
    {address: WALLET, mintParams: MINT_PARAMS, salt: 1, signature: '0x12'},
  ], 'signed'), /Invalid signed mint signature/);
});

function credentialClient({mode, root, signer}) {
  return {
    chain: {id: 1},
    async getBytecode() { return '0x01'; },
    async getBlock() { return {timestamp: 150n}; },
    async getGasPrice() { return 1n; },
    async getBalance() { return 10_000_000n; },
    async estimateGas() { return 100_000n; },
    async readContract({functionName}) {
      if (functionName === 'getAllowedFeeRecipients') return [FEE_RECIPIENT];
      if (functionName === 'getCreatorPayoutAddress') return FEE_RECIPIENT;
      if (functionName === 'name') return 'Whitelist NFT';
      if (functionName === 'getAllowListMerkleRoot') return root;
      if (functionName === 'getSigners') return [signer];
      if (functionName === 'getSignedMintValidationParams') return [0n, 3n, 90n, 210n, 10n, 0n, 500n];
      if (functionName === 'getMintStats') return [0n, 2n, 20n];
      throw new Error(`Unexpected ${mode} function: ${functionName}`);
    },
  };
}

test('builds a Merkle allowlist plan only after verifying its on-chain root', async () => {
  const account = {address: WALLET};
  const root = allowListLeaf(WALLET, MINT_PARAMS);
  const credentials = parseSeaDropCredentials([{
    address: WALLET,
    feeRecipient: FEE_RECIPIENT,
    mintParams: MINT_PARAMS,
    proof: [],
  }], 'allowlist');
  const result = await buildSeaDropCredentialPlans({
    publicClient: credentialClient({mode: 'allowlist', root}),
    accounts: [account],
    contractAddress: NFT,
    quantity: 1n,
    concurrency: 1,
    mode: 'allowlist',
    credentials,
  });
  assert.equal(result.failedWallets.length, 0);
  assert.equal(result.readyPlans.length, 1);
  const decoded = decodeMintAllowList(result.readyPlans[0].transaction.data);
  assert.equal(decoded.nftContract, NFT);
  assert.equal(decoded.mintParams.mintPrice, 2n);
});

test('builds a signed whitelist plan after EIP-712 signer and limit checks', async () => {
  const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const signer = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const salt = 9n;
  const signature = await signer.signTypedData({
    domain: {name: 'SeaDrop', version: '1.0', chainId: 1, verifyingContract: SEADROP},
    types: SIGNED_MINT_TYPES,
    primaryType: 'SignedMint',
    message: {
      nftContract: NFT,
      minter: wallet.address,
      feeRecipient: FEE_RECIPIENT,
      mintParams: MINT_PARAMS,
      salt,
    },
  });
  const credentials = parseSeaDropCredentials([{
    address: wallet.address,
    feeRecipient: FEE_RECIPIENT,
    mintParams: MINT_PARAMS,
    salt,
    signature,
  }], 'signed');
  const result = await buildSeaDropCredentialPlans({
    publicClient: credentialClient({mode: 'signed', signer: signer.address}),
    accounts: [wallet],
    contractAddress: NFT,
    quantity: 1n,
    concurrency: 1,
    mode: 'signed',
    credentials,
  });
  assert.equal(result.failedWallets.length, 0);
  assert.equal(result.readyPlans.length, 1);
  const decoded = decodeMintSigned(result.readyPlans[0].transaction.data);
  assert.equal(decoded.salt, salt);
  assert.equal(decoded.signature, signature);
});

test('classifies SeaDrop public sale windows from chain time', () => {
  const drop = {mintPrice: 1n, startTime: 100, endTime: 200};
  assert.equal(classifyDropPhase(drop, 99), 'not_started');
  assert.equal(classifyDropPhase(drop, 100), 'live');
  assert.equal(classifyDropPhase(drop, 201), 'ended');
  assert.equal(classifyDropPhase({mintPrice: 0n, startTime: 0, endTime: 0}, 100), 'unconfigured');
});

test('blocks aggregate multi-wallet demand above remaining supply', () => {
  assert.equal(aggregateSupplyBlocker(10n, 2n, 5), null);
  assert.match(aggregateSupplyBlocker(9n, 2n, 5), /require 10 NFTs/);
  assert.match(aggregateCredentialSupplyBlocker({
    currentTotalSupply: 2n,
    maxSupply: 20n,
    stageLimits: [3n, 10n],
    quantity: 1n,
    walletCount: 2,
  }), /stage has only 1 remaining/);
});

test('revalidates supply, wallet allowance, fee recipient, and price before sending', async () => {
  const publicClient = {
    async getBytecode() {
      return '0x01';
    },
    async getBlock() {
      return {timestamp: 150n};
    },
    async readContract({functionName, args}) {
      if (functionName === 'getPublicDrop') {
        return {
          mintPrice: 2n,
          startTime: 100,
          endTime: 200,
          maxTotalMintableByWallet: 3n,
          feeBps: 250,
          restrictFeeRecipients: true,
        };
      }
      if (functionName === 'getAllowedFeeRecipients') return [FEE_RECIPIENT];
      if (functionName === 'getCreatorPayoutAddress') return WALLET;
      if (functionName === 'name') return 'Test NFT';
      if (functionName === 'getMintStats') {
        return args[0] === ZERO_ADDRESS ? [0n, 4n, 10n] : [1n, 4n, 10n];
      }
      throw new Error(`Unexpected function: ${functionName}`);
    },
  };
  const plan = {
    account: {address: WALLET},
    transaction: {value: 2n},
    estimatedFee: 1n,
    estimatedTotal: 3n,
    directSeaDrop: {
      nftContract: NFT,
      feeRecipient: FEE_RECIPIENT,
      quantity: 1n,
    },
  };
  const result = await revalidateDirectSeaDropPlan({publicClient, plan});
  assert.equal(result.changed, false);
  assert.equal(result.inspection.supplyLeft, 6n);
  assert.equal(result.inspection.walletStats[0].perWalletLeft, 2n);
});
