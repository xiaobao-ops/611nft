import { DEFAULT_RPC_URL, DEFAULT_TICKET_URL } from './constants.js';

const MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

function requiredPrivateKey(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex value prefixed with 0x');
  }
  return value;
}

function validateMnemonic(value) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!MNEMONIC_WORD_COUNTS.has(words.length)) {
    throw new Error('MNEMONIC must be a valid 12/15/18/21/24-word phrase');
  }
  return words.join(' ');
}

function positiveInteger(value, defaultValue, name) {
  if (value === undefined || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, defaultValue, name) {
  if (value === undefined || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function positiveBigInt(value, defaultValue, name) {
  if (value === undefined || value === '') return defaultValue;

  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error('not positive');
    return parsed;
  } catch {
    throw new Error(`${name} must be a positive integer`);
  }
}

function positiveDecimal(value, defaultValue, name) {
  if (value === undefined || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive decimal`);
  }
  return parsed;
}

function booleanFlag(value) {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function optionalDiscordChannelTarget(value) {
  if (value === undefined || value === '') return undefined;
  const target = String(value).trim();
  if (!/^channel:\d+$/.test(target)) {
    throw new Error('OPENCLAW_DISCORD_TARGET must use the form channel:<numeric-id>');
  }
  return target;
}

function sharedLimits(env) {
  return {
    rpcUrl: env.RPC_URL || DEFAULT_RPC_URL,
    ticketUrl: env.TICKET_URL || DEFAULT_TICKET_URL,
    ticketTimeoutMs: positiveInteger(
      env.TICKET_TIMEOUT_MS,
      10_000,
      'TICKET_TIMEOUT_MS',
    ),
    pollIntervalMs: positiveInteger(env.POLL_INTERVAL_MS, 500, 'POLL_INTERVAL_MS'),
    maxGasLimit: positiveBigInt(env.MAX_GAS_LIMIT, 500000n, 'MAX_GAS_LIMIT'),
    maxFeePerGasGwei: positiveDecimal(
      env.MAX_FEE_PER_GAS_GWEI,
      5,
      'MAX_FEE_PER_GAS_GWEI',
    ),
    confirmations: positiveInteger(env.CONFIRMATIONS, 1, 'CONFIRMATIONS'),
    failedReceiptRetries: nonNegativeInteger(
      env.MINT_FAILED_RECEIPT_RETRIES,
      0,
      'MINT_FAILED_RECEIPT_RETRIES',
    ),
    openClawDiscordTarget: optionalDiscordChannelTarget(env.OPENCLAW_DISCORD_TARGET),
    openClawTimeoutMs: positiveInteger(
      env.OPENCLAW_TIMEOUT_MS,
      10_000,
      'OPENCLAW_TIMEOUT_MS',
    ),
    arm: booleanFlag(env.ARM),
  };
}

export function loadConfig(env) {
  const hasMnemonic = Boolean(env.MNEMONIC);
  const hasPrivateKeysFile = Boolean(env.PRIVATE_KEYS_FILE);
  if (hasMnemonic && hasPrivateKeysFile) {
    throw new Error('MNEMONIC and PRIVATE_KEYS_FILE are mutually exclusive');
  }

  // Multi-wallet mode takes precedence when a mnemonic or key file is present.
  if (hasMnemonic || hasPrivateKeysFile) {
    const mnemonic = hasMnemonic ? validateMnemonic(env.MNEMONIC) : undefined;
    const privateKeysFile = hasPrivateKeysFile ? env.PRIVATE_KEYS_FILE : undefined;
    const walletCount = positiveInteger(env.WALLET_COUNT, 50, 'WALLET_COUNT');
    const staticProxyCount = nonNegativeInteger(
      env.STATIC_PROXY_COUNT,
      20,
      'STATIC_PROXY_COUNT',
    );
    const dynamicProxyCount = nonNegativeInteger(
      env.DYNAMIC_PROXY_COUNT,
      30,
      'DYNAMIC_PROXY_COUNT',
    );
    if (staticProxyCount + dynamicProxyCount !== walletCount) {
      throw new Error(
        'STATIC_PROXY_COUNT + DYNAMIC_PROXY_COUNT must equal WALLET_COUNT',
      );
    }

    const proxyApiUrl = env.PROXY_API_URL || undefined;
    if (dynamicProxyCount > 0) {
      let parsedProxyApiUrl;
      try {
        parsedProxyApiUrl = new URL(proxyApiUrl);
      } catch {
        throw new Error(
          'PROXY_API_URL must be an HTTPS URL when DYNAMIC_PROXY_COUNT is greater than 0',
        );
      }
      if (parsedProxyApiUrl.protocol !== 'https:') {
        throw new Error(
          'PROXY_API_URL must be an HTTPS URL when DYNAMIC_PROXY_COUNT is greater than 0',
        );
      }
    }

    const mintConcurrency = positiveInteger(
      env.MINT_CONCURRENCY,
      10,
      'MINT_CONCURRENCY',
    );
    const readConcurrency = positiveInteger(
      env.READ_CONCURRENCY,
      Math.min(mintConcurrency, 50),
      'READ_CONCURRENCY',
    );

    return Object.freeze({
      mode: 'multi',
      walletSource: hasPrivateKeysFile ? 'private-keys-file' : 'mnemonic',
      mnemonic,
      privateKeysFile,
      walletCount,
      derivationPathBase: env.DERIVATION_PATH_BASE || "m/44'/60'/0'/0",
      proxyFile: env.PROXY_FILE || 'proxies.txt',
      proxyReserveFile: env.PROXY_RESERVE_FILE || undefined,
      proxyPreheat: booleanFlag(env.PROXY_PREHEAT),
      proxyPreheatRecheckMs: nonNegativeInteger(
        env.PROXY_PREHEAT_RECHECK_MS,
        0,
        'PROXY_PREHEAT_RECHECK_MS',
      ),
      mintConcurrency,
      readConcurrency,
      allowProxyReuse: booleanFlag(env.ALLOW_PROXY_REUSE),
      proxyApiUrl,
      staticProxyCount,
      dynamicProxyCount,
      proxyApiTimeoutMs: positiveInteger(
        env.PROXY_API_TIMEOUT_MS,
        10_000,
        'PROXY_API_TIMEOUT_MS',
      ),
      proxyCheckTimeoutMs: positiveInteger(
        env.PROXY_CHECK_TIMEOUT_MS,
        10_000,
        'PROXY_CHECK_TIMEOUT_MS',
      ),
      proxyMaxReplacements: nonNegativeInteger(
        env.PROXY_MAX_REPLACEMENTS,
        20,
        'PROXY_MAX_REPLACEMENTS',
      ),
      proxyPoolDeadlineMs: positiveInteger(
        env.PROXY_POOL_DEADLINE_MS,
        60_000,
        'PROXY_POOL_DEADLINE_MS',
      ),
      ...sharedLimits(env),
    });
  }

  if (env.PRIVATE_KEY) {
    return Object.freeze({
      mode: 'single',
      privateKey: requiredPrivateKey(env.PRIVATE_KEY),
      ...sharedLimits(env),
    });
  }

  throw new Error('PRIVATE_KEY, MNEMONIC, or PRIVATE_KEYS_FILE is required');
}
