import {OpenSeaAuthClient} from './auth-client.js';
import {getOpenSeaApiAccess} from './drops.js';
import {fetchOpenSea} from './fetch.js';

const READ_ELIGIBILITY_SCOPE = 'read:eligibility';
const authSessions = new Map();
const authFailures = new Map();
const AUTH_FAILURE_CACHE_MS = 5 * 60 * 1000;

function cacheKey(opensea, address) {
  return `${new URL(opensea.restUrl).origin}|${address.toLowerCase()}`;
}

function authSigner(account) {
  return {
    async getAddress() { return account.address; },
    async signMessage(message) { return account.signMessage({message}); },
  };
}

function safeAuthError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/exceed account entitlement/i.test(message)) return {
    status: 'entitlement_denied',
    reason: 'OpenSea 当前未向该钱包开放 read:eligibility 权限；开售后仍会自动查询 Mint 计划，也可使用手动凭证兜底。',
  };
  if (/is banned/i.test(message)) return {
    status: 'auth_failed',
    reason: 'OpenSea 拒绝了该钱包的登录会话。',
  };
  if (/nonce request/i.test(message)) return {status: 'auth_failed', reason: '无法从 OpenSea 获取钱包登录 nonce。'};
  if (/siwe verification/i.test(message)) return {status: 'auth_failed', reason: 'OpenSea 未通过该钱包的 SIWE 签名验证。'};
  if (/scoped token creation/i.test(message)) return {status: 'auth_failed', reason: 'OpenSea 无法创建只读资格授权。'};
  if (/token exchange/i.test(message)) return {status: 'auth_failed', reason: 'OpenSea 无法生成钱包资格查询令牌。'};
  if (/timed out|timeout/i.test(message)) return {status: 'auth_failed', reason: 'OpenSea 钱包授权超时。'};
  if (/proxy|network|fetch failed|enotfound|econn/i.test(message)) return {status: 'auth_failed', reason: 'OpenSea 钱包授权服务暂时不可达。'};
  return {status: 'auth_failed', reason: 'OpenSea 钱包授权失败。'};
}

function eligibilityError(status) {
  if (status === 401) return 'OpenSea wallet authorization expired.';
  if (status === 403) return 'OpenSea did not grant read:eligibility access.';
  if (status === 404) return 'OpenSea eligibility data is unavailable for this drop.';
  if (status === 429) return 'OpenSea eligibility lookup is rate limited.';
  return `OpenSea eligibility lookup failed with HTTP ${status}.`;
}

function normalizeEligibility(stage) {
  return {
    stageUuid: String(stage?.stage_uuid || ''),
    isEligible: Boolean(stage?.is_eligible),
    price: stage?.price === undefined || stage?.price === null ? null : String(stage.price),
    maxTotalMintableByWallet: stage?.max_total_mintable_by_wallet === undefined
      || stage?.max_total_mintable_by_wallet === null
      ? null
      : String(stage.max_total_mintable_by_wallet),
    maxTotalMintableByWalletPerToken: stage?.max_total_mintable_by_wallet_per_token === undefined
      || stage?.max_total_mintable_by_wallet_per_token === null
      ? null
      : String(stage.max_total_mintable_by_wallet_per_token),
  };
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({length: Math.min(Math.max(1, limit), items.length)}, run));
  return results;
}

async function createSession({opensea, account, authFactory, fetchImpl}) {
  const auth = authFactory({
    apiBaseUrl: new URL(opensea.restUrl).origin,
    fetchImpl,
    requestTimeoutMs: opensea.requestTimeoutMs,
  });
  const token = await auth.authenticate(authSigner(account), {scopes: [READ_ELIGIBILITY_SCOPE]});
  return {address: account.address, auth, token};
}

async function getSession({opensea, account, authFactory, fetchImpl, force = false}) {
  const key = cacheKey(opensea, account.address);
  if (force) {
    try { await revokeSession(key); } catch {
      authSessions.delete(key);
    }
  }
  let pending = authSessions.get(key);
  if (!pending) {
    pending = createSession({opensea, account, authFactory, fetchImpl});
    authSessions.set(key, pending);
  }
  try {
    const session = await pending;
    session.token = await session.auth.getValidToken();
    return {key, session};
  } catch (error) {
    if (authSessions.get(key) === pending) authSessions.delete(key);
    throw error;
  }
}

async function revokeSession(key) {
  const pending = authSessions.get(key);
  if (!pending) return false;
  authSessions.delete(key);
  const session = await pending;
  let token = session.token;
  try { token = await session.auth.getValidToken(); } catch { /* Revoke with the last managed access token. */ }
  await session.auth.revoke(token.accessToken);
  authFailures.delete(key);
  return true;
}

async function requestEligibility({opensea, access, catalog, token, fetchImpl}) {
  const response = await fetchOpenSea(opensea, `${opensea.restUrl}/drops/${encodeURIComponent(catalog.slug)}/eligibility`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token.accessToken}`,
      'user-agent': opensea.userAgent,
      'x-api-key': access.apiKey,
    },
    signal: AbortSignal.timeout(opensea.requestTimeoutMs),
  }, fetchImpl);
  if (!response.ok) return {response, stages: null};
  const body = await response.json();
  return {
    response,
    stages: Array.isArray(body?.stages)
      ? body.stages.map(normalizeEligibility).filter((stage) => stage.stageUuid)
      : [],
  };
}

export async function fetchOpenSeaWalletEligibilities({
  opensea,
  catalog,
  accounts,
  concurrency = 2,
  fetchImpl = fetch,
  authFactory = (config) => new OpenSeaAuthClient(config),
}) {
  if (!accounts.length || !catalog?.stages?.some((stage) => stage.category === 'allowlist')) return [];
  const access = await getOpenSeaApiAccess({opensea, fetchImpl});
  return mapLimited(accounts, concurrency, async (account) => {
    const key = cacheKey(opensea, account.address);
    const cachedFailure = authFailures.get(key);
    if (cachedFailure?.expiresAt > Date.now()) {
      return {address: account.address, status: cachedFailure.status, reason: cachedFailure.reason, stages: []};
    }
    authFailures.delete(key);
    try {
      let authorized = await getSession({opensea, account, authFactory, fetchImpl});
      let result = await requestEligibility({
        opensea,
        access,
        catalog,
        token: authorized.session.token,
        fetchImpl,
      });
      if (result.response.status === 401) {
        authorized = await getSession({opensea, account, authFactory, fetchImpl, force: true});
        result = await requestEligibility({
          opensea,
          access,
          catalog,
          token: authorized.session.token,
          fetchImpl,
        });
      }
      if (!result.response.ok) {
        return {
          address: account.address,
          status: [401, 403].includes(result.response.status) ? 'auth_failed' : 'unknown',
          reason: eligibilityError(result.response.status),
          stages: [],
        };
      }
      return {
        address: account.address,
        status: 'ready',
        auth: 'siwe',
        authorizationExpiresAt: authorized.session.token.expiresAt.toISOString(),
        stages: result.stages,
      };
    } catch (error) {
      const failure = safeAuthError(error);
      authFailures.set(key, {...failure, expiresAt: Date.now() + AUTH_FAILURE_CACHE_MS});
      return {
        address: account.address,
        ...failure,
        stages: [],
      };
    }
  });
}

export async function revokeOpenSeaWalletAuth(addresses = null) {
  const normalized = addresses === null
    ? null
    : new Set(addresses.map((address) => String(address).toLowerCase()));
  const keys = [...authSessions.keys()].filter((key) => {
    const address = key.slice(key.lastIndexOf('|') + 1);
    return normalized === null || normalized.has(address);
  });
  const results = await Promise.allSettled(keys.map(revokeSession));
  if (normalized === null) authFailures.clear();
  else {
    for (const key of [...authFailures.keys()]) {
      const address = key.slice(key.lastIndexOf('|') + 1);
      if (normalized.has(address)) authFailures.delete(key);
    }
  }
  return {
    requestedCount: keys.length,
    revokedCount: results.filter((result) => result.status === 'fulfilled' && result.value).length,
    failedCount: results.filter((result) => result.status === 'rejected').length,
  };
}

export function clearOpenSeaWalletAuthCache() {
  authSessions.clear();
  authFailures.clear();
}
