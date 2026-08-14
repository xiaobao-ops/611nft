import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import {
  createDispatcher,
  createSocksConnector,
  loadProxies,
  parseProxyList,
  verifyEgressIps,
  verifyStableEgressIps,
} from '../src/proxy.js';

test('parseProxyList trims and drops blanks and comments', () => {
  const text = [
    '# first proxy pool',
    'http://user:pass@host1:8080',
    '',
    '   http://host2:8081   ',
    '# trailing comment',
    'socks5://host3:1080',
  ].join('\n');

  assert.deepEqual(parseProxyList(text), [
    'http://user:pass@host1:8080',
    'http://host2:8081',
    'socks5://host3:1080',
  ]);
});

test('parseProxyList normalizes host:port:user:pass lines as SOCKS5 proxies', () => {
  assert.deepEqual(parseProxyList('1.2.3.4:1080:user name:p@ss'), [
    'socks5h://user%20name:p%40ss@1.2.3.4:1080',
  ]);
});

test('parseProxyList normalizes bare host:port lines as HTTP proxies', () => {
  assert.deepEqual(parseProxyList('105.33.13.23:8080'), [
    'http://105.33.13.23:8080',
  ]);
});

test('loadProxies reads and parses a proxy file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxies-'));
  const file = join(dir, 'proxies.txt');
  await writeFile(file, 'http://a:1\n# note\nhttp://b:2\n', 'utf8');

  assert.deepEqual(await loadProxies(file), ['http://a:1', 'http://b:2']);
});

test('loadProxies returns an empty list when the file is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxies-'));
  assert.deepEqual(await loadProxies(join(dir, 'missing.txt')), []);
});

test('createDispatcher builds a dispatcher for a valid proxy URL', async () => {
  const dispatcher = createDispatcher('http://user:pass@host:8080');
  assert.equal(typeof dispatcher.dispatch, 'function');
  await dispatcher.close();
});

test('SOCKS5 connector tunnels to the destination and upgrades HTTPS over that socket', async () => {
  const calls = [];
  const socket = { fake: true };
  const connector = createSocksConnector('socks5h://user:pass@127.0.0.1:1080', {
    async createConnection(options) {
      calls.push({ type: 'socks', options });
      return { socket };
    },
    tlsConnector(options, callback) {
      calls.push({ type: 'tls', options });
      callback(null, { secure: true });
    },
  });

  const connected = await new Promise((resolve, reject) => {
    connector(
      {
        hostname: 'api.ipify.org',
        host: 'api.ipify.org',
        protocol: 'https:',
        port: '443',
        servername: 'api.ipify.org',
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });

  assert.deepEqual(connected, { secure: true });
  assert.deepEqual(calls[0], {
    type: 'socks',
    options: {
      proxy: {
        host: '127.0.0.1',
        port: 1080,
        type: 5,
        userId: 'user',
        password: 'pass',
      },
      command: 'connect',
      destination: { host: 'api.ipify.org', port: 443 },
    },
  });
  assert.equal(calls[1].type, 'tls');
  assert.equal(calls[1].options.httpSocket, socket);
});

test('createDispatcher builds an undici dispatcher for SOCKS5 URLs', async () => {
  const dispatcher = createDispatcher('socks5h://user:pass@127.0.0.1:1080');
  assert.equal(typeof dispatcher.dispatch, 'function');
  await dispatcher.close();
});

test('createDispatcher rejects a malformed proxy URL', () => {
  assert.throws(() => createDispatcher('not-a-url'), /invalid proxy URL/);
});

test('createDispatcher redacts malformed proxy URL credentials from errors', () => {
  const secret = 'top-secret-password';
  assert.throws(
    () => createDispatcher(`http://user:${secret}@`),
    (error) => {
      assert.match(error.message, /invalid proxy URL/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /user:/);
      assert.doesNotMatch(inspect(error), new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test('verifyEgressIps reports each egress IP and flags duplicates', async () => {
  const dispatchers = ['d0', 'd1', 'd2'];
  const ipByDispatcher = { d0: '1.1.1.1', d1: '2.2.2.2', d2: '1.1.1.1' };
  const fetchFn = async (_url, { dispatcher }) => ({
    ok: true,
    json: async () => ({ ip: ipByDispatcher[dispatcher] }),
  });

  const report = await verifyEgressIps(dispatchers, { fetchFn });

  assert.deepEqual(
    report.results.map((r) => r.ip),
    ['1.1.1.1', '2.2.2.2', '1.1.1.1'],
  );
  assert.equal(report.uniqueCount, 2);
  assert.deepEqual(report.duplicates, ['1.1.1.1']);
});

test('verifyEgressIps isolates a failing proxy without aborting the rest', async () => {
  const dispatchers = ['ok', 'bad'];
  const fetchFn = async (_url, { dispatcher }) => {
    if (dispatcher === 'bad') throw new Error('tunnel refused');
    return { ok: true, json: async () => ({ ip: '9.9.9.9' }) };
  };

  const report = await verifyEgressIps(dispatchers, { fetchFn });

  assert.equal(report.results[0].ip, '9.9.9.9');
  assert.equal(report.results[1].ok, false);
  assert.match(report.results[1].error, /tunnel refused/);
  assert.equal(report.uniqueCount, 1);
});

test('verifyEgressIps aborts a proxy that never responds instead of hanging startup', async () => {
  const fetchFn = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });

  const report = await Promise.race([
    verifyEgressIps(['slow'], { fetchFn, timeoutMs: 5 }),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('proxy preflight hung')), 50),
    ),
  ]);

  assert.equal(report.results[0].ok, false);
  assert.match(report.results[0].error, /aborted/);
});

test('verifyStableEgressIps marks two unique stable rounds ready', async () => {
  const dispatchers = ['d0', 'd1'];
  const ipByDispatcher = { d0: '1.1.1.1', d1: '2.2.2.2' };
  const fetchFn = async (_url, { dispatcher }) => ({
    ok: true,
    json: async () => ({ ip: ipByDispatcher[dispatcher] }),
  });

  const report = await verifyStableEgressIps(dispatchers, { fetchFn });

  assert.equal(report.ready, true);
  assert.equal(report.rounds.length, 2);
  assert.equal(report.uniqueCount, 2);
  assert.equal(report.stableCount, 2);
  assert.deepEqual(report.failedIndices, []);
  assert.deepEqual(report.unstableIndices, []);
  assert.deepEqual(report.duplicates, []);
});

test('verifyStableEgressIps is not ready when a proxy fails either round', async () => {
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 2) throw new Error('temporary tunnel failure');
    return { ok: true, json: async () => ({ ip: '1.1.1.1' }) };
  };

  const report = await verifyStableEgressIps(['d0'], { fetchFn });

  assert.equal(report.ready, false);
  assert.deepEqual(report.failedIndices, [0]);
  assert.equal(report.stableCount, 0);
});

test('verifyStableEgressIps is not ready when a round contains duplicate IPs', async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ ip: '1.1.1.1' }),
  });

  const report = await verifyStableEgressIps(['d0', 'd1'], { fetchFn });

  assert.equal(report.ready, false);
  assert.deepEqual(report.duplicates, ['1.1.1.1']);
  assert.equal(report.uniqueCount, 1);
});

test('verifyStableEgressIps is not ready when a sticky session changes IP', async () => {
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    return {
      ok: true,
      json: async () => ({ ip: call === 1 ? '1.1.1.1' : '2.2.2.2' }),
    };
  };

  const report = await verifyStableEgressIps(['d0'], { fetchFn });

  assert.equal(report.ready, false);
  assert.deepEqual(report.unstableIndices, [0]);
  assert.equal(report.stableCount, 0);
});
