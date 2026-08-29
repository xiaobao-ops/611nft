import assert from 'node:assert/strict';
import test from 'node:test';
import {getAddress} from 'viem';
import {encodeMintSigned} from '../server/opensea-mint/seadrop.js';
import {
  fetchOpenSeaDropCatalog,
  fetchOpenSeaWalletMintRoutes,
} from '../server/opensea-mint/drops.js';

const NFT = getAddress('0x1000000000000000000000000000000000000001');
const WALLET = getAddress('0x2000000000000000000000000000000000000002');
const OTHER = getAddress('0x3000000000000000000000000000000000000003');
const FEE = getAddress('0x4000000000000000000000000000000000000004');
const SEADROP = getAddress('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');
const opensea = {
  restUrl: 'https://api.opensea.test/api/v2',
  requestTimeoutMs: 1000,
  userAgent: 'test',
  apiKey: 'configured-api-key',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

test('loads the complete OpenSea stage catalog through the configured key', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({url, options});
    if (url.includes('/chain/ethereum/contract/')) return jsonResponse({collection: 'tanktestimg'});
    if (url.endsWith('/drops/tanktestimg')) return jsonResponse({
      collection_slug: 'tanktestimg',
      collection_name: 'TANKTESTIMG',
      chain: 'ethereum',
      contract_address: NFT,
      drop_type: 'seadrop_v1_erc721',
      is_minting: true,
      active_stage: {uuid: 'stage-2'},
      stages: [
        {uuid: 'public', stage_type: 'public_sale', label: 'public', price: '0', price_currency_address: '0x0', start_time: '2026-08-21T10:00:00Z', end_time: '2026-08-24T11:01:15Z', max_per_wallet: '1000'},
        {uuid: 'stage-1', stage_type: 'presale', label: 'test1', price: '0', price_currency_address: '0x0', start_time: '2026-08-21T07:00:00Z', end_time: '2026-08-21T07:59:59Z', max_per_wallet: '1'},
        {uuid: 'stage-2', stage_type: 'presale', label: 'test2', price: '0', price_currency_address: '0x0', start_time: '2026-08-21T08:00:00Z', end_time: '2026-08-21T08:59:59Z', max_per_wallet: '1', max_token_supply_for_stage: '3333', fee_bps: '250', fee_recipient: FEE, restrict_fee_recipients: true},
        {uuid: 'stage-4', stage_type: 'presale', label: 'test4', price: '0', price_currency_address: '0x0', start_time: '2026-08-21T09:00:00Z', end_time: '2026-08-21T09:59:59Z', max_per_wallet: '1'},
      ],
      total_supply: '0',
      max_supply: '3333',
    });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const catalog = await fetchOpenSeaDropCatalog({
    opensea,
    chainIdentifier: 'ethereum',
    contractAddress: NFT,
    fetchImpl,
  });
  assert.equal(catalog.slug, 'tanktestimg');
  assert.equal(catalog.stages.length, 4);
  assert.deepEqual(catalog.stages.map((stage) => stage.label), ['test1', 'test2', 'test4', 'public']);
  assert.equal(catalog.stages[3].category, 'public');
  assert.equal(catalog.stages[1].stageSupply, '3333');
  assert.equal(catalog.stages[1].feeBps, '250');
  assert.equal(catalog.stages[1].feeRecipient, FEE);
  assert.equal(catalog.stages[1].restrictFeeRecipients, true);
  assert.equal(calls[0].options.headers['x-api-key'], 'configured-api-key');
});

test('rejects OpenSea access when no user key is configured', async () => {
  await assert.rejects(
    fetchOpenSeaDropCatalog({
      opensea: {...opensea, apiKey: ''},
      chainIdentifier: 'ethereum',
      contractAddress: NFT,
      slug: 'missing-key',
    }),
    /OPENSEA_API_KEY is required/,
  );
});

test('decodes wallet-specific signed credentials returned by the active Mint API', async () => {
  const params = {
    mintPrice: 0n,
    maxTotalMintableByWallet: 1n,
    startTime: 100n,
    endTime: 200n,
    dropStageIndex: 2n,
    maxTokenSupplyForStage: 3333n,
    feeBps: 250n,
    restrictFeeRecipients: true,
  };
  const data = encodeMintSigned({
    nftContract: NFT,
    feeRecipient: FEE,
    quantity: 1n,
    mintParams: params,
    salt: 7n,
    signature: `0x${'11'.repeat(65)}`,
  });
  const fetchImpl = async (url, options = {}) => {
    const minter = JSON.parse(options.body).minter;
    return minter.toLowerCase() === WALLET.toLowerCase()
      ? jsonResponse({to: SEADROP, data, value: '0', chain: 'ethereum'})
      : jsonResponse({error: 'Wallet is not in the active allowlist.'}, 422);
  };
  const routes = await fetchOpenSeaWalletMintRoutes({
    opensea,
    catalog: {
      slug: 'tanktestimg',
      contractAddress: NFT,
      activeStageUuid: 'stage-2',
      stages: [{uuid: 'stage-2', category: 'allowlist'}],
    },
    accounts: [{address: WALLET}, {address: OTHER}],
    quantity: 1n,
    seaDropAddress: SEADROP,
    fetchImpl,
  });
  assert.equal(routes[0].status, 'ready');
  assert.equal(routes[0].mode, 'signed');
  assert.equal(routes[0].credential.salt, 7n);
  assert.equal(routes[1].status, 'ineligible');
});
