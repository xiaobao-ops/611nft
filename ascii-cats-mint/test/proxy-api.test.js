import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProxyApiClient,
  normalizeProxyEntry,
} from '../src/proxy-api.js';

const API_URL = 'https://proxy.invalid/white/api?region=SG&num=30&token=secret';

test('normalizeProxyEntry converts an API record to an HTTP proxy URL', () => {
  assert.equal(
    normalizeProxyEntry({ host: '105.33.13.23', port: '8080' }),
    'http://105.33.13.23:8080',
  );
});

test('normalizeProxyEntry canonicalizes equivalent hosts for deduplication', async () => {
  assert.equal(
    normalizeProxyEntry({ host: 'EXAMPLE.COM', port: '8080' }),
    'http://example.com:8080',
  );
  assert.equal(
    normalizeProxyEntry({ host: '127.000.000.001', port: '8080' }),
    'http://127.0.0.1:8080',
  );
  assert.throws(
    () => normalizeProxyEntry({ host: '999.999.999.999', port: 8080 }),
    /proxy API record/i,
  );
});

test('normalizeProxyEntry rejects invalid hosts and ports', () => {
  for (const entry of [
    { host: '', port: 8080 },
    { host: 'bad host', port: 8080 },
    { host: '1.2.3.4/path', port: 8080 },
    { host: '1.2.3.4', port: 0 },
    { host: '1.2.3.4', port: 65536 },
    { host: '1.2.3.4', port: '8x' },
  ]) {
    assert.throws(() => normalizeProxyEntry(entry), /proxy API record/i);
  }
});

test('normalizeProxyEntry enforces IPv4 or strict DNS label syntax', () => {
  for (const host of [
    '.',
    'a..example',
    '-bad.example',
    'bad-.example',
    'bad_name.example',
    `${'a'.repeat(64)}.example`,
    `${`${'a'.repeat(63)}.`.repeat(4)}a`,
  ]) {
    assert.throws(
      () => normalizeProxyEntry({ host, port: 8080 }),
      /proxy API record/i,
    );
  }

  assert.equal(
    normalizeProxyEntry({ host: 'A-1.Valid-Host.Example', port: 8080 }),
    'http://a-1.valid-host.example:8080',
  );
});

test('acquire overrides num, parses JSON records, and removes duplicates', async () => {
  let requestedUrl;
  let requestedOptions;
  const client = createProxyApiClient({
    apiUrl: API_URL,
    fetchFn: async (url, options) => {
      requestedUrl = new URL(url);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => [
          { host: '1.2.3.4', port: '8080' },
          { host: '1.2.3.4', port: 8080 },
          { host: 'proxy.example', port: 3128 },
        ],
      };
    },
  });

  assert.deepEqual(await client.acquire(2), [
    'http://1.2.3.4:8080',
    'http://proxy.example:3128',
  ]);
  assert.equal(requestedUrl.searchParams.get('num'), '2');
  assert.equal(requestedUrl.searchParams.get('region'), 'SG');
  assert.equal(requestedOptions.redirect, 'error');
});

test('acquire deduplicates canonical hosts, returns only count, and fails closed on shortage', async () => {
  const responses = [
    [
      { host: 'EXAMPLE.COM', port: 8080 },
      { host: 'example.com', port: '8080' },
    ],
    [
      { host: '1.1.1.1', port: 80 },
      { host: '2.2.2.2', port: 81 },
      { host: '3.3.3.3', port: 82 },
    ],
  ];
  const client = createProxyApiClient({
    apiUrl: API_URL,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }),
  });

  await assert.rejects(client.acquire(2), /requested 2.*received 1/i);
  assert.deepEqual(await client.acquire(2), [
    'http://1.1.1.1:80',
    'http://2.2.2.2:81',
  ]);
});

test('createProxyApiClient rejects non-HTTPS API URLs without fetching', async () => {
  let calls = 0;
  assert.throws(
    () => createProxyApiClient({
      apiUrl: 'http://proxy.invalid/api?token=secret',
      fetchFn: async () => { calls += 1; },
    }),
    /HTTPS/i,
  );
  assert.equal(calls, 0);
});

test('acquire rejects non-2xx responses without exposing the API URL', async () => {
  const client = createProxyApiClient({
    apiUrl: API_URL,
    fetchFn: async () => ({ ok: false, status: 503 }),
  });

  await assert.rejects(client.acquire(1), (error) => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /proxy\.invalid|token=secret/);
    return true;
  });
});

test('acquire rejects malformed JSON and invalid response shapes without exposing the API URL', async () => {
  for (const json of [
    async () => { throw new SyntaxError('unexpected token at proxy.invalid'); },
    async () => ({ host: '1.2.3.4', port: 8080 }),
    async () => [{ host: '1.2.3.4', port: 70000 }],
  ]) {
    const client = createProxyApiClient({
      apiUrl: API_URL,
      fetchFn: async () => ({ ok: true, status: 200, json }),
    });
    await assert.rejects(client.acquire(1), (error) => {
      assert.match(error.message, /proxy API/i);
      assert.doesNotMatch(error.message, /proxy\.invalid|token=secret/);
      return true;
    });
  }
});

test('acquire times out using the configured timeout and redacts fetch errors', async () => {
  const client = createProxyApiClient({
    apiUrl: API_URL,
    timeoutMs: 5,
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('test hung')), 100);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(keepAlive);
          reject(new Error(`request failed for ${API_URL}`));
        },
        { once: true },
      );
    }),
  });

  await assert.rejects(client.acquire(1), (error) => {
    assert.match(error.message, /timed out|request failed/i);
    assert.doesNotMatch(error.message, /proxy\.invalid|token=secret/);
    return true;
  });
});

test('acquire validates the requested count before fetching', async () => {
  let calls = 0;
  const client = createProxyApiClient({
    apiUrl: API_URL,
    fetchFn: async () => { calls += 1; },
  });

  await assert.rejects(client.acquire(0), /positive integer/i);
  assert.equal(calls, 0);
});
