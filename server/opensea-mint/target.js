import {getAddress} from 'viem';
import {fetchOpenSea} from './fetch.js';

const OPENSEA_HOSTS = new Set(['opensea.io', 'www.opensea.io']);

function isContractAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizeChainIdentifier(value) {
  const key = String(value || '').trim().toLowerCase();
  if (['eth', 'mainnet'].includes(key)) return 'ethereum';
  return key || null;
}

export function parseNftTarget(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('NFT target is required.');
  if (isContractAddress(raw)) {
    return {kind: 'address', value: getAddress(raw), chainIdentifier: null, tokenId: null};
  }

  if (!/^https?:\/\//i.test(raw) && !raw.toLowerCase().includes('opensea.io')) {
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
      throw new Error('NFT target must be an OpenSea URL, collection slug, or contract address.');
    }
    return {kind: 'slug', value: raw.toLowerCase(), chainIdentifier: null, tokenId: null};
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error('OpenSea URL is invalid.');
  }
  if (!OPENSEA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Only opensea.io URLs are accepted.');
  }

  const segments = url.pathname.split('/').map((part) => part.trim()).filter(Boolean);
  const itemIndex = segments.findIndex((part) => ['item', 'assets'].includes(part.toLowerCase()));
  if (itemIndex >= 0) {
    const rest = segments.slice(itemIndex + 1);
    const addressIndex = rest.findIndex(isContractAddress);
    if (addressIndex >= 0) {
      return {
        kind: 'address',
        value: getAddress(rest[addressIndex]),
        chainIdentifier: addressIndex > 0 ? normalizeChainIdentifier(rest[addressIndex - 1]) : null,
        tokenId: rest[addressIndex + 1] || null,
      };
    }
  }

  const collectionIndex = segments.findIndex((part) => part.toLowerCase() === 'collection');
  if (collectionIndex >= 0 && segments[collectionIndex + 1]) {
    return {
      kind: 'slug',
      value: segments[collectionIndex + 1].toLowerCase(),
      chainIdentifier: collectionIndex > 0 ? normalizeChainIdentifier(segments[collectionIndex - 1]) : null,
      tokenId: null,
    };
  }

  const looseAddress = segments.find(isContractAddress);
  if (looseAddress) {
    return {kind: 'address', value: getAddress(looseAddress), chainIdentifier: null, tokenId: null};
  }
  throw new Error('No collection slug or contract address was found in the OpenSea URL.');
}

export async function resolveCollectionSlug({slug, preferredChainIdentifier, supportedChainIdentifiers = [], opensea, fetchImpl = fetch}) {
  const headers = {accept: 'application/json', 'user-agent': opensea.userAgent};
  if (opensea.apiKey) headers['x-api-key'] = opensea.apiKey;
  const response = await fetchOpenSea(opensea, `${opensea.restUrl}/collections/${encodeURIComponent(slug)}`, {
    headers,
    signal: AbortSignal.timeout(opensea.requestTimeoutMs),
  }, fetchImpl);
  if (response.status === 401 || response.status === 403) {
    throw new Error(opensea.apiKey
      ? 'OpenSea rejected OPENSEA_API_KEY.'
      : 'OpenSea refused the collection lookup; configure OPENSEA_API_KEY or use the contract address.');
  }
  if (response.status === 404) throw new Error(`OpenSea collection "${slug}" was not found.`);
  if (response.status === 429) throw new Error('OpenSea rate-limited the collection lookup.');
  if (!response.ok) throw new Error(`OpenSea collection lookup failed with HTTP ${response.status}.`);

  const body = await response.json();
  const contracts = Array.isArray(body?.contracts) ? body.contracts : [];
  if (!contracts.length) throw new Error(`OpenSea collection "${slug}" has no contract.`);
  const preferred = normalizeChainIdentifier(preferredChainIdentifier);
  const supported = new Set(supportedChainIdentifiers.map(normalizeChainIdentifier).filter(Boolean));
  const picked = contracts.find((item) => normalizeChainIdentifier(item?.chain) === preferred)
    || contracts.find((item) => supported.has(normalizeChainIdentifier(item?.chain)))
    || contracts[0];
  if (!isContractAddress(String(picked?.address || ''))) {
    throw new Error('OpenSea returned an invalid collection contract address.');
  }
  return {
    contractAddress: getAddress(picked.address),
    chainIdentifier: normalizeChainIdentifier(picked.chain),
    name: String(body?.name || slug),
    slug,
  };
}

export async function resolveNftTarget({input, preferredChainIdentifier, supportedChainIdentifiers = [], opensea, fetchImpl = fetch}) {
  const parsed = parseNftTarget(input);
  if (parsed.kind === 'address') {
    return {
      contractAddress: parsed.value,
      chainIdentifier: parsed.chainIdentifier,
      tokenId: parsed.tokenId,
      name: null,
      slug: null,
      source: parsed.tokenId ? 'opensea_item' : 'contract',
    };
  }
  const collection = await resolveCollectionSlug({
    slug: parsed.value,
    preferredChainIdentifier: parsed.chainIdentifier || preferredChainIdentifier,
    supportedChainIdentifiers,
    opensea,
    fetchImpl,
  });
  return {...collection, tokenId: null, source: 'opensea_collection'};
}
