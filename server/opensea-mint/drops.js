import {getAddress} from 'viem';
import {
  decodeMintAllowList,
  decodeMintPublic,
  decodeMintSigned,
  SEADROP_MINT_ALLOWLIST_SELECTOR,
  SEADROP_MINT_PUBLIC_SELECTOR,
  SEADROP_MINT_SIGNED_SELECTOR,
  ZERO_ADDRESS,
} from './seadrop.js';
import {fetchOpenSea} from './fetch.js';

function errorMessage(body, fallback) {
  const candidates = [body?.error, body?.detail, body?.message, body?.errors?.[0]?.message];
  return candidates.find((value) => typeof value === 'string' && value.trim()) || fallback;
}

function retryAfterMs(response) {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value * 1000) : null;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return {message: text.slice(0, 300)}; }
}

export async function getOpenSeaApiAccess({opensea}) {
  if (!opensea?.apiKey) {
    throw new Error('OPENSEA_API_KEY is required. Add your own key to the local seed .env before deployment.');
  }
  return {apiKey: opensea.apiKey, source: 'configured', expiresAt: null};
}

function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function openSeaJson({opensea, access, path, method = 'GET', body = null, signal = null, fetchImpl = fetch}) {
  const headers = {
    accept: 'application/json',
    'user-agent': opensea.userAgent,
    'x-api-key': access.apiKey,
  };
  if (body !== null) headers['content-type'] = 'application/json';
  const response = await fetchOpenSea(opensea, `${opensea.restUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: requestSignal(opensea.requestTimeoutMs, signal),
  }, fetchImpl);
  return {response, body: await responseBody(response)};
}

function stageTimestamp(value, name) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) throw new Error(`OpenSea drop stage has an invalid ${name}.`);
  return Math.floor(milliseconds / 1000);
}

function decimalString(value, name, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`OpenSea drop stage has an invalid ${name}.`);
  return text;
}

function booleanValue(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || String(value).toLowerCase() === 'false') return false;
  throw new Error('OpenSea drop stage has an invalid boolean field.');
}

// OpenSea's stage_type carries the distinction a minter actually cares about —
// whether this is the OG stage, the waitlist, or the guaranteed round — but the
// two-value `category` below cannot express it, and every consumer reads
// category. Keeping the raw string was not enough: nothing downstream looked at
// it, so an OG stage and a waitlist stage were indistinguishable once they left
// this function, and a wallet holding a WL spot could be armed against the OG
// round it had no claim to.
//
// `kind` is the finer classification; `category` keeps its original two values
// so existing callers, the scheduling path among them, behave exactly as before.
const STAGE_KINDS = Object.freeze({
  public_sale: 'public',
  public: 'public',
  og: 'og',
  allowlist: 'wl',
  presale: 'presale',
  waitlist: 'waitlist',
  guaranteed: 'guaranteed',
  fcfs: 'fcfs',
});

export function classifyStageKind(stageType) {
  const text = String(stageType || '').toLowerCase();
  if (STAGE_KINDS[text]) return STAGE_KINDS[text];
  // Unknown types still have to land somewhere. Anything naming itself public is
  // public; everything else is treated as a gated stage, which is the safe
  // direction — a gated stage that turns out to be open costs a retry, while an
  // open stage that was really gated burns the mint.
  if (text.includes('public')) return 'public';
  for (const [key, kind] of Object.entries(STAGE_KINDS)) {
    if (key !== 'public' && key !== 'public_sale' && text.includes(key)) return kind;
  }
  return 'wl';
}

function normalizeStage(stage) {
  const stageType = String(stage?.stage_type || '').toLowerCase();
  const kind = classifyStageKind(stageType);
  const category = kind === 'public' ? 'public' : 'allowlist';
  return {
    uuid: String(stage?.uuid || ''),
    label: String(stage?.label || (category === 'public' ? 'Public' : 'Allowlist')),
    stageType,
    kind,
    category,
    mintPrice: decimalString(stage?.price, 'price', '0'),
    currencyAddress: String(stage?.price_currency_address || ZERO_ADDRESS),
    startTime: stageTimestamp(stage?.start_time, 'start_time'),
    endTime: stageTimestamp(stage?.end_time, 'end_time'),
    maxPerWallet: decimalString(stage?.max_per_wallet, 'max_per_wallet', '0'),
    stageSupply: decimalString(
      stage?.max_token_supply_for_stage ?? stage?.stage_supply ?? stage?.max_supply,
      'max_token_supply_for_stage',
      '0',
    ),
    feeBps: decimalString(stage?.fee_bps ?? stage?.fees?.bps, 'fee_bps', '0'),
    feeRecipient: String(stage?.fee_recipient ?? stage?.fees?.recipient ?? ZERO_ADDRESS),
    restrictFeeRecipients: booleanValue(
      stage?.restrict_fee_recipients ?? stage?.fees?.restrict_recipients,
      false,
    ),
  };
}

export async function fetchOpenSeaDropCatalog({
  opensea,
  chainIdentifier,
  contractAddress,
  slug = null,
  signal = null,
  fetchImpl = fetch,
}) {
  const access = await getOpenSeaApiAccess({opensea, fetchImpl});
  let resolvedSlug = slug ? String(slug).trim().toLowerCase() : null;
  if (!resolvedSlug) {
    const contractPath = `/chain/${encodeURIComponent(chainIdentifier)}/contract/${encodeURIComponent(contractAddress)}`;
    const result = await openSeaJson({opensea, access, path: contractPath, signal, fetchImpl});
    if (!result.response.ok) {
      throw new Error(errorMessage(result.body, `OpenSea contract lookup failed with HTTP ${result.response.status}.`));
    }
    resolvedSlug = String(result.body?.collection || '').trim().toLowerCase();
    if (!resolvedSlug) throw new Error('OpenSea contract metadata did not include a collection slug.');
  }
  const result = await openSeaJson({
    opensea,
    access,
    path: `/drops/${encodeURIComponent(resolvedSlug)}`,
    signal,
    fetchImpl,
  });
  if (!result.response.ok) {
    throw new Error(errorMessage(result.body, `OpenSea drop lookup failed with HTTP ${result.response.status}.`));
  }
  const body = result.body || {};
  const returnedContract = getAddress(String(body.contract_address || contractAddress));
  if (returnedContract.toLowerCase() !== getAddress(contractAddress).toLowerCase()) {
    throw new Error(`OpenSea drop contract ${returnedContract} does not match ${contractAddress}.`);
  }
  if (body.chain && String(body.chain).toLowerCase() !== String(chainIdentifier).toLowerCase()) {
    throw new Error(`OpenSea drop is on ${body.chain}, expected ${chainIdentifier}.`);
  }
  const stages = Array.isArray(body.stages)
    ? body.stages.map(normalizeStage).sort((left, right) => (
      left.startTime - right.startTime
      || left.endTime - right.endTime
      || left.label.localeCompare(right.label)
    ))
    : [];
  return {
    slug: String(body.collection_slug || resolvedSlug),
    name: body.collection_name ? String(body.collection_name) : null,
    chainIdentifier: String(body.chain || chainIdentifier),
    contractAddress: returnedContract,
    dropType: body.drop_type ? String(body.drop_type) : null,
    isMinting: Boolean(body.is_minting),
    imageUrl: body.image_url ? String(body.image_url) : null,
    openSeaUrl: body.opensea_url ? String(body.opensea_url) : null,
    activeStageUuid: body.active_stage?.uuid ? String(body.active_stage.uuid) : null,
    nextStageUuid: body.next_stage?.uuid ? String(body.next_stage.uuid) : null,
    totalSupply: decimalString(body.total_supply, 'total_supply'),
    maxSupply: decimalString(body.max_supply, 'max_supply'),
    stages,
    accessSource: access.source,
    accessExpiresAt: access.expiresAt,
    source: 'opensea-drops-api',
  };
}

function decodeSeaDropRoute({body, account, contractAddress, quantity, seaDropAddress}) {
  const to = getAddress(String(body?.to || ''));
  const data = String(body?.data || '');
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 10) throw new Error('OpenSea returned invalid mint calldata.');
  if (to.toLowerCase() !== seaDropAddress.toLowerCase()) throw new Error(`OpenSea returned an unexpected mint target: ${to}.`);
  const selector = data.slice(0, 10).toLowerCase();
  const mode = selector === SEADROP_MINT_PUBLIC_SELECTOR ? 'public'
    : selector === SEADROP_MINT_ALLOWLIST_SELECTOR ? 'allowlist'
      : selector === SEADROP_MINT_SIGNED_SELECTOR ? 'signed' : null;
  const decoded = selector === SEADROP_MINT_PUBLIC_SELECTOR
    ? decodeMintPublic(data)
    : selector === SEADROP_MINT_ALLOWLIST_SELECTOR
      ? decodeMintAllowList(data)
      : selector === SEADROP_MINT_SIGNED_SELECTOR
        ? decodeMintSigned(data)
        : null;
  if (!decoded) throw new Error(`OpenSea returned an unsupported SeaDrop selector: ${selector}.`);
  if (decoded.nftContract.toLowerCase() !== contractAddress.toLowerCase()) throw new Error('OpenSea mint calldata targets a different NFT contract.');
  if (decoded.quantity !== BigInt(quantity)) throw new Error('OpenSea mint calldata has a different quantity.');
  if (decoded.minterIfNotPayer !== ZERO_ADDRESS) throw new Error('Delegated SeaDrop payers are not supported.');
  let value;
  try { value = BigInt(body.value ?? '0'); } catch { throw new Error('OpenSea returned an invalid mint value.'); }
  const expectedValue = mode === 'public'
    ? value
    : decoded.mintParams.mintPrice * decoded.quantity;
  if (mode !== 'public' && value !== expectedValue) throw new Error('OpenSea mint value does not match the whitelist price.');
  const credential = mode === 'public' ? null : {
    address: account.address,
    feeRecipient: decoded.feeRecipient,
    minterIfNotPayer: decoded.minterIfNotPayer,
    mintParams: decoded.mintParams,
    ...(mode === 'allowlist'
      ? {proof: decoded.proof}
      : {salt: decoded.salt, signature: decoded.signature}),
  };
  return {mode, credential, transaction: {to, data, value}};
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

export async function fetchOpenSeaWalletMintRoutes({
  opensea,
  catalog,
  accounts,
  quantity,
  seaDropAddress,
  concurrency = 2,
  signal = null,
  fetchImpl = fetch,
}) {
  if (!accounts.length || !catalog?.activeStageUuid) return [];
  const activeStage = catalog.stages.find((stage) => stage.uuid === catalog.activeStageUuid);
  if (!activeStage || activeStage.category === 'public') return [];
  const access = await getOpenSeaApiAccess({opensea, fetchImpl});
  return mapLimited(accounts, concurrency, async (account) => {
    try {
      const result = await openSeaJson({
        opensea,
        access,
        path: `/drops/${encodeURIComponent(catalog.slug)}/mint`,
        method: 'POST',
        body: {minter: account.address, quantity: Number(quantity)},
        signal,
        fetchImpl,
      });
      if (result.response.ok) {
        return {
          address: account.address,
          stageUuid: catalog.activeStageUuid,
          status: 'ready',
          ...decodeSeaDropRoute({
            body: result.body,
            account,
            contractAddress: catalog.contractAddress,
            quantity,
            seaDropAddress,
          }),
        };
      }
      const message = errorMessage(result.body, `OpenSea Mint API returned HTTP ${result.response.status}.`);
      const status = result.response.status === 422 ? 'ineligible'
        : result.response.status === 409 ? 'not_active'
          : result.response.status === 429 ? 'rate_limited' : 'unknown';
      return {
        address: account.address,
        stageUuid: catalog.activeStageUuid,
        status,
        reason: message,
        retryAfterMs: status === 'rate_limited' ? retryAfterMs(result.response) : null,
      };
    } catch (error) {
      return {
        address: account.address,
        stageUuid: catalog.activeStageUuid,
        status: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
