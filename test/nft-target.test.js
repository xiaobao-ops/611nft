import assert from 'node:assert/strict';
import test from 'node:test';
import {getAddress} from 'viem';
import {parseNftTarget, resolveNftTarget} from '../server/opensea-mint/target.js';

const NFT = getAddress('0x1000000000000000000000000000000000000001');

test('parses contract, OpenSea item, and collection targets', () => {
  assert.deepEqual(parseNftTarget(NFT), {
    kind: 'address', value: NFT, chainIdentifier: null, tokenId: null,
  });
  assert.deepEqual(parseNftTarget(`https://opensea.io/item/ethereum/${NFT}/12345678901234567890`), {
    kind: 'address', value: NFT, chainIdentifier: 'ethereum', tokenId: '12345678901234567890',
  });
  assert.deepEqual(parseNftTarget('https://opensea.io/collection/example-drop'), {
    kind: 'slug', value: 'example-drop', chainIdentifier: null, tokenId: null,
  });
  assert.throws(() => parseNftTarget('https://example.com/collection/example-drop'), /Only opensea.io/);
});

test('resolves a collection slug and prefers the selected chain', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    name: 'Example Drop',
    contracts: [
      {address: '0x2000000000000000000000000000000000000002', chain: 'base'},
      {address: NFT, chain: 'ethereum'},
    ],
  }), {status: 200, headers: {'content-type': 'application/json'}});
  const result = await resolveNftTarget({
    input: 'example-drop',
    preferredChainIdentifier: 'ethereum',
    opensea: {
      restUrl: 'https://api.opensea.io/api/v2',
      requestTimeoutMs: 1000,
      userAgent: 'test',
      apiKey: '',
    },
    fetchImpl,
  });
  assert.equal(result.contractAddress, NFT);
  assert.equal(result.chainIdentifier, 'ethereum');
  assert.equal(result.name, 'Example Drop');
});

test('prefers a supported collection chain when the selected chain is unavailable', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    name: 'Example Drop',
    contracts: [
      {address: '0x2000000000000000000000000000000000000002', chain: 'polygon'},
      {address: NFT, chain: 'ethereum'},
    ],
  }), {status: 200, headers: {'content-type': 'application/json'}});
  const result = await resolveNftTarget({
    input: 'example-drop',
    preferredChainIdentifier: 'robinhood',
    supportedChainIdentifiers: ['robinhood', 'ethereum'],
    opensea: {
      restUrl: 'https://api.opensea.io/api/v2',
      requestTimeoutMs: 1000,
      userAgent: 'test',
      apiKey: '',
    },
    fetchImpl,
  });
  assert.equal(result.contractAddress, NFT);
  assert.equal(result.chainIdentifier, 'ethereum');
});
