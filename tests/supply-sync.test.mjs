import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveMintSupplyUpdate} from '../apps/web/supply-sync.js';

test('authoritative supply replaces the detail snapshot instead of adding the activity delta', () => {
  const result = resolveMintSupplyUpdate(
    {current_supply: 1333, max_supply: 1333},
    {current_supply: 1333, max_supply: 1333, activity_count: 104},
  );

  assert.deepEqual(result, {
    currentSupply: 1333,
    maxSupply: 1333,
    authoritative: true,
  });
});

test('a live event without an absolute supply keeps the snapshot and requests a resync', () => {
  const result = resolveMintSupplyUpdate(
    {current_supply: 1333, max_supply: 1333},
    {activity_count: 104},
  );

  assert.deepEqual(result, {
    currentSupply: 1333,
    maxSupply: 1333,
    authoritative: false,
  });
});

test('an out-of-order absolute event cannot roll a newer detail snapshot backwards', () => {
  const result = resolveMintSupplyUpdate(
    {current_supply: 1333, max_supply: 1333},
    {current_supply: 1198, max_supply: 1500, activity_count: 134},
  );

  assert.deepEqual(result, {
    currentSupply: 1333,
    maxSupply: 1333,
    authoritative: true,
  });
});
