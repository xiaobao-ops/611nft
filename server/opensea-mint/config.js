import {getAddress} from 'viem';

// Only the OpenSea/SeaDrop slice of osmint's configuration is reproduced here.
// Chains, RPC URLs and wallets are injected by the caller (see
// createOpenSeaMintService), so this module deliberately does not validate or
// expose any of them: reading them from env twice is how two sources of truth
// appear.
export const OPENSEA_MINT_DEFAULTS = Object.freeze({
  OPENSEA_GRAPHQL_URL: "https://gql.opensea.io/graphql",
  OPENSEA_REST_URL: "https://api.opensea.io/api/v2",
  OPENSEA_ORIGIN: "https://opensea.io",
  OPENSEA_APP_ID: "os2-web",
  OPENSEA_USER_AGENT: "osmint/0.1.0",
  OPENSEA_REQUEST_TIMEOUT_MS: "20000",
  OPENSEA_PROXY_URL: "",
  OPENSEA_CREDENTIAL_POLL_INTERVAL_MS: "500",
  OPENSEA_CREDENTIAL_POLL_TIMEOUT_MS: "12000",
  SEADROP_V1_ADDRESS: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
  OPENSEA_FEE_RECIPIENT: "0x0000a26b00c1F0DF003000390027140000fAa719",
  DEFAULT_MINT_QUANTITY: "1",
  DEFAULT_MINT_TOKEN_ID: "0",
  MAX_MINT_QUANTITY: "20",
  SCHEDULED_PREFLIGHT_LEAD_MS: "10000",
  SCHEDULED_SIGN_LEAD_MS: "1500",
  SCHEDULED_BROADCAST_LEAD_MS: "150",
  SCHEDULED_MINT_GAS_LIMIT: "250000",
  SCHEDULED_MAX_WAIT_MS: "604800000",
  PUBLIC_BROADCAST_CONCURRENCY: "100",
  PUBLIC_RECEIPT_CONCURRENCY: "100",
  MINT_RETRY_ATTEMPTS: "2",
  MINT_RETRY_DELAY_MS: "300",
  OPEN_SEA_WORKER_COUNT: "10",
  SEADROP_STATS_CONCURRENCY: "8",
  GAS_LIMIT_BUFFER_BPS: "12000",
});

// OpenSea addresses chains by slug, not by numeric id, and its slugs do not
// follow any single convention (137 is "polygon", not "matic"). Only slugs
// checked against GET /api/v2/chains are listed: a guessed slug fails as an
// opaque 404, whereas an absent one raises the error below, which names the
// setting that fixes it. Add any other chain through
// OPENSEA_CHAIN_IDENTIFIERS ("56:bsc,7777777:zora") -- no code change needed.
const CHAIN_IDENTIFIER_DEFAULTS = Object.freeze({
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  4663: "robinhood",
  8453: "base",
  42161: "arbitrum",
});

function envValue(env, name) {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? OPENSEA_MINT_DEFAULTS[name] : value;
}

function optionalEnvValue(env, name) {
  return env[name]?.trim() || "";
}

function integerValue(env, name, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  const text = envValue(env, name);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(`${name} must be an integer.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function httpUrlValue(env, name) {
  const value = envValue(env, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must use HTTP or HTTPS.`);
  return value;
}

function originValue(env, name) {
  const value = httpUrlValue(env, name);
  const url = new URL(value);
  if (url.origin !== value.replace(/\/$/, "")) throw new Error(`${name} must contain only an origin.`);
  return url.origin;
}

function addressValue(env, name) {
  try {
    return getAddress(envValue(env, name));
  } catch {
    throw new Error(`${name} must be a valid EVM address.`);
  }
}

function nonNegativeIntegerText(value, name) {
  const text = String(value ?? "");
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(`${name} must be a non-negative integer.`);
  return text;
}

export function loadAppConfig(env = process.env) {
  const graphqlUrl = httpUrlValue(env, "OPENSEA_GRAPHQL_URL");
  const restUrl = httpUrlValue(env, "OPENSEA_REST_URL").replace(/\/$/, "");
  const cookies = optionalEnvValue(env, "OPENSEA_COOKIES");
  const apiKey = optionalEnvValue(env, "OPENSEA_API_KEY");
  const proxyUrl = optionalEnvValue(env, "OPENSEA_PROXY_URL");
  if (cookies && new URL(graphqlUrl).protocol !== "https:") {
    throw new Error("OPENSEA_COOKIES requires an HTTPS OPENSEA_GRAPHQL_URL.");
  }
  if (apiKey && new URL(restUrl).protocol !== "https:") {
    throw new Error("OPENSEA_API_KEY requires an HTTPS OPENSEA_REST_URL.");
  }
  if (proxyUrl) {
    let parsedProxyUrl;
    try { parsedProxyUrl = new URL(proxyUrl); } catch { throw new Error("OPENSEA_PROXY_URL must be a valid HTTP URL."); }
    if (!["http:", "https:"].includes(parsedProxyUrl.protocol)) {
      throw new Error("OPENSEA_PROXY_URL must use HTTP or HTTPS.");
    }
  }

  const defaultMintQuantity = integerValue(env, "DEFAULT_MINT_QUANTITY", {min: 1});
  const maxMintQuantity = integerValue(env, "MAX_MINT_QUANTITY", {min: 1});
  if (defaultMintQuantity > maxMintQuantity) {
    throw new Error("DEFAULT_MINT_QUANTITY must not exceed MAX_MINT_QUANTITY.");
  }

  // The three lead times are what make scheduled sniping work: sign early
  // enough to have a serialized transaction in hand, broadcast late enough that
  // it is not rejected as premature. Their ordering is a correctness
  // requirement, not a preference, so it is validated rather than clamped.
  const scheduledPreflightLeadMs = integerValue(env, "SCHEDULED_PREFLIGHT_LEAD_MS", {min: 1000, max: 60000});
  const scheduledSignLeadMs = integerValue(env, "SCHEDULED_SIGN_LEAD_MS", {max: 60000});
  const scheduledBroadcastLeadMs = integerValue(env, "SCHEDULED_BROADCAST_LEAD_MS", {max: 60000});
  if (scheduledSignLeadMs >= scheduledPreflightLeadMs || scheduledBroadcastLeadMs >= scheduledPreflightLeadMs) {
    throw new Error("SCHEDULED_SIGN_LEAD_MS must be lower than SCHEDULED_PREFLIGHT_LEAD_MS.");
  }
  if (scheduledSignLeadMs < scheduledBroadcastLeadMs) {
    throw new Error("SCHEDULED_SIGN_LEAD_MS must be greater than or equal to SCHEDULED_BROADCAST_LEAD_MS.");
  }

  return {
    opensea: {
      graphqlUrl,
      restUrl,
      origin: originValue(env, "OPENSEA_ORIGIN"),
      appId: envValue(env, "OPENSEA_APP_ID"),
      userAgent: envValue(env, "OPENSEA_USER_AGENT"),
      requestTimeoutMs: integerValue(env, "OPENSEA_REQUEST_TIMEOUT_MS", {min: 1000}),
      cookies,
      apiKey,
      proxyUrl,
      credentialPolling: {
        intervalMs: integerValue(env, "OPENSEA_CREDENTIAL_POLL_INTERVAL_MS", {min: 100, max: 5000}),
        timeoutMs: integerValue(env, "OPENSEA_CREDENTIAL_POLL_TIMEOUT_MS", {min: 1000, max: 120000}),
      },
    },
    seaDrop: {
      address: addressValue(env, "SEADROP_V1_ADDRESS"),
      defaultFeeRecipient: addressValue(env, "OPENSEA_FEE_RECIPIENT"),
      statsConcurrency: integerValue(env, "SEADROP_STATS_CONCURRENCY", {min: 1, max: 1000}),
    },
    mint: {
      defaultQuantity: defaultMintQuantity,
      defaultTokenId: nonNegativeIntegerText(envValue(env, "DEFAULT_MINT_TOKEN_ID"), "DEFAULT_MINT_TOKEN_ID"),
      maxQuantity: maxMintQuantity,
      scheduling: {
        preflightLeadMs: scheduledPreflightLeadMs,
        signLeadMs: scheduledSignLeadMs,
        broadcastLeadMs: scheduledBroadcastLeadMs,
        workerCount: integerValue(env, "OPEN_SEA_WORKER_COUNT", {min: 1, max: 1000}),
        gasLimit: BigInt(integerValue(env, "SCHEDULED_MINT_GAS_LIMIT", {min: 21000, max: 5000000})),
        maxWaitMs: integerValue(env, "SCHEDULED_MAX_WAIT_MS", {min: 1000, max: 2147483647}),
        publicBroadcastConcurrency: integerValue(env, "PUBLIC_BROADCAST_CONCURRENCY", {min: 1, max: 1000}),
        publicReceiptConcurrency: integerValue(env, "PUBLIC_RECEIPT_CONCURRENCY", {min: 1, max: 1000}),
      },
      retry: {
        maxAttempts: integerValue(env, "MINT_RETRY_ATTEMPTS", {min: 1, max: 5}),
        delayMs: integerValue(env, "MINT_RETRY_DELAY_MS", {min: 0, max: 10000}),
      },
    },
    gasLimitBufferBps: BigInt(integerValue(env, "GAS_LIMIT_BUFFER_BPS", {min: 10000, max: 20000})),
  };
}

export function gasBufferBps(env = process.env) {
  return loadAppConfig(env).gasLimitBufferBps;
}

export function openSeaChainIdentifier(chainId, env = process.env) {
  const id = Number(chainId);
  const overrides = optionalEnvValue(env, "OPENSEA_CHAIN_IDENTIFIERS");
  for (const entry of overrides.split(",")) {
    const [key, value] = entry.split(":").map((part) => part?.trim());
    if (key && value && Number(key) === id) return value.toLowerCase();
  }
  const identifier = CHAIN_IDENTIFIER_DEFAULTS[id];
  if (!identifier) {
    throw new Error(`No OpenSea chain identifier is known for chain ${id}. Set OPENSEA_CHAIN_IDENTIFIERS="${id}:<slug>".`);
  }
  return identifier;
}
