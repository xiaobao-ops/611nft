import { readFile } from 'node:fs/promises';

import { Agent, ProxyAgent, buildConnector } from 'undici';
import { SocksClient } from 'socks';

const DEFAULT_IP_ECHO_URL = 'https://api.ipify.org?format=json';
const DEFAULT_IP_ECHO_TIMEOUT_MS = 15_000;

// One proxy per line; blank lines and `#` comments are ignored so the pool file
// can be annotated. Credentials in `user:pass@host` form are preserved verbatim.
export function parseProxyList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      if (line.includes('://')) return line;
      const fields = line.split(':');
      if (fields.length === 2) return `http://${line}`;
      if (fields.length !== 4) return line;
      const [host, port, username, password] = fields;
      return `socks5h://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    });
}

export async function loadProxies(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return parseProxyList(contents);
}

export function createSocksConnector(
  proxyUrl,
  {
    createConnection = (options) => SocksClient.createConnection(options),
    tlsConnector = buildConnector({}),
  } = {},
) {
  const parsed = new URL(proxyUrl);
  if (!['socks5:', 'socks5h:'].includes(parsed.protocol)) {
    throw new Error('SOCKS connector requires a socks5:// or socks5h:// URL');
  }

  const proxy = Object.freeze({
    host: parsed.hostname,
    port: Number(parsed.port),
    type: 5,
    userId: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  });

  return async function connect(options, callback) {
    try {
      const destination = {
        host: options.hostname,
        port: Number(options.port || (options.protocol === 'https:' ? 443 : 80)),
      };
      const { socket } = await createConnection({
        proxy,
        command: 'connect',
        destination,
      });

      if (options.protocol === 'https:') {
        tlsConnector({ ...options, httpSocket: socket }, callback);
        return;
      }
      callback(null, socket);
    } catch (error) {
      callback(error, null);
    }
  };
}

export function createDispatcher(proxyUrl) {
  let parsed;
  try {
    // Validate before handing to undici so we fail with a clear message.
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('invalid proxy URL');
  }

  if (['http:', 'https:'].includes(parsed.protocol)) {
    return new ProxyAgent(proxyUrl);
  }
  if (['socks5:', 'socks5h:'].includes(parsed.protocol)) {
    return new Agent({ connect: createSocksConnector(proxyUrl) });
  }
  throw new Error(`unsupported proxy protocol: ${parsed.protocol}`);
}

// Dry-run preflight: prove every proxy resolves to a distinct egress IP before
// arming. A shared or dead IP would collide with the backend's 1 IP = 1 mint
// rule, so duplicates and failures are surfaced instead of silently accepted.
export async function verifyEgressIps(
  dispatchers,
  {
    fetchFn,
    ipEchoUrl = DEFAULT_IP_ECHO_URL,
    timeoutMs = DEFAULT_IP_ECHO_TIMEOUT_MS,
  } = {},
) {
  const results = await Promise.all(
    dispatchers.map(async (dispatcher, index) => {
      try {
        const response = await fetchFn(ipEchoUrl, {
          dispatcher,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`IP echo HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!data?.ip) throw new Error('IP echo returned no ip field');
        return { index, ip: data.ip, ok: true };
      } catch (error) {
        return {
          index,
          ip: null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const seen = new Map();
  for (const { ip } of results) {
    if (ip) seen.set(ip, (seen.get(ip) || 0) + 1);
  }
  const duplicates = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([ip]) => ip);

  return Object.freeze({
    results,
    uniqueCount: seen.size,
    duplicates,
  });
}

// Run two independent checks for every dispatcher. A proxy is usable for an
// armed mint only when it succeeds in every round, keeps the same egress IP,
// and no round shares that IP with another wallet.
export async function verifyStableEgressIps(
  dispatchers,
  {
    fetchFn,
    ipEchoUrl = DEFAULT_IP_ECHO_URL,
    timeoutMs = DEFAULT_IP_ECHO_TIMEOUT_MS,
    rounds = 2,
  } = {},
) {
  if (!Number.isSafeInteger(rounds) || rounds < 2) {
    throw new Error('proxy stability check requires at least two rounds');
  }

  const roundReports = [];
  for (let round = 0; round < rounds; round += 1) {
    roundReports.push(
      await verifyEgressIps(dispatchers, { fetchFn, ipEchoUrl, timeoutMs }),
    );
  }

  const results = dispatchers.map((_, index) => {
    const samples = roundReports.map((report) => report.results[index]);
    const ips = samples.map((sample) => sample?.ip ?? null);
    const ok = samples.every((sample) => sample?.ok === true);
    const stable = ok && ips.every((ip) => ip === ips[0]);
    return Object.freeze({ index, ips, ok, stable });
  });

  const failedIndices = results.filter((result) => !result.ok).map(({ index }) => index);
  const unstableIndices = results
    .filter((result) => result.ok && !result.stable)
    .map(({ index }) => index);
  const duplicates = [
    ...new Set(roundReports.flatMap((report) => report.duplicates)),
  ];
  const stableIps = results
    .filter((result) => result.stable)
    .map((result) => result.ips[0]);
  const uniqueCount = new Set(stableIps).size;
  const stableCount = results.filter((result) => result.stable).length;
  const ready =
    dispatchers.length > 0 &&
    failedIndices.length === 0 &&
    unstableIndices.length === 0 &&
    duplicates.length === 0 &&
    stableCount === dispatchers.length &&
    uniqueCount === dispatchers.length;

  return Object.freeze({
    rounds: roundReports,
    results,
    uniqueCount,
    stableCount,
    duplicates,
    failedIndices,
    unstableIndices,
    ready,
  });
}
