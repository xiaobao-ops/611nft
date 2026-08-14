import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  parseUnits,
} from 'ethers';

import {
  createEthersChain,
  createMonitorChain,
  createTicketClient,
} from './adapters.js';
import { loadConfig } from './config.js';
import {
  ABI,
  CHAIN_ID,
  CONTRACT_ADDRESS,
  DEFAULT_RPC_URL,
  DEFAULT_TICKET_URL,
  STATE_FILENAME,
} from './constants.js';
import {
  createDispatcher,
  loadProxies,
  verifyEgressIps,
  verifyStableEgressIps,
} from './proxy.js';
import { createProxyApiClient } from './proxy-api.js';
import { createHybridProxyPool, createReserveProxyClient } from './proxy-pool.js';
import { mapWithConcurrency } from './pool.js';
import { createOpenClawDiscordNotifier } from './notifier.js';
import { runMultiMint, runSingleMint } from './runner.js';
import { createStateStore, createWalletStateStores } from './state.js';
import { deriveWallets, loadPrivateKeyWallets } from './wallets.js';

const STATE_DIR = '.mint-state';
const SECRET_HEX = /0x[0-9a-fA-F]{64,}/g;

function replaceExact(value, secret, replacement) {
  if (!secret) return value;
  return value.split(secret).join(replacement);
}

function redactUrl(value, rawUrl, label) {
  if (!rawUrl) return value;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return replaceExact(value, rawUrl, `[${label} URL]`);
  }

  let redacted = replaceExact(value, rawUrl, `[${label} URL: ${parsed.hostname}]`);
  const componentGroups = [
    {
      values: [parsed.username, parsed.password],
      replacement: `[redacted ${label} userinfo]`,
    },
    {
      values: parsed.pathname.split('/').filter(Boolean),
      replacement: `[redacted ${label} path]`,
    },
    {
      values: [...parsed.searchParams.entries()].flatMap(([key, item]) =>
        [key, item].filter(Boolean),
      ),
      replacement: `[redacted ${label} query]`,
    },
  ];

  for (const { values, replacement } of componentGroups) {
    for (const component of values) {
      redacted = replaceExact(redacted, component, replacement);
      try {
        redacted = replaceExact(redacted, decodeURIComponent(component), replacement);
      } catch {
        // The exact encoded component was already covered.
      }
    }
  }
  return redacted;
}

function collectErrorText(error, seen = new Set()) {
  if (error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  if (seen.has(error)) return '';
  seen.add(error);

  const parts = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (error.source !== undefined) parts.push(collectErrorText(error.source, seen));
  if (error.cause !== undefined) parts.push(collectErrorText(error.cause, seen));
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) parts.push(collectErrorText(nested, seen));
  }
  return parts.filter(Boolean).join(' | ');
}

export function sanitizeFatalError(
  error,
  { privateKey, rpcUrl, ticketUrl, proxyApiUrl, mnemonic, proxyUrls = [] } = {},
) {
  let message = collectErrorText(error) || String(error);
  message = replaceExact(message, privateKey, '[redacted private key]');
  message = replaceExact(message, mnemonic, '[redacted mnemonic]');
  message = redactUrl(message, rpcUrl, 'RPC');
  message = redactUrl(message, ticketUrl, 'Ticket');
  message = redactUrl(message, proxyApiUrl, 'Proxy API');
  for (const proxy of proxyUrls) {
    message = redactUrl(message, proxy, 'Proxy');
  }
  return message.replace(SECRET_HEX, '[redacted hex]');
}

function sleep(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(new Error('interrupted by SIGINT'));

  return new Promise((resolveSleep, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('interrupted by SIGINT'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function publicConfigurationLines({ config, walletAddress, armed }) {
  return [
    'mode=single',
    `armed=${armed}`,
    `wallet=${walletAddress}`,
    `chainId=${CHAIN_ID}`,
    `contract=${CONTRACT_ADDRESS}`,
    `rpcHost=${new URL(config.rpcUrl).hostname}`,
    `ticketTimeoutMs=${config.ticketTimeoutMs}`,
    `pollIntervalMs=${config.pollIntervalMs}`,
    `maxGasLimit=${config.maxGasLimit}`,
    `maxFeePerGasGwei=${config.maxFeePerGasGwei}`,
    `confirmations=${config.confirmations}`,
    `failedReceiptRetries=${config.failedReceiptRetries || 0}`,
    `discordNotifications=${Boolean(config.openClawDiscordTarget)}`,
  ];
}

export function multiConfigurationLines({ config, walletCount, proxyCount, armed }) {
  return [
    `mode=multi`,
    `armed=${armed}`,
    `wallets=${walletCount}`,
    `proxies=${proxyCount}`,
    `proxyPreheat=${config.proxyPreheat || false}`,
    `proxyPreheatRecheckMs=${config.proxyPreheatRecheckMs || 0}`,
    `mintConcurrency=${config.mintConcurrency}`,
    `readConcurrency=${config.readConcurrency || config.mintConcurrency}`,
    `chainId=${CHAIN_ID}`,
    `contract=${CONTRACT_ADDRESS}`,
    `rpcHost=${new URL(config.rpcUrl).hostname}`,
    `ticketTimeoutMs=${config.ticketTimeoutMs}`,
    `pollIntervalMs=${config.pollIntervalMs}`,
    `maxGasLimit=${config.maxGasLimit}`,
    `maxFeePerGasGwei=${config.maxFeePerGasGwei}`,
    `confirmations=${config.confirmations}`,
    `failedReceiptRetries=${config.failedReceiptRetries || 0}`,
    `discordNotifications=${Boolean(config.openClawDiscordTarget)}`,
  ];
}

async function runSingleWallet({ config, log, signal }) {
  const notifier = createOpenClawDiscordNotifier({
    target: config.openClawDiscordTarget,
    timeoutMs: config.openClawTimeoutMs,
    log,
  });
  const provider = new JsonRpcProvider(config.rpcUrl);
  const wallet = new Wallet(config.privateKey, provider);
  const contract = new Contract(CONTRACT_ADDRESS, ABI, wallet);
  const chain = createEthersChain({ provider, wallet, contract });
  const ticketClient = createTicketClient({
    url: config.ticketUrl,
    fetchFn: fetch,
    timeoutMs: config.ticketTimeoutMs,
    signal,
  });
  const stateStore = createStateStore(resolve(process.cwd(), STATE_FILENAME));

  for (const line of publicConfigurationLines({
    config,
    walletAddress: wallet.address,
    armed: config.arm,
  })) {
    log(line);
  }

  if (!config.arm) {
    log('DRY-RUN: rehearsal only — no ticket requested, no transaction broadcast.');
    log('         Re-run with --arm (or ARM=true) to mint for real once Mint opens.');
  } else {
    log('ARMED: will broadcast one real mint the moment Mint opens.');
  }

  try {
    const result = await runSingleMint({
      config,
      walletAddress: wallet.address,
      chain,
      ticketClient,
      stateStore,
      sleep: (milliseconds) => sleep(milliseconds, signal),
      log,
      onMintOpen: (event) => notifier.notifyMintOpen(event),
      onMintSuccess: (event) => notifier.notifyMintSuccess(event),
    });
    log(`status=${result.status}`);
    if (result.txHash) log(`txHash=${result.txHash}`);
    return result;
  } finally {
    await notifier.flush();
  }
}

// Preflight (safe, no ticket/broadcast): per-wallet gas balance vs worst-case
// mint cost. Surfaces underfunded wallets before Mint opens.
export async function reportGasBalances({ provider, wallets, config, log }) {
  const worstCaseWei =
    config.maxGasLimit * parseUnits(String(config.maxFeePerGasGwei), 'gwei');
  const results = await mapWithConcurrency(
    wallets,
    config.readConcurrency || config.mintConcurrency,
    async ({ index, address }) => {
      try {
        const balance = await provider.getBalance(address);
        const ok = balance >= worstCaseWei;
        log(
          `  gas[${index}] ${address}: ${formatEther(balance)} ETH ${ok ? 'ok' : 'UNDERFUNDED'}`,
        );
        return { index, address, ok, available: true, balance };
      } catch {
        log(`  gas[${index}] ${address}: balance check unavailable`);
        return { index, address, ok: false, available: false, balance: null };
      }
    },
  );
  const underfunded = results.filter((result) => result.available && !result.ok).length;
  const unavailable = results.filter((result) => !result.available).length;
  log(
    `gas preflight: worstCase=${formatEther(worstCaseWei)} ETH/wallet, underfunded=${underfunded}/${wallets.length}, unavailable=${unavailable}/${wallets.length}`,
  );
  return Object.freeze({
    ready: underfunded === 0 && unavailable === 0,
    underfunded,
    unavailable,
    worstCaseWei,
    results: Object.freeze(results),
  });
}

function assertGasPreflightReady(report) {
  if (report?.ready !== true) {
    throw new Error(
      `gas preflight not ready: underfunded=${report?.underfunded ?? 0} unavailable=${report?.unavailable ?? 0}`,
    );
  }
}

// Preflight (safe): prove each proxy resolves to a distinct egress IP. Hits an
// IP echo, never the ticket endpoint, so it does not consume 1-IP-1-mint quota.
async function reportEgressIps({ dispatchers, log }) {
  const active = dispatchers.filter(Boolean);
  if (active.length === 0) {
    log('proxy preflight: no proxies configured — skipping egress IP check');
    return Object.freeze({
      ready: false,
      results: [],
      uniqueCount: 0,
      stableCount: 0,
      duplicates: [],
      failedIndices: [],
      unstableIndices: [],
    });
  }
  let report;
  try {
    report = await verifyStableEgressIps(active, { fetchFn: fetch });
  } catch (error) {
    log('proxy preflight: egress IP stability check failed');
    return Object.freeze({
      ready: false,
      results: [],
      uniqueCount: 0,
      stableCount: 0,
      duplicates: [],
      failedIndices: active.map((_, index) => index),
      unstableIndices: [],
    });
  }
  log(
    `proxy preflight: ${active.length} proxies, rounds=${report.rounds.length}, uniqueIPs=${report.uniqueCount}, stable=${report.stableCount}, duplicates=${report.duplicates.length}, failed=${report.failedIndices.length}, unstable=${report.unstableIndices.length}`,
  );
  if (report.duplicates.length > 0) {
    log(`  WARNING duplicate egress IP groups will collide with 1 IP = 1 mint: ${report.duplicates.length}`);
  }
  if (report.unstableIndices.length > 0) {
    log(`  WARNING unstable proxy sessions: ${report.unstableIndices.length}`);
  }
  return report;
}

export function assertProxyPreflightReady(report, expectedCount) {
  const checked = report?.results?.length ?? 0;
  const failed = report?.failedIndices?.length ?? 0;
  const duplicates = report?.duplicates?.length ?? 0;
  const unstable = report?.unstableIndices?.length ?? 0;
  if (
    report?.ready !== true ||
    checked !== expectedCount ||
    failed > 0 ||
    duplicates > 0 ||
    unstable > 0
  ) {
    throw new Error(
      `proxy preflight not ready: checked=${checked}/${expectedCount} failed=${failed} duplicates=${duplicates} unstable=${unstable}`,
    );
  }
}

export async function prepareProxyPreflight({
  armed,
  dispatchers,
  expectedCount,
  log,
  report = reportEgressIps,
}) {
  if (!armed) {
    return undefined;
  }

  return async () => {
    const proxyReport = await report({ dispatchers, log });
    assertProxyPreflightReady(proxyReport, expectedCount);
  };
}

export async function createProxyDispatchers({
  wallets,
  proxies,
  config,
  armed,
  log,
  create = createDispatcher,
}) {
  if (proxies.length === 0) {
    if (armed) {
      throw new Error(
        `no proxies configured but ARM requested; ${config.walletCount} proxies needed (1 IP per wallet)`,
      );
    }
    return wallets.map(() => undefined);
  }

  if (proxies.length < wallets.length) {
    if (!config.allowProxyReuse) {
      throw new Error(
        `need >= ${wallets.length} proxies (1 IP per wallet), found ${proxies.length}; set ALLOW_PROXY_REUSE=true to override`,
      );
    }
    log(
      `WARNING reusing ${proxies.length} proxies across ${wallets.length} wallets — egress IPs will repeat and hit 1 IP = 1 mint`,
    );
  }

  const dispatchers = [];
  try {
    for (let index = 0; index < wallets.length; index += 1) {
      dispatchers.push(create(proxies[index % proxies.length]));
    }
    return dispatchers;
  } catch (error) {
    await closeProxyDispatchers(dispatchers);
    throw error;
  }
}

export async function closeProxyDispatchers(dispatchers) {
  const unique = new Set(dispatchers.filter(Boolean));
  await Promise.allSettled(
    [...unique].map((dispatcher) =>
      typeof dispatcher.close === 'function' ? dispatcher.close() : undefined,
    ),
  );
}

export async function verifyStablePoolEgress(
  dispatchers,
  { verify = verifyEgressIps, fetchFn = fetch, timeoutMs } = {},
) {
  const rounds = [];
  for (let round = 0; round < 2; round += 1) {
    rounds.push(await verify(dispatchers, { fetchFn, timeoutMs }));
  }

  return Object.freeze({
    results: dispatchers.map((_, index) => {
      const samples = rounds.map((report) => report?.results?.[index]);
      const ips = samples.map((sample) => sample?.ip ?? null);
      const ok = samples.every(
        (sample) => sample?.index === index && sample?.ok === true && sample.ip,
      ) && ips.every((ip) => ip === ips[0]);
      return Object.freeze({ index, ok, ip: ok ? ips[0] : null });
    }),
  });
}

export async function runMultiWallet({ config, log, signal, deps = {} }) {
  const armed = config.arm;
  const fetchFn = deps.fetchFn ?? fetch;
  const createProvider = deps.createProvider ?? ((url) => new JsonRpcProvider(url));
  const deriveWalletsFn = deps.deriveWallets ?? deriveWallets;
  const loadPrivateKeyWalletsFn = deps.loadPrivateKeyWallets ?? loadPrivateKeyWallets;
  const loadProxiesFn = deps.loadProxies ?? loadProxies;
  const createContract = deps.createContract ?? (
    (address, abi, signerOrProvider) => new Contract(address, abi, signerOrProvider)
  );
  const createMonitorChainFn = deps.createMonitorChain ?? createMonitorChain;
  const createEthersChainFn = deps.createEthersChain ?? createEthersChain;
  const createTicketClientFn = deps.createTicketClient ?? createTicketClient;
  const createWalletStateStoresFn =
    deps.createWalletStateStores ?? createWalletStateStores;
  const createProxyApiClientFn = deps.createProxyApiClient ?? createProxyApiClient;
  const createHybridProxyPoolFn = deps.createHybridProxyPool ?? createHybridProxyPool;
  const createReserveProxyClientFn =
    deps.createReserveProxyClient ?? createReserveProxyClient;
  const createDispatcherFn = deps.createDispatcher ?? createDispatcher;
  const verifyEgressIpsFn = deps.verifyEgressIps ?? verifyEgressIps;
  const runMultiMintFn = deps.runMultiMint ?? runMultiMint;
  const createNotifierFn = deps.createNotifier ?? createOpenClawDiscordNotifier;
  const notifier = createNotifierFn({
    target: config.openClawDiscordTarget,
    timeoutMs: config.openClawTimeoutMs,
    log,
  });

  const provider = createProvider(config.rpcUrl);
  const wallets = config.privateKeysFile
    ? await loadPrivateKeyWalletsFn({
      filePath: resolve(config.privateKeysFile),
      count: config.walletCount,
      provider,
    })
    : deriveWalletsFn({
      mnemonic: config.mnemonic,
      count: config.walletCount,
      pathBase: config.derivationPathBase,
      provider,
    });
  const staticProxyUrls = await loadProxiesFn(config.proxyFile);
  if (staticProxyUrls.length !== config.staticProxyCount) {
    throw new Error(
      `expected exactly ${config.staticProxyCount} static proxies, found ${staticProxyUrls.length}`,
    );
  }
  const reserveProxyUrls = config.proxyReserveFile
    ? await loadProxiesFn(config.proxyReserveFile)
    : [];
  const seenProxyUrls = new Set(staticProxyUrls);
  const uniqueReserveProxyUrls = [];
  for (const proxyUrl of reserveProxyUrls) {
    if (seenProxyUrls.has(proxyUrl)) continue;
    seenProxyUrls.add(proxyUrl);
    uniqueReserveProxyUrls.push(proxyUrl);
  }

  const apiClient = config.dynamicProxyCount > 0
    ? createProxyApiClientFn({
      apiUrl: config.proxyApiUrl,
      fetchFn,
      timeoutMs: config.proxyApiTimeoutMs,
    })
    : Object.freeze({
      async acquire() {
        throw new Error('dynamic proxy API is disabled');
      },
    });
  const replacementClient = uniqueReserveProxyUrls.length > 0
    ? createReserveProxyClientFn({ proxyUrls: uniqueReserveProxyUrls })
    : apiClient;
  const pool = createHybridProxyPoolFn({
    staticProxyUrls,
    apiClient,
    replacementClient,
    createDispatcher: createDispatcherFn,
    verifyEgressIps: (dispatchers) => verifyStablePoolEgress(dispatchers, {
      verify: verifyEgressIpsFn,
      fetchFn,
      timeoutMs: config.proxyCheckTimeoutMs,
    }),
    maxReplacements: config.proxyMaxReplacements,
    deadlineMs: config.proxyPoolDeadlineMs,
  });

  let runFailed = false;
  let proxyRecheckTimer = null;
  try {
    for (const line of multiConfigurationLines({
      config,
      walletCount: wallets.length,
      proxyCount: config.staticProxyCount + config.dynamicProxyCount,
      armed,
    })) {
      log(line);
    }
    log('derived wallets:');
    for (const { index, address } of wallets) log(`  [${index}] ${address}`);

    if (!armed) {
      log('dynamic proxies deferred until mintOpen; dry-run performs no proxy API or egress calls.');
      log('DRY-RUN: rehearsal only — no ticket requested, no transaction broadcast.');
      log('         Re-run with --arm (or ARM=true) to mint for real once Mint opens.');
    } else {
      log(config.proxyPreheat
        ? 'ARMED: monitoring via RPC; proxy pool will preheat after gas preflight.'
        : 'ARMED: monitoring via RPC; proxies activate and validate only after Mint opens.');
    }

    const monitorContract = createContract(CONTRACT_ADDRESS, ABI, provider);
    const monitorChain = createMonitorChainFn({ provider, contract: monitorContract });
    const stateStores = await createWalletStateStoresFn(
      resolve(process.cwd(), STATE_DIR),
      wallets.map((wallet) => wallet.address),
    );

    const walletUnits = wallets.map((entry, index) => {
      const contract = createContract(CONTRACT_ADDRESS, ABI, entry.wallet);
      return {
        index: entry.index,
        address: entry.address,
        chain: createEthersChainFn({ provider, wallet: entry.wallet, contract }),
        ticketClient: createTicketClientFn({
          url: config.ticketUrl,
          fetchFn,
          getDispatcher: () => pool.dispatcherFor(entry.index),
          requireDispatcher: true,
          timeoutMs: config.ticketTimeoutMs,
          signal,
        }),
        stateStore: stateStores[index],
      };
    });

    const gasPreflightPromise = reportGasBalances({ provider, wallets, config, log });
    let proxyPrepareIndexes = [];
    let proxyPreparePromise = null;
    let latestProxyReadyPromise = null;
    let proxyRecheckInFlight = null;
    const stopProxyRechecks = () => {
      if (proxyRecheckTimer) clearInterval(proxyRecheckTimer);
      proxyRecheckTimer = null;
    };
    const runProxyRecheck = () => {
      if (proxyRecheckInFlight) return;
      log(`proxy preheat recheck: verifying ${proxyPrepareIndexes.length} assignments`);
      const currentRecheck = pool.refresh({ indexes: proxyPrepareIndexes });
      proxyRecheckInFlight = currentRecheck;
      latestProxyReadyPromise = currentRecheck;
      currentRecheck.then(
        (refreshed) => {
          log(`proxy preheat recheck: ready replacements=${refreshed.replacementCount}`);
          if (proxyRecheckInFlight === currentRecheck) proxyRecheckInFlight = null;
        },
        (error) => {
          log(`proxy preheat recheck failed: ${sanitizeFatalError(error, config)}`);
          if (proxyRecheckInFlight === currentRecheck) proxyRecheckInFlight = null;
        },
      );
    };
    const prepareBeforeMintOpen = armed && config.proxyPreheat
      ? ({ pending }) => {
        proxyPrepareIndexes = pending.map(({ index }) => index);
        proxyPreparePromise = (async () => {
          const gasReport = await gasPreflightPromise;
          assertGasPreflightReady(gasReport);
          log(`proxy preheat: preparing ${proxyPrepareIndexes.length} pending wallet proxy assignments`);
          const prepared = await pool.prepare({ indexes: proxyPrepareIndexes });
          log(`proxy preheat: ready replacements=${prepared.replacementCount}`);
          return prepared;
        })();
        latestProxyReadyPromise = proxyPreparePromise;
        if (config.proxyPreheatRecheckMs > 0) {
          proxyPreparePromise.then(
            () => {
              proxyRecheckTimer = setInterval(runProxyRecheck, config.proxyPreheatRecheckMs);
              proxyRecheckTimer.unref?.();
              log(`proxy preheat recheck: every ${config.proxyPreheatRecheckMs}ms`);
            },
            () => {},
          );
        }
        return proxyPreparePromise;
      }
      : undefined;
    const beforeFanOut = armed
      ? async ({ pending }) => {
        stopProxyRechecks();
        const gasReport = await gasPreflightPromise;
        assertGasPreflightReady(gasReport);
        if (latestProxyReadyPromise) {
          await latestProxyReadyPromise;
        } else {
          await pool.prepare({ indexes: pending.map(({ index }) => index) });
        }
      }
      : undefined;

    const report = await runMultiMintFn({
      config: { ...config, arm: armed },
      wallets: walletUnits,
      monitorChain,
      sleep: (milliseconds) => sleep(milliseconds, signal),
      log,
      prepareBeforeMintOpen,
      beforeFanOut,
      onMintOpen: (event) => notifier.notifyMintOpen(event),
      onMintSuccess: (event) => notifier.notifyMintSuccess(event),
    });
    await gasPreflightPromise;

    log('--- results ---');
    for (const result of report.results) {
      const tx = result.txHash ? ` txHash=${result.txHash}` : '';
      const err = result.error ? ` error=${result.error}` : '';
      log(`  [${result.index}] ${result.address} status=${result.status}${tx}${err}`);
    }
    log(
      `summary: ${Object.entries(report.summary)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')}`,
    );
    return report;
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    if (proxyRecheckTimer) clearInterval(proxyRecheckTimer);
    let cleanupError;
    try {
      await pool.close();
    } catch (error) {
      if (!runFailed) cleanupError = error;
    }
    await notifier.flush();
    if (cleanupError) throw cleanupError;
  }
}

export function resolveArmed(config, argv = []) {
  return config.arm || argv.includes('--arm');
}

export async function main({ env = process.env, log = console.log, argv = process.argv } = {}) {
  loadDotenv({ quiet: true });
  const config = loadConfig(env);
  const effectiveConfig = Object.freeze({
    ...config,
    arm: resolveArmed(config, argv),
  });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    if (effectiveConfig.mode === 'multi') {
      return await runMultiWallet({
        config: effectiveConfig,
        log,
        signal: controller.signal,
      });
    }
    return await runSingleWallet({
      config: effectiveConfig,
      log,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  const env = process.env;
  main({ env, argv: process.argv }).catch(async (error) => {
    let proxyUrls = [];
    try {
      proxyUrls = await loadProxies(env.PROXY_FILE || 'proxies.txt');
      if (env.PROXY_RESERVE_FILE) {
        proxyUrls.push(...await loadProxies(env.PROXY_RESERVE_FILE));
      }
    } catch {
      // Best-effort: proxy redaction only; never block the fatal report.
    }
    console.error(
      `fatal: ${sanitizeFatalError(error, {
        privateKey: env.PRIVATE_KEY,
        mnemonic: env.MNEMONIC,
        rpcUrl: env.RPC_URL || DEFAULT_RPC_URL,
        ticketUrl: env.TICKET_URL || DEFAULT_TICKET_URL,
        proxyApiUrl: env.PROXY_API_URL,
        proxyUrls,
      })}`,
    );
    process.exitCode = error?.message === 'interrupted by SIGINT' ? 130 : 1;
  });
}
