import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;

function isValidDnsHostname(hostname) {
  if (hostname.length < 1 || hostname.length > 253) return false;
  const labels = hostname.split('.');
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export function normalizeProxyEntry(entry) {
  const host = typeof entry?.host === 'string' ? entry.host.trim() : '';
  const portText = String(entry?.port ?? '').trim();
  const port = Number(portText);

  if (
    !host ||
    /[\s/:@?#\[\]]/.test(host) ||
    !/^\d+$/.test(portText) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('proxy API record has an invalid host or port');
  }

  let hostname;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/') {
      throw new Error('invalid host');
    }
    hostname = parsed.hostname;
  } catch {
    throw new Error('proxy API record has an invalid host or port');
  }
  if (isIP(hostname) !== 4 && !isValidDnsHostname(hostname)) {
    throw new Error('proxy API record has an invalid host or port');
  }

  return `http://${hostname}:${port}`;
}

export function createProxyApiClient({
  apiUrl,
  fetchFn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let baseUrl;
  try {
    baseUrl = new URL(apiUrl);
  } catch {
    throw new Error('proxy API URL is invalid');
  }
  if (baseUrl.protocol !== 'https:') {
    throw new Error('proxy API URL must use HTTPS');
  }
  if (typeof fetchFn !== 'function') {
    throw new Error('proxy API fetch function is required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('proxy API timeout must be a positive integer');
  }

  return Object.freeze({
    async acquire(count) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('proxy API count must be a positive integer');
      }

      const requestUrl = new URL(baseUrl);
      requestUrl.searchParams.set('num', String(count));
      let response;
      try {
        response = await fetchFn(requestUrl, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch {
        throw new Error('proxy API request failed or timed out');
      }

      if (!response?.ok) {
        throw new Error(`proxy API returned HTTP ${response?.status ?? 'unknown'}`);
      }

      let records;
      try {
        records = await response.json();
      } catch {
        throw new Error('proxy API returned invalid JSON');
      }
      if (!Array.isArray(records)) {
        throw new Error('proxy API response must be a JSON array');
      }

      let proxies;
      try {
        proxies = [...new Set(records.map(normalizeProxyEntry))];
      } catch {
        throw new Error('proxy API response contains an invalid record');
      }
      if (proxies.length < count) {
        throw new Error(
          `proxy API requested ${count} proxies but received ${proxies.length} unique records`,
        );
      }
      return proxies.slice(0, count);
    },
  });
}
