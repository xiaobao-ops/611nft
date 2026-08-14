import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore, createWalletStateStores } from '../src/state.js';

async function temporaryStateStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ascii-cats-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, '.mint-state.json');
  return { path, store: createStateStore(path) };
}

test('load returns null when state is missing', async (t) => {
  const { store } = await temporaryStateStore(t);

  assert.equal(await store.load(), null);
});

test('reservePrepared exclusively persists a prepared state', async (t) => {
  const { path, store } = await temporaryStateStore(t);

  await store.reservePrepared({
    wallet: '0xwallet',
    signature: 'must-not-be-persisted',
  });

  const loaded = await store.load();
  assert.deepEqual(Object.keys(loaded).sort(), ['preparedAt', 'status', 'wallet']);
  assert.equal(loaded.status, 'prepared');
  assert.equal(loaded.wallet, '0xwallet');
  assert.equal(typeof loaded.preparedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(loaded.preparedAt)));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), loaded);
  await assert.rejects(
    store.reservePrepared({ wallet: '0xwallet' }),
    /mint state already exists; manual inspection required/,
  );
});

test('concurrent reservePrepared calls allow exactly one exclusive winner', async (t) => {
  const { path } = await temporaryStateStore(t);
  const first = createStateStore(path);
  const second = createStateStore(path);

  const results = await Promise.allSettled([
    first.reservePrepared({ wallet: '0xwallet' }),
    second.reservePrepared({ wallet: '0xwallet' }),
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.match(
    results.find(({ status }) => status === 'rejected').reason.message,
    /mint state already exists; manual inspection required/,
  );
  assert.equal((await first.load()).status, 'prepared');
});

test('markTicketRequested atomically upgrades only the matching prepared wallet', async (t) => {
  const { path, store } = await temporaryStateStore(t);

  await assert.rejects(
    store.markTicketRequested({ wallet: '0xwallet' }),
    /prepared mint state missing or mismatched; manual inspection required/,
  );

  await store.reservePrepared({ wallet: '0xwallet' });
  await assert.rejects(
    store.markTicketRequested({ wallet: '0xother' }),
    /prepared mint state missing or mismatched; manual inspection required/,
  );
  assert.equal((await store.load()).status, 'prepared');

  await store.markTicketRequested({ wallet: '0xWALLET' });

  const loaded = await store.load();
  assert.deepEqual(Object.keys(loaded).sort(), [
    'status',
    'ticketRequestedAt',
    'wallet',
  ]);
  assert.equal(loaded.status, 'ticket-requested');
  assert.equal(loaded.wallet, '0xWALLET');
  assert.equal(typeof loaded.ticketRequestedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(loaded.ticketRequestedAt)));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), loaded);

  await assert.rejects(
    store.markTicketRequested({ wallet: '0xwallet' }),
    /prepared mint state missing or mismatched; manual inspection required/,
  );
});

test('a recreated state store recovers the persisted ticket-requested state', async (t) => {
  const { path, store } = await temporaryStateStore(t);
  await store.reservePrepared({ wallet: '0xwallet' });
  await store.markTicketRequested({ wallet: '0xwallet' });

  const restartedStore = createStateStore(path);
  const recovered = await restartedStore.load();

  assert.equal(recovered.status, 'ticket-requested');
  assert.equal(recovered.wallet, '0xwallet');
  assert.equal(typeof recovered.ticketRequestedAt, 'string');
});

test('markTicketRequested write failure preserves the prepared state', async (t) => {
  const { path, store } = await temporaryStateStore(t);
  await store.reservePrepared({ wallet: '0xwallet' });
  await mkdir(`${path}.tmp`);

  await assert.rejects(store.markTicketRequested({ wallet: '0xwallet' }));

  const recovered = await createStateStore(path).load();
  assert.equal(recovered.status, 'prepared');
  assert.equal(recovered.wallet, '0xwallet');
});

test('saveSubmitted persists only the submitted transaction state', async (t) => {
  const { path, store } = await temporaryStateStore(t);

  await store.reservePrepared({ wallet: '0xwallet' });
  await store.markTicketRequested({ wallet: '0xwallet' });

  await store.saveSubmitted({
    txHash: '0xtransaction',
    wallet: '0xwallet',
    signature: 'must-not-be-persisted',
    ignored: true,
  });

  const loaded = await store.load();
  assert.deepEqual(Object.keys(loaded).sort(), [
    'status',
    'submittedAt',
    'txHash',
    'wallet',
  ]);
  assert.equal(loaded.status, 'submitted');
  assert.equal(loaded.txHash, '0xtransaction');
  assert.equal(loaded.wallet, '0xwallet');
  assert.equal(typeof loaded.submittedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(loaded.submittedAt)));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), loaded);
});

test('saveSubmitted can replace a same-wallet submitted transaction', async (t) => {
  const { store } = await temporaryStateStore(t);

  await store.reservePrepared({ wallet: '0xwallet' });
  await store.markTicketRequested({ wallet: '0xwallet' });
  await store.saveSubmitted({ txHash: '0xfirst', wallet: '0xwallet' });
  await store.saveSubmitted({ txHash: '0xsecond', wallet: '0xWALLET' });

  const loaded = await store.load();
  assert.equal(loaded.status, 'submitted');
  assert.equal(loaded.txHash, '0xsecond');
  assert.equal(loaded.wallet, '0xWALLET');
  await assert.rejects(
    store.saveSubmitted({ txHash: '0xthird', wallet: '0xother' }),
    /submittable mint state missing or mismatched/,
  );
});

test('saveSubmitted failure preserves the ticket-requested state', async (t) => {
  const { path, store } = await temporaryStateStore(t);
  await store.reservePrepared({ wallet: '0xwallet' });
  await store.markTicketRequested({ wallet: '0xwallet' });
  await mkdir(`${path}.tmp`);

  await assert.rejects(
    store.saveSubmitted({ txHash: '0xtransaction', wallet: '0xwallet' }),
  );

  const loaded = await store.load();
  assert.equal(loaded.status, 'ticket-requested');
  assert.equal(loaded.wallet, '0xwallet');
  assert.equal('txHash' in loaded, false);
});

test('load fails closed with manual-inspection guidance for unreadable state', async (t) => {
  const { path, store } = await temporaryStateStore(t);
  await writeFile(path, '{invalid json', 'utf8');

  await assert.rejects(
    store.load(),
    /mint state is unreadable; manual inspection required/,
  );
});

test('clear removes persisted state and ignores a missing file', async (t) => {
  const { path, store } = await temporaryStateStore(t);

  await store.reservePrepared({ wallet: '0xwallet' });
  await store.clear();

  assert.equal(await store.load(), null);
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
  await assert.doesNotReject(store.clear());
});

test('createWalletStateStores gives each wallet an isolated lowercase state file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ascii-cats-multi-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const addresses = [
    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  ];
  const stores = await createWalletStateStores(join(dir, '.mint-state'), addresses);

  assert.equal(stores.length, 2);
  await stores[0].reservePrepared({ wallet: addresses[0] });

  // Wallet 0's reservation is isolated: wallet 1 still has no state.
  assert.equal((await stores[0].load()).status, 'prepared');
  assert.equal(await stores[1].load(), null);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(dir, '.mint-state', `${addresses[0].toLowerCase()}.json`), 'utf8'),
    ).status,
    'prepared',
  );
});
