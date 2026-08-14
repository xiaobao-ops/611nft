import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHybridProxyPool,
  createReserveProxyClient,
} from '../src/proxy-pool.js';

function proxyUrl(label) {
  return `http://${label}.invalid:8080`;
}

function makeDispatcherFactory({ closeErrors = new Set() } = {}) {
  const created = [];
  const createDispatcher = (url) => {
    const dispatcher = {
      url,
      closeCalls: 0,
      async close() {
        this.closeCalls += 1;
        if (closeErrors.has(url)) throw new Error(`close failed for ${url}`);
      },
    };
    created.push(dispatcher);
    return dispatcher;
  };
  return { createDispatcher, created };
}

function reportFor(dispatchers, outcomes) {
  const results = dispatchers.map((dispatcher, index) => {
    const outcome = outcomes.get(dispatcher.url);
    if (outcome instanceof Error || outcome === undefined || outcome === null) {
      return {
        index,
        ip: null,
        ok: false,
        error: outcome?.message ?? 'unreachable',
      };
    }
    return { index, ip: outcome, ok: true };
  });
  const counts = new Map();
  for (const result of results) {
    if (result.ip) counts.set(result.ip, (counts.get(result.ip) ?? 0) + 1);
  }
  return {
    results,
    uniqueCount: counts.size,
    duplicates: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([ip]) => ip),
  };
}

function scriptedApi(batches) {
  const calls = [];
  return {
    calls,
    async acquire(count) {
      calls.push(count);
      const next = batches.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
  };
}

test('prepare lazily combines 20 static and 30 API proxies, locks assignments, and shares concurrent work', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const dynamicProxyUrls = Array.from({ length: 30 }, (_, index) => proxyUrl(`dynamic-${index}`));
  const outcomes = new Map([
    ...staticProxyUrls.map((url, index) => [url, `10.0.0.${index + 1}`]),
    ...dynamicProxyUrls.map((url, index) => [url, `10.0.1.${index + 1}`]),
  ]);
  const apiClient = scriptedApi([dynamicProxyUrls]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const verifyCalls = [];
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => {
      verifyCalls.push(dispatchers.map(({ url }) => url));
      await Promise.resolve();
      return reportFor(dispatchers, outcomes);
    },
  });

  assert.deepEqual(apiClient.calls, []);
  assert.equal(created.length, 0);
  assert.throws(() => pool.dispatcherFor(0), /not prepared|not locked/i);

  const indexes = Array.from({ length: 50 }, (_, index) => index);
  const [first, second] = await Promise.all([
    pool.prepare({ indexes }),
    pool.prepare({ indexes }),
  ]);

  assert.equal(first, second);
  assert.equal(first.ready, true);
  assert.deepEqual(apiClient.calls, [30]);
  assert.equal(created.length, 50);
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].length, 50);
  assert.equal(pool.dispatcherFor(0).url, staticProxyUrls[0]);
  assert.equal(pool.dispatcherFor(19).url, staticProxyUrls[19]);
  assert.equal(pool.dispatcherFor(20).url, dynamicProxyUrls[0]);
  assert.equal(pool.dispatcherFor(49).url, dynamicProxyUrls[29]);
  assert.throws(() => pool.dispatcherFor(50), /not assigned/i);

  await pool.close();
  assert.ok(created.every(({ closeCalls }) => closeCalls === 1));
});

test('uses the configured static list length as the dynamic wallet boundary', async () => {
  const staticProxyUrls = [proxyUrl('static-only')];
  const dynamicProxyUrl = proxyUrl('dynamic-only');
  const apiClient = scriptedApi([[dynamicProxyUrl]]);
  const outcomes = new Map([
    [staticProxyUrls[0], '10.0.0.1'],
    [dynamicProxyUrl, '10.0.0.2'],
  ]);
  const { createDispatcher } = makeDispatcherFactory();
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(dispatchers, outcomes),
  });

  await pool.prepare({ indexes: [0, 1] });

  assert.deepEqual(apiClient.calls, [1]);
  assert.equal(pool.dispatcherFor(0).url, staticProxyUrls[0]);
  assert.equal(pool.dispatcherFor(1).url, dynamicProxyUrl);
  await pool.close();
});

test('failed static and dynamic slots are replaced in one batch and old dispatchers close exactly once', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const initialDynamic = proxyUrl('dynamic-bad');
  const replacements = [proxyUrl('replacement-static'), proxyUrl('replacement-dynamic')];
  const outcomes = new Map([
    [staticProxyUrls[0], new Error('static tunnel failed')],
    [initialDynamic, new Error('dynamic tunnel failed')],
    [replacements[0], '2.2.2.2'],
    [replacements[1], '3.3.3.3'],
  ]);
  const apiClient = scriptedApi([[initialDynamic], replacements]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const verifySizes = [];
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => {
      verifySizes.push(dispatchers.length);
      return reportFor(dispatchers, outcomes);
    },
  });

  await pool.prepare({ indexes: [0, 20] });

  assert.deepEqual(apiClient.calls, [1, 2]);
  assert.deepEqual(verifySizes, [2, 2]);
  assert.equal(pool.dispatcherFor(0).url, replacements[0]);
  assert.equal(pool.dispatcherFor(20).url, replacements[1]);
  assert.equal(created.find(({ url }) => url === staticProxyUrls[0]).closeCalls, 1);
  assert.equal(created.find(({ url }) => url === initialDynamic).closeCalls, 1);

  await pool.close();
  assert.ok(created.every(({ closeCalls }) => closeCalls === 1));
});

test('static failures can be replaced from a reserve proxy client', async () => {
  const staticProxyUrls = [proxyUrl('static-bad'), proxyUrl('static-good')];
  const reserveProxyUrl = proxyUrl('reserve-replacement');
  const outcomes = new Map([
    [staticProxyUrls[0], new Error('static tunnel failed')],
    [staticProxyUrls[1], '1.1.1.1'],
    [reserveProxyUrl, '2.2.2.2'],
  ]);
  const apiClient = scriptedApi([]);
  const replacementClient = scriptedApi([[reserveProxyUrl]]);
  const { createDispatcher } = makeDispatcherFactory();
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    replacementClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(dispatchers, outcomes),
  });

  await pool.prepare({ indexes: [0, 1] });

  assert.deepEqual(apiClient.calls, []);
  assert.deepEqual(replacementClient.calls, [1]);
  assert.equal(pool.dispatcherFor(0).url, reserveProxyUrl);
  assert.equal(pool.dispatcherFor(1).url, staticProxyUrls[1]);
  await pool.close();
});

test('refresh rechecks current assignments without rebuilding healthy dispatchers', async () => {
  const staticProxyUrls = [proxyUrl('static-0'), proxyUrl('static-1')];
  const outcomes = new Map([
    [staticProxyUrls[0], '1.1.1.1'],
    [staticProxyUrls[1], '2.2.2.2'],
  ]);
  const { createDispatcher, created } = makeDispatcherFactory();
  let verifyCalls = 0;
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient: scriptedApi([]),
    replacementClient: scriptedApi([]),
    createDispatcher,
    verifyEgressIps: async (dispatchers) => {
      verifyCalls += 1;
      await Promise.resolve();
      return reportFor(dispatchers, outcomes);
    },
  });
  const indexes = [0, 1];
  await pool.prepare({ indexes });

  const [first, second] = await Promise.all([
    pool.refresh({ indexes }),
    pool.refresh({ indexes }),
  ]);

  assert.equal(first, second);
  assert.equal(first.refreshed, true);
  assert.equal(first.replacementCount, 0);
  assert.equal(verifyCalls, 2);
  assert.equal(created.length, 2);
  assert.ok(created.every(({ closeCalls }) => closeCalls === 0));
  await pool.close();
});

test('refresh replaces only failed assignments and retains the replacement later', async () => {
  const staticProxyUrls = [proxyUrl('static-0'), proxyUrl('static-1')];
  const reserveProxyUrl = proxyUrl('reserve-0');
  const outcomes = new Map([
    [staticProxyUrls[0], '1.1.1.1'],
    [staticProxyUrls[1], '2.2.2.2'],
    [reserveProxyUrl, '3.3.3.3'],
  ]);
  const replacementClient = scriptedApi([[reserveProxyUrl]]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient: scriptedApi([]),
    replacementClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(dispatchers, outcomes),
  });
  const indexes = [0, 1];
  await pool.prepare({ indexes });
  outcomes.set(staticProxyUrls[0], new Error('proxy expired'));

  const refreshed = await pool.refresh({ indexes });
  const refreshedAgain = await pool.refresh({ indexes });

  assert.equal(refreshed.replacementCount, 1);
  assert.equal(refreshedAgain.replacementCount, 0);
  assert.deepEqual(replacementClient.calls, [1]);
  assert.equal(pool.dispatcherFor(0).url, reserveProxyUrl);
  assert.equal(pool.dispatcherFor(1).url, staticProxyUrls[1]);
  assert.equal(created.find(({ url }) => url === staticProxyUrls[0]).closeCalls, 1);
  await pool.close();
  assert.ok(created.every(({ closeCalls }) => closeCalls === 1));
});

test('reserve proxy client hands out each backup once and fails closed on shortage', async () => {
  const client = createReserveProxyClient({
    proxyUrls: [proxyUrl('reserve-1'), proxyUrl('reserve-2')],
  });

  assert.deepEqual(await client.acquire(1), [proxyUrl('reserve-1')]);
  assert.deepEqual(await client.acquire(1), [proxyUrl('reserve-2')]);
  await assert.rejects(
    () => client.acquire(1),
    /reserve proxy file requested 1 proxies but only 0 remain/,
  );
});

test('a duplicate group keeps only the lowest wallet index and replaces static or dynamic peers in one batch', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const initialDynamic = proxyUrl('dynamic-duplicate');
  const replacements = [proxyUrl('replacement-1'), proxyUrl('replacement-20')];
  const outcomes = new Map([
    [staticProxyUrls[0], '4.4.4.4'],
    [staticProxyUrls[1], '4.4.4.4'],
    [initialDynamic, '4.4.4.4'],
    [replacements[0], '5.5.5.5'],
    [replacements[1], '6.6.6.6'],
  ]);
  const apiClient = scriptedApi([[initialDynamic], replacements]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const verifiedUrls = [];
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => {
      verifiedUrls.push(dispatchers.map(({ url }) => url));
      return reportFor(dispatchers, outcomes);
    },
  });

  await pool.prepare({ indexes: [20, 1, 0] });

  assert.equal(pool.dispatcherFor(0).url, staticProxyUrls[0]);
  assert.equal(pool.dispatcherFor(1).url, replacements[0]);
  assert.equal(pool.dispatcherFor(20).url, replacements[1]);
  assert.deepEqual(apiClient.calls, [1, 2]);
  assert.deepEqual(verifiedUrls.map((urls) => urls.length), [3, 2]);
  assert.equal(created.find(({ url }) => url === staticProxyUrls[0]).closeCalls, 0);
  assert.equal(created.find(({ url }) => url === staticProxyUrls[1]).closeCalls, 1);
  assert.equal(created.find(({ url }) => url === initialDynamic).closeCalls, 1);

  await pool.close();
  assert.ok(created.every(({ closeCalls }) => closeCalls === 1));
});

test('replacement egress colliding with a retained IP is replaced again across batches', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const initialDynamic = proxyUrl('dynamic-failed');
  const colliding = proxyUrl('replacement-collision');
  const unique = proxyUrl('replacement-unique');
  const outcomes = new Map([
    [staticProxyUrls[0], '7.7.7.7'],
    [initialDynamic, new Error('failed')],
    [colliding, '7.7.7.7'],
    [unique, '8.8.8.8'],
  ]);
  const apiClient = scriptedApi([[initialDynamic], [colliding], [unique]]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const verifySizes = [];
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => {
      verifySizes.push(dispatchers.length);
      return reportFor(dispatchers, outcomes);
    },
  });

  const result = await pool.prepare({ indexes: [0, 20] });

  assert.equal(result.ready, true);
  assert.deepEqual(apiClient.calls, [1, 1, 1]);
  assert.deepEqual(verifySizes, [2, 1, 1]);
  assert.equal(pool.dispatcherFor(20).url, unique);
  assert.equal(created.find(({ url }) => url === colliding).closeCalls, 1);

  await pool.close();
});

test('API URLs cannot repeat within a response or across acquisition history', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const repeated = proxyUrl('repeated');
  const apiClient = scriptedApi([[repeated], [repeated]]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(
      dispatchers,
      new Map([
        [staticProxyUrls[0], '9.9.9.9'],
        [repeated, new Error('failed')],
      ]),
    ),
  });

  await assert.rejects(
    pool.prepare({ indexes: [0, 20] }),
    /previously acquired|repeated proxy URL/i,
  );
  assert.deepEqual(apiClient.calls, [1, 1]);
  assert.equal(created.length, 2);
  assert.ok(created.every(({ closeCalls }) => closeCalls === 1));
});

test('prepare rejects API shortages and closes every dispatcher already created', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const apiClient = scriptedApi([[proxyUrl('only-one')]]);
  const { createDispatcher, created } = makeDispatcherFactory();
  let verifyCalls = 0;
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async () => { verifyCalls += 1; },
  });

  await assert.rejects(pool.prepare({ indexes: [0, 20, 21] }), /requested 2|received 1|short/i);

  assert.equal(verifyCalls, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].closeCalls, 1);
  assert.throws(() => pool.dispatcherFor(0), /not prepared|not locked/i);
});

test('the cumulative replacement dispatcher budget stops retries before another API call', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const initial = [proxyUrl('initial-20'), proxyUrl('initial-21')];
  const replacements = [proxyUrl('replacement-20'), proxyUrl('replacement-21')];
  const allFailed = new Map([
    [initial[0], new Error('failed')],
    [initial[1], new Error('failed')],
    [replacements[0], new Error('failed again')],
    [replacements[1], new Error('failed again')],
  ]);
  const apiClient = scriptedApi([initial, replacements]);
  const { createDispatcher, created } = makeDispatcherFactory();
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(dispatchers, allFailed),
    maxReplacements: 2,
  });

  await assert.rejects(pool.prepare({ indexes: [20, 21] }), /replacement.*limit|limit.*replacement/i);

  assert.deepEqual(apiClient.calls, [2, 2]);
  assert.equal(created.length, 4);
  assert.ok(created.every(({ closeCalls }) => closeCalls === 1));
});

test('deadline is checked after API acquisition and after verification using the injected clock', async (t) => {
  await t.test('after API acquisition', async () => {
    let clock = 0;
    const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
    const { createDispatcher, created } = makeDispatcherFactory();
    let verifyCalls = 0;
    const pool = createHybridProxyPool({
      staticProxyUrls,
      apiClient: {
        async acquire() {
          clock = 11;
          return [proxyUrl('late')];
        },
      },
      createDispatcher,
      verifyEgressIps: async () => { verifyCalls += 1; },
      deadlineMs: 10,
      now: () => clock,
    });

    await assert.rejects(pool.prepare({ indexes: [0, 20] }), /deadline/i);
    assert.equal(verifyCalls, 0);
    assert.equal(created.length, 1);
    assert.equal(created[0].closeCalls, 1);
  });

  await t.test('after verification', async () => {
    let clock = 0;
    const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
    const { createDispatcher, created } = makeDispatcherFactory();
    const pool = createHybridProxyPool({
      staticProxyUrls,
      apiClient: scriptedApi([]),
      createDispatcher,
      verifyEgressIps: async (dispatchers) => {
        clock = 11;
        return reportFor(dispatchers, new Map([[staticProxyUrls[0], '1.1.1.1']]));
      },
      deadlineMs: 10,
      now: () => clock,
    });

    await assert.rejects(pool.prepare({ indexes: [0] }), /deadline/i);
    assert.equal(created.length, 1);
    assert.equal(created[0].closeCalls, 1);
  });
});

test('prepare cleanup preserves the primary error and later close retries a dispatcher that failed once', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const primaryError = new Error('primary verification failure');
  const created = [];
  const createDispatcher = (url) => {
    const dispatcher = {
      url,
      closeCalls: 0,
      async close() {
        this.closeCalls += 1;
        if (url === staticProxyUrls[0] && this.closeCalls === 1) {
          throw new Error(`transient close failure for ${url}`);
        }
      },
    };
    created.push(dispatcher);
    return dispatcher;
  };
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient: scriptedApi([]),
    createDispatcher,
    verifyEgressIps: async () => { throw primaryError; },
  });

  await assert.rejects(
    pool.prepare({ indexes: [0, 1] }),
    (error) => {
      assert.equal(error, primaryError);
      return true;
    },
  );
  await pool.close();
  await pool.close();

  assert.equal(created.length, 2);
  assert.equal(created[0].closeCalls, 2);
  assert.equal(created[1].closeCalls, 1);
});

test('a replacement close failure stays fail closed and the failed dispatcher remains retryable', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const failedDynamic = proxyUrl('failed-dynamic');
  const apiClient = scriptedApi([[failedDynamic], [proxyUrl('unused-replacement')]]);
  const { createDispatcher, created } = makeDispatcherFactory({
    closeErrors: new Set([failedDynamic]),
  });
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient,
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(
      dispatchers,
      new Map([
        [staticProxyUrls[0], '1.1.1.1'],
        [failedDynamic, new Error('unreachable')],
      ]),
    ),
  });

  await assert.rejects(pool.prepare({ indexes: [0, 20] }), /failed to close/i);

  assert.deepEqual(apiClient.calls, [1]);
  assert.equal(created.find(({ url }) => url === staticProxyUrls[0]).closeCalls, 1);
  assert.equal(created.find(({ url }) => url === failedDynamic).closeCalls, 2);
  await assert.rejects(pool.close(), /failed to close/i);
  assert.equal(created.find(({ url }) => url === failedDynamic).closeCalls, 3);
  assert.throws(() => pool.dispatcherFor(0), /not prepared|not locked/i);
});

test('normal close shares concurrent work, retries only failed dispatchers, then becomes idempotent', async () => {
  const staticProxyUrls = Array.from({ length: 20 }, (_, index) => proxyUrl(`static-${index}`));
  const created = [];
  const createDispatcher = (url) => {
    const dispatcher = {
      url,
      closeCalls: 0,
      async close() {
        this.closeCalls += 1;
        if (url === staticProxyUrls[0] && this.closeCalls === 1) {
          throw new Error(`transient close failure for ${url}`);
        }
      },
    };
    created.push(dispatcher);
    return dispatcher;
  };
  const pool = createHybridProxyPool({
    staticProxyUrls,
    apiClient: scriptedApi([]),
    createDispatcher,
    verifyEgressIps: async (dispatchers) => reportFor(
      dispatchers,
      new Map([
        [staticProxyUrls[0], '1.1.1.1'],
        [staticProxyUrls[1], '2.2.2.2'],
      ]),
    ),
  });
  await pool.prepare({ indexes: [0, 1] });

  const firstClose = pool.close();
  const secondClose = pool.close();
  assert.equal(firstClose, secondClose);
  await assert.rejects(firstClose, /failed to close/i);

  const retryClose = pool.close();
  assert.notEqual(retryClose, firstClose);
  await retryClose;
  assert.equal(pool.close(), retryClose);

  assert.equal(created[0].closeCalls, 2);
  assert.equal(created[1].closeCalls, 1);
  assert.throws(() => pool.dispatcherFor(0), /not prepared|not locked/i);
});
