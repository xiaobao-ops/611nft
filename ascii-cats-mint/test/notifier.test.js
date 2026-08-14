import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenClawDiscordNotifier } from '../src/notifier.js';

test('queues Mint-open and confirmed-success messages in order', async () => {
  const sent = [];
  const notifier = createOpenClawDiscordNotifier({
    target: 'channel:123',
    timeoutMs: 5000,
    execute: async (payload) => sent.push(payload),
  });

  notifier.notifyMintOpen({ pendingCount: 200 });
  notifier.notifyMintSuccess({
    index: 7,
    address: '0x1234567890123456789012345678901234567890',
    txHash: `0x${'ab'.repeat(32)}`,
    confirmedCount: 1,
    totalCount: 200,
    recovered: false,
  });
  await notifier.flush();

  assert.equal(sent.length, 2);
  assert.match(sent[0].message, /Mint 已开启/);
  assert.match(sent[0].message, /200/);
  assert.match(sent[1].message, /Mint 成功/);
  assert.match(sent[1].message, /#8/);
  assert.match(sent[1].message, /1\/200/);
  assert.equal(sent[0].target, 'channel:123');
});

test('notification failures are logged and do not reject flush', async () => {
  const logs = [];
  const notifier = createOpenClawDiscordNotifier({
    target: 'channel:123',
    log: (line) => logs.push(line),
    execute: async () => { throw new Error('gateway unavailable'); },
  });

  notifier.notifyMintOpen({ pendingCount: 1 });
  await notifier.flush();

  assert.ok(logs.some((line) => line.includes('discord notification failed')));
});

test('disabled notifier performs no OpenClaw calls', async () => {
  let calls = 0;
  const notifier = createOpenClawDiscordNotifier({
    execute: async () => { calls += 1; },
  });

  notifier.notifyMintOpen({ pendingCount: 1 });
  await notifier.flush();

  assert.equal(notifier.enabled, false);
  assert.equal(calls, 0);
});
