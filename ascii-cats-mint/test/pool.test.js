import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../src/pool.js';

test('preserves input order regardless of completion order', async () => {
  const items = [30, 10, 20, 5];
  const results = await mapWithConcurrency(items, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  assert.deepEqual(results, ['0:30', '1:10', '2:20', '3:5']);
});

test('never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);

  await mapWithConcurrency(items, 3, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  });

  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
});

test('passes the item and index to the worker', async () => {
  const seen = [];
  await mapWithConcurrency(['a', 'b'], 1, async (item, index) => {
    seen.push([item, index]);
  });
  assert.deepEqual(seen, [['a', 0], ['b', 1]]);
});

test('handles an empty list without invoking the worker', async () => {
  let called = false;
  const results = await mapWithConcurrency([], 4, async () => {
    called = true;
  });
  assert.deepEqual(results, []);
  assert.equal(called, false);
});

test('a limit larger than the item count still resolves every item', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 50, async (n) => n * 2);
  assert.deepEqual(results, [2, 4, 6]);
});
