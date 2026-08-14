import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveWallets,
  loadPrivateKeyWallets,
  parsePrivateKeyList,
} from '../src/wallets.js';

// Hardhat default test mnemonic — deterministic, well-known, never funded.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const PATH_BASE = "m/44'/60'/0'/0";
const KNOWN_ADDRESSES = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
];
const KEY_ONE = `0x${'11'.repeat(32)}`;
const KEY_TWO = `0x${'22'.repeat(32)}`;

test('derives the requested number of wallets', () => {
  const wallets = deriveWallets({
    mnemonic: TEST_MNEMONIC,
    count: 5,
    pathBase: PATH_BASE,
  });
  assert.equal(wallets.length, 5);
});

test('derivation is deterministic and matches standard BIP-44 addresses', () => {
  const wallets = deriveWallets({
    mnemonic: TEST_MNEMONIC,
    count: 3,
    pathBase: PATH_BASE,
  });

  wallets.forEach((entry, i) => {
    assert.equal(entry.index, i);
    assert.equal(entry.address, KNOWN_ADDRESSES[i]);
    assert.equal(entry.hdPath, `${PATH_BASE}/${i}`);
    assert.equal(entry.wallet.address, KNOWN_ADDRESSES[i]);
  });
});

test('produces unique addresses across the derived set', () => {
  const wallets = deriveWallets({
    mnemonic: TEST_MNEMONIC,
    count: 20,
    pathBase: PATH_BASE,
  });
  const unique = new Set(wallets.map((w) => w.address));
  assert.equal(unique.size, 20);
});

test('connects each wallet to the provided provider', () => {
  const provider = { marker: 'shared-provider' };
  const wallets = deriveWallets({
    mnemonic: TEST_MNEMONIC,
    count: 2,
    pathBase: PATH_BASE,
    provider,
  });
  for (const { wallet } of wallets) {
    assert.equal(wallet.provider, provider);
  }
});

test('rejects a non-positive count', () => {
  assert.throws(
    () => deriveWallets({ mnemonic: TEST_MNEMONIC, count: 0, pathBase: PATH_BASE }),
    /count must be a positive integer/,
  );
});

test('rejects an invalid mnemonic', () => {
  assert.throws(
    () => deriveWallets({ mnemonic: 'not a real mnemonic', count: 1, pathBase: PATH_BASE }),
    /invalid mnemonic/i,
  );
});

test('parses private key files with optional wallet labels', () => {
  assert.deepEqual(parsePrivateKeyList(`# comment\ndefault,${KEY_ONE}\nbt-002=${KEY_TWO}\n`), [
    { label: 'default', privateKey: KEY_ONE },
    { label: 'bt-002', privateKey: KEY_TWO },
  ]);
});

test('rejects malformed private key file lines', () => {
  assert.throws(
    () => parsePrivateKeyList('bt-001 without-a-key'),
    /wallet key line 1 must contain exactly one private key/,
  );
});

test('loads private key wallets and enforces the expected count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wallet-keys-'));
  const file = join(dir, 'wallets.txt');
  await writeFile(file, `default,${KEY_ONE}\nbt-002,${KEY_TWO}\n`, 'utf8');

  const provider = { marker: 'shared-provider' };
  const wallets = await loadPrivateKeyWallets({ filePath: file, count: 2, provider });

  assert.equal(wallets.length, 2);
  assert.equal(wallets[0].index, 0);
  assert.equal(wallets[0].label, 'default');
  assert.equal(wallets[0].wallet.provider, provider);
  assert.match(wallets[0].address, /^0x[a-fA-F0-9]{40}$/);
  await assert.rejects(
    () => loadPrivateKeyWallets({ filePath: file, count: 3, provider }),
    /expected exactly 3 private keys, found 2/,
  );
});

test('rejects duplicate private key wallet addresses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wallet-keys-'));
  const file = join(dir, 'wallets.txt');
  await writeFile(file, `${KEY_ONE}\n${KEY_ONE}\n`, 'utf8');

  await assert.rejects(
    () => loadPrivateKeyWallets({ filePath: file, count: 2 }),
    /duplicate wallet address at wallet key line 2/,
  );
});
