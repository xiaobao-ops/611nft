import assert from 'node:assert/strict';
import test from 'node:test';

import { assertGasWithinLimits, sanitizeRuntimeError } from '../src/safety.js';

const config = Object.freeze({
  maxGasLimit: 500000n,
  maxFeePerGasGwei: 5,
});

test('sanitizes nested runtime error fields and known URL secrets', () => {
  const proxyApiUrl =
    'https://api-user:api-pass@proxy-api.example.test/private/path?apikey=api-secret';
  const rpcUrl = 'https://rpc.example.test/v1/rpc-secret?token=query-secret';
  const error = new Error('wallet mint failed', {
    cause: new Error(`proxy API failed at ${proxyApiUrl}`),
  });
  error.source = new Error('source exposed private and rpc-secret');
  error.errors = [new Error('nested exposed api-secret and query-secret')];

  const output = sanitizeRuntimeError(error, {
    proxyApiUrl,
    rpcUrl,
  });

  assert.match(output, /wallet mint failed/);
  assert.match(output, /proxy-api\.example\.test/);
  for (const secret of [
    proxyApiUrl,
    'api-user',
    'api-pass',
    'private',
    'path',
    'apikey',
    'api-secret',
    'rpc-secret',
    'token',
    'query-secret',
  ]) {
    assert.equal(output.includes(secret), false, `leaked ${secret}`);
  }
});

test('rejects a gas estimate above the configured limit', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 500001n,
        feeData: { maxFeePerGas: 5_000_000_000n, gasPrice: null },
        config,
      }),
    /gas estimate exceeds configured limit/,
  );
});

test('rejects maxFeePerGas above the configured gwei cap', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 500000n,
        feeData: { maxFeePerGas: 5_000_000_001n, gasPrice: null },
        config,
      }),
    /fee per gas exceeds configured limit/,
  );
});

test('rejects legacy gasPrice above the configured gwei cap', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 500000n,
        feeData: { maxFeePerGas: null, gasPrice: 5_000_000_001n },
        config,
      }),
    /fee per gas exceeds configured limit/,
  );
});

test('uses the larger available fee value when both are present', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 500000n,
        feeData: {
          maxFeePerGas: 4_000_000_000n,
          gasPrice: 5_000_000_001n,
        },
        config,
      }),
    /fee per gas exceeds configured limit/,
  );
});

test('rejects unavailable fee data', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 500000n,
        feeData: { maxFeePerGas: null, gasPrice: null },
        config,
      }),
    /fee data unavailable/,
  );
});

test('accepts gas and fee values at or below their limits', () => {
  assert.doesNotThrow(() =>
    assertGasWithinLimits({
      gasEstimate: 500000n,
      feeData: {
        maxFeePerGas: 5_000_000_000n,
        gasPrice: 4_000_000_000n,
      },
      config,
    }),
  );

  assert.doesNotThrow(() =>
    assertGasWithinLimits({
      gasEstimate: 499999n,
      feeData: { maxFeePerGas: null, gasPrice: 4_999_999_999n },
      config,
    }),
  );
});

test('uses the configured EIP-1559 cap as maxFee headroom without raising priority fee', () => {
  const overrides = assertGasWithinLimits({
    gasEstimate: 250000n,
    feeData: {
      maxFeePerGas: 4_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasPrice: 3_000_000_000n,
    },
    config,
  });

  assert.deepEqual(overrides, {
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  assert.equal(Object.isFrozen(overrides), true);
});

test('returns immutable legacy fee overrides when EIP-1559 data is unavailable', () => {
  const overrides = assertGasWithinLimits({
    gasEstimate: 250000n,
    feeData: {
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      gasPrice: 3_000_000_000n,
    },
    config,
  });

  assert.deepEqual(overrides, { gasPrice: 3_000_000_000n });
  assert.equal(Object.isFrozen(overrides), true);
});

test('rejects EIP-1559 fee data that cannot be made explicit', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 250000n,
        feeData: {
          maxFeePerGas: 4_000_000_000n,
          maxPriorityFeePerGas: null,
          gasPrice: null,
        },
        config,
      }),
    /explicit fee data unavailable/,
  );
});

test('rejects an EIP-1559 priority fee above its max fee', () => {
  assert.throws(
    () =>
      assertGasWithinLimits({
        gasEstimate: 250000n,
        feeData: {
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 3_000_000_000n,
          gasPrice: null,
        },
        config,
      }),
    /priority fee exceeds max fee/,
  );
});
