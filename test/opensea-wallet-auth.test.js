import assert from 'node:assert/strict';
import test from 'node:test';
import {getAddress} from 'viem';
import {
  clearOpenSeaWalletAuthCache,
  fetchOpenSeaWalletEligibilities,
  revokeOpenSeaWalletAuth,
} from '../server/opensea-mint/wallet-auth.js';
import {buildOpenSeaSiweProof} from '../server/opensea-mint/auth-client.js';

const WALLET = getAddress('0x2000000000000000000000000000000000000002');
const opensea = {
  restUrl: 'https://api.opensea.test/api/v2',
  requestTimeoutMs: 1000,
  userAgent: 'test',
  apiKey: 'configured-api-key',
};
const catalog = {
  slug: 'tanktestimg',
  stages: [{uuid: 'stage-1', category: 'allowlist'}],
};

test('built-in OpenSea SIWE proof matches the v2 wallet-auth schema', () => {
  const proof = buildOpenSeaSiweProof({
    address: WALLET,
    nonce: 'OpenSea1234',
    issuedAt: new Date('2026-08-29T00:00:00.000Z'),
  });
  assert.equal(proof.message, [
    'opensea.io wants you to sign in with your Ethereum account:',
    WALLET,
    '',
    'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).',
    '',
    'URI: https://opensea.io',
    'Version: 1',
    'Chain ID: 1',
    'Nonce: OpenSea1234',
    'Issued At: 2026-08-29T00:00:00.000Z',
  ].join('\n'));
  assert.deepEqual(proof.payload, {
    domain: 'opensea.io',
    address: WALLET,
    statement: 'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).',
    uri: 'https://opensea.io',
    version: '1',
    chainId: '1',
    nonce: 'OpenSea1234',
    issuedAt: '2026-08-29T00:00:00.000Z',
    accountType: 'Ethereum',
  });
});

test('uses a cached read-only SIWE session for future wallet eligibility and revokes it', async () => {
  clearOpenSeaWalletAuthCache();
  const calls = {authenticate: 0, valid: 0, revoke: 0, signatures: [], requests: []};
  const authFactory = () => ({
    async authenticate(signer, options) {
      calls.authenticate += 1;
      assert.deepEqual(options.scopes, ['read:eligibility']);
      assert.equal(await signer.getAddress(), WALLET);
      calls.signatures.push(await signer.signMessage('OpenSea SIWE test message'));
      return {
        accessToken: 'wallet-jwt-secret',
        refreshToken: 'wallet-pat-secret',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
        scopes: ['read:eligibility'],
      };
    },
    async getValidToken() {
      calls.valid += 1;
      return {
        accessToken: 'wallet-jwt-secret',
        refreshToken: 'wallet-pat-secret',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
        scopes: ['read:eligibility'],
      };
    },
    async revoke(accessToken) {
      calls.revoke += 1;
      assert.equal(accessToken, 'wallet-jwt-secret');
    },
  });
  const account = {
    address: WALLET,
    async signMessage({message}) {
      assert.equal(message, 'OpenSea SIWE test message');
      return `0x${'11'.repeat(65)}`;
    },
  };
  const fetchImpl = async (url, options) => {
    calls.requests.push({url, options});
    return new Response(JSON.stringify({
      stages: [{
        stage_uuid: 'stage-1',
        is_eligible: true,
        price: '0',
        max_total_mintable_by_wallet: '2',
      }],
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };

  const first = await fetchOpenSeaWalletEligibilities({
    opensea,
    catalog,
    accounts: [account],
    fetchImpl,
    authFactory,
  });
  const second = await fetchOpenSeaWalletEligibilities({
    opensea,
    catalog,
    accounts: [account],
    fetchImpl,
    authFactory,
  });

  assert.equal(calls.authenticate, 1);
  assert.equal(calls.signatures.length, 1);
  assert.equal(first[0].status, 'ready');
  assert.deepEqual(first[0].stages, [{
    stageUuid: 'stage-1',
    isEligible: true,
    price: '0',
    maxTotalMintableByWallet: '2',
    maxTotalMintableByWalletPerToken: null,
  }]);
  assert.equal(second[0].stages[0].isEligible, true);
  assert.match(calls.requests[0].options.headers.authorization, /^Bearer /);
  assert.equal(JSON.stringify(first).includes('wallet-jwt-secret'), false);
  assert.equal(JSON.stringify(first).includes('wallet-pat-secret'), false);

  const revoked = await revokeOpenSeaWalletAuth([WALLET]);
  assert.equal(revoked.revokedCount, 1);
  assert.equal(calls.revoke, 1);
  clearOpenSeaWalletAuthCache();
});
