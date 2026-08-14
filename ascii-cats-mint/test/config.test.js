import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

const VALID_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
// Well-known throwaway BIP-39 test mnemonic (Hardhat default). Never funded.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const PROXY_API_URL =
  'https://proxy-api.example.test/white/api?region=SG&num=30&type=json';

test('requires PRIVATE_KEY, MNEMONIC, or PRIVATE_KEYS_FILE', () => {
  assert.throws(() => loadConfig({}), /PRIVATE_KEY, MNEMONIC, or PRIVATE_KEYS_FILE is required/);
});

test('rejects invalid numeric limits', () => {
  const invalidValues = [
    ['POLL_INTERVAL_MS', '0'],
    ['POLL_INTERVAL_MS', '1.5'],
    ['MAX_GAS_LIMIT', '-1'],
    ['MAX_GAS_LIMIT', '1.5'],
    ['MAX_FEE_PER_GAS_GWEI', '0'],
    ['MAX_FEE_PER_GAS_GWEI', 'not-a-number'],
    ['CONFIRMATIONS', '-1'],
    ['CONFIRMATIONS', '1.5'],
    ['TICKET_TIMEOUT_MS', '0'],
    ['TICKET_TIMEOUT_MS', '1.5'],
  ];

  for (const [name, value] of invalidValues) {
    assert.throws(
      () => loadConfig({ PRIVATE_KEY: VALID_PRIVATE_KEY, [name]: value }),
      new RegExp(`${name} must be a positive`),
      `${name}=${value} should be rejected`,
    );
  }
});

test('accepts a 32-byte private key and applies safe defaults', () => {
  const config = loadConfig({ PRIVATE_KEY: VALID_PRIVATE_KEY });

  assert.equal(config.privateKey, VALID_PRIVATE_KEY);
  assert.equal(config.mnemonic, undefined);
  assert.equal(config.mode, 'single');
  assert.equal(config.pollIntervalMs, 500);
  assert.equal(config.ticketTimeoutMs, 10000);
  assert.equal(config.maxGasLimit, 500000n);
  assert.equal(config.maxFeePerGasGwei, 5);
  assert.equal(config.confirmations, 1);
  assert.equal(config.failedReceiptRetries, 0);
  assert.equal(config.openClawDiscordTarget, undefined);
  assert.equal(config.openClawTimeoutMs, 10000);
  assert.equal(config.arm, false);
  assert.ok(Object.isFrozen(config));
});

test('accepts a mnemonic and applies multi-wallet defaults', () => {
  const config = loadConfig({ MNEMONIC: TEST_MNEMONIC, PROXY_API_URL });

  assert.equal(config.mode, 'multi');
  assert.equal(config.mnemonic, TEST_MNEMONIC);
  assert.equal(config.privateKey, undefined);
  assert.equal(config.walletCount, 50);
  assert.equal(config.derivationPathBase, "m/44'/60'/0'/0");
  assert.equal(config.proxyFile, 'proxies.txt');
  assert.equal(config.proxyReserveFile, undefined);
  assert.equal(config.proxyPreheat, false);
  assert.equal(config.proxyPreheatRecheckMs, 0);
  assert.equal(config.mintConcurrency, 10);
  assert.equal(config.allowProxyReuse, false);
  assert.equal(config.proxyApiUrl, PROXY_API_URL);
  assert.equal(config.staticProxyCount, 20);
  assert.equal(config.dynamicProxyCount, 30);
  assert.equal(config.proxyApiTimeoutMs, 10000);
  assert.equal(config.proxyCheckTimeoutMs, 10000);
  assert.equal(config.proxyMaxReplacements, 20);
  assert.equal(config.proxyPoolDeadlineMs, 60000);
  assert.equal(config.arm, false);
  assert.equal(config.failedReceiptRetries, 0);
  assert.equal(config.ticketTimeoutMs, 10000);
  // Shared numeric safety limits still apply in multi mode.
  assert.equal(config.pollIntervalMs, 500);
  assert.equal(config.maxGasLimit, 500000n);
  assert.ok(Object.isFrozen(config));
});

test('accepts a private key file as a multi-wallet source', () => {
  const config = loadConfig({
    PRIVATE_KEYS_FILE: 'wallets.txt',
    WALLET_COUNT: '2',
    STATIC_PROXY_COUNT: '2',
    DYNAMIC_PROXY_COUNT: '0',
  });

  assert.equal(config.mode, 'multi');
  assert.equal(config.walletSource, 'private-keys-file');
  assert.equal(config.privateKeysFile, 'wallets.txt');
  assert.equal(config.mnemonic, undefined);
  assert.equal(config.walletCount, 2);
  assert.equal(config.staticProxyCount, 2);
  assert.equal(config.dynamicProxyCount, 0);
});

test('rejects simultaneous mnemonic and private key file sources', () => {
  assert.throws(
    () => loadConfig({ MNEMONIC: TEST_MNEMONIC, PRIVATE_KEYS_FILE: 'wallets.txt' }),
    /MNEMONIC and PRIVATE_KEYS_FILE are mutually exclusive/,
  );
});

test('multi mode honours overrides for count, concurrency, path, and reuse', () => {
  const config = loadConfig({
    MNEMONIC: TEST_MNEMONIC,
    WALLET_COUNT: '3',
    MINT_CONCURRENCY: '2',
    DERIVATION_PATH_BASE: "m/44'/60'/0'/1",
    PROXY_FILE: 'custom-proxies.txt',
    PROXY_RESERVE_FILE: 'reserve-proxies.txt',
    ALLOW_PROXY_REUSE: 'true',
    STATIC_PROXY_COUNT: '1',
    DYNAMIC_PROXY_COUNT: '2',
    PROXY_API_URL,
    PROXY_API_TIMEOUT_MS: '2000',
    PROXY_CHECK_TIMEOUT_MS: '3000',
    PROXY_MAX_REPLACEMENTS: '0',
    PROXY_POOL_DEADLINE_MS: '4000',
    PROXY_PREHEAT: 'true',
    PROXY_PREHEAT_RECHECK_MS: '3600000',
    MINT_FAILED_RECEIPT_RETRIES: '1',
    OPENCLAW_DISCORD_TARGET: 'channel:1234567890',
    OPENCLAW_TIMEOUT_MS: '7000',
    TICKET_TIMEOUT_MS: '8000',
  });

  assert.equal(config.walletCount, 3);
  assert.equal(config.mintConcurrency, 2);
  assert.equal(config.derivationPathBase, "m/44'/60'/0'/1");
  assert.equal(config.proxyFile, 'custom-proxies.txt');
  assert.equal(config.proxyReserveFile, 'reserve-proxies.txt');
  assert.equal(config.allowProxyReuse, true);
  assert.equal(config.staticProxyCount, 1);
  assert.equal(config.dynamicProxyCount, 2);
  assert.equal(config.proxyApiTimeoutMs, 2000);
  assert.equal(config.proxyCheckTimeoutMs, 3000);
  assert.equal(config.proxyMaxReplacements, 0);
  assert.equal(config.proxyPoolDeadlineMs, 4000);
  assert.equal(config.proxyPreheat, true);
  assert.equal(config.proxyPreheatRecheckMs, 3600000);
  assert.equal(config.failedReceiptRetries, 1);
  assert.equal(config.openClawDiscordTarget, 'channel:1234567890');
  assert.equal(config.openClawTimeoutMs, 7000);
  assert.equal(config.ticketTimeoutMs, 8000);
});

test('rejects an invalid mnemonic word count', () => {
  assert.throws(
    () => loadConfig({ MNEMONIC: 'only three words' }),
    /MNEMONIC must be a valid 12\/15\/18\/21\/24-word phrase/,
  );
});

test('rejects invalid multi-wallet numeric limits', () => {
  for (const [name, value] of [
    ['WALLET_COUNT', '0'],
    ['WALLET_COUNT', '1.5'],
    ['MINT_CONCURRENCY', '-1'],
    ['MINT_CONCURRENCY', 'abc'],
    ['STATIC_PROXY_COUNT', '-1'],
    ['STATIC_PROXY_COUNT', '1.5'],
    ['DYNAMIC_PROXY_COUNT', '-1'],
    ['DYNAMIC_PROXY_COUNT', '1.5'],
    ['PROXY_API_TIMEOUT_MS', '0'],
    ['PROXY_CHECK_TIMEOUT_MS', '0'],
    ['PROXY_MAX_REPLACEMENTS', '-1'],
    ['PROXY_MAX_REPLACEMENTS', '1.5'],
    ['PROXY_POOL_DEADLINE_MS', '0'],
    ['PROXY_PREHEAT_RECHECK_MS', '-1'],
    ['PROXY_PREHEAT_RECHECK_MS', '1.5'],
    ['MINT_FAILED_RECEIPT_RETRIES', '-1'],
    ['MINT_FAILED_RECEIPT_RETRIES', '1.5'],
    ['OPENCLAW_TIMEOUT_MS', '0'],
  ]) {
    assert.throws(
      () => loadConfig({ MNEMONIC: TEST_MNEMONIC, PROXY_API_URL, [name]: value }),
      new RegExp(`${name} must be a (?:positive|non-negative) integer`),
      `${name}=${value} should be rejected`,
    );
  }
});

test('rejects Discord targets that are not explicit channel IDs', () => {
  for (const target of ['crypto', '#crypto', 'user:123', 'channel:not-a-number']) {
    assert.throws(
      () => loadConfig({ PRIVATE_KEY: VALID_PRIVATE_KEY, OPENCLAW_DISCORD_TARGET: target }),
      /OPENCLAW_DISCORD_TARGET must use the form channel:<numeric-id>/,
    );
  }
});

test('requires static and dynamic proxy counts to equal WALLET_COUNT', () => {
  assert.throws(
    () => loadConfig({
      MNEMONIC: TEST_MNEMONIC,
      WALLET_COUNT: '4',
      STATIC_PROXY_COUNT: '1',
      DYNAMIC_PROXY_COUNT: '2',
      PROXY_API_URL,
    }),
    /STATIC_PROXY_COUNT \+ DYNAMIC_PROXY_COUNT must equal WALLET_COUNT/,
  );
});

test('requires an HTTPS proxy API URL only when dynamic proxies are enabled', () => {
  for (const proxyApiUrl of [undefined, '', 'http://proxy-api.example.test/white/api']) {
    assert.throws(
      () => loadConfig({
        MNEMONIC: TEST_MNEMONIC,
        WALLET_COUNT: '1',
        STATIC_PROXY_COUNT: '0',
        DYNAMIC_PROXY_COUNT: '1',
        PROXY_API_URL: proxyApiUrl,
      }),
      /PROXY_API_URL must be an HTTPS URL when DYNAMIC_PROXY_COUNT is greater than 0/,
    );
  }

  const allStatic = loadConfig({
    MNEMONIC: TEST_MNEMONIC,
    WALLET_COUNT: '2',
    STATIC_PROXY_COUNT: '2',
    DYNAMIC_PROXY_COUNT: '0',
    PROXY_MAX_REPLACEMENTS: '0',
  });
  assert.equal(allStatic.proxyApiUrl, undefined);
  assert.equal(allStatic.dynamicProxyCount, 0);
});

test('parses ARM as a boolean gate in both modes', () => {
  assert.equal(loadConfig({ PRIVATE_KEY: VALID_PRIVATE_KEY, ARM: 'true' }).arm, true);
  assert.equal(loadConfig({ MNEMONIC: TEST_MNEMONIC, PROXY_API_URL, ARM: '1' }).arm, true);
  assert.equal(loadConfig({ MNEMONIC: TEST_MNEMONIC, PROXY_API_URL, ARM: 'false' }).arm, false);
  assert.equal(loadConfig({ MNEMONIC: TEST_MNEMONIC, PROXY_API_URL, ARM: '' }).arm, false);
});
