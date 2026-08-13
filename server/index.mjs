import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {WebSocket, WebSocketServer} from 'ws';
import {formatEther, getAddress} from 'viem';
import {
  CHAIN_PRESETS,
  createClients,
  loadAccounts,
  parseConcurrency,
  parsePositiveInteger,
  previewMint,
  requoteSeaDropPlan,
  resolveChainConfig,
  sendTransactionPlan,
  serializePlan,
} from '../lib/mint-core.mjs';
import {rpcProbe} from '../scripts/erpc-runtime.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '../apps/web');
const PORT = Number(process.env.PORT || 18787);
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const UPSTREAM_HTTP = process.env.WAYPOINT_API_BASE?.trim() || 'https://api.waypoint.tools';
const UPSTREAM_WS = process.env.WAYPOINT_WS_URL?.trim() || 'wss://api.waypoint.tools/ws/mints';
const JOB_TTL_MS = 30 * 60 * 1000;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const ALLOWED_UPSTREAM_TYPES = new Set([
  'chains', 'overview', 'mint', 'name_update', 'alert', 'milestone',
  'viewers', 'hide_count', 'scam_count', 'price_update',
]);

const app = express();
app.disable('x-powered-by');
app.use(cors({origin: false}));
app.use(express.json({limit: '256kb'}));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'public, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const jobs = new Map();
const browserSockets = new Set();
let upstreamSocket = null;
let upstreamReconnectTimer = null;
let upstreamReconnectDelayMs = 2000;
let shuttingDown = false;
let lastOverviewSnapshot = null;
let lastOverviewSignature = null;
let overviewPollTimer = null;
const collectionSnapshotCache = new Map();

function liveFeedStatus() {
  return upstreamSocket?.readyState === WebSocket.OPEN ? 'connected' : 'polling';
}

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res, status, value) {
  res.status(status).json(value);
}

function upstreamHeaders() {
  return {
    accept: 'application/json',
    origin: 'https://waypoint.tools',
    referer: 'https://waypoint.tools/mintscan/',
    'user-agent': process.env.USER_AGENT?.trim()
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36',
  };
}

async function proxyJson(pathname) {
  const response = await fetch(`${UPSTREAM_HTTP}${pathname}`, {
    headers: upstreamHeaders(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}: ${body?.error || text.slice(0, 200)}`);
  }
  return body;
}

function overviewRows(data) {
  return data?.windows?.['60'] || data?.windows?.['180'] || [];
}

function overviewSignature(item) {
  return `${item.chain || 'ethereum'}:${String(item.address).toLowerCase()}`;
}

function mintSnapshotKey(mint) {
  return mint?.tx_hash || `${mint?.timestamp || 0}:${mint?.to_address || ''}:${mint?.token_id ?? ''}`;
}

async function collectionMintSnapshot(item) {
  const chain = item.chain || 'ethereum';
  const key = overviewSignature(item);
  const data = await proxyJson(`/api/collection/${getAddress(item.address)}?chain=${encodeURIComponent(chain)}`);
  const recentMints = Array.isArray(data.recent_mints) ? data.recent_mints : [];
  const previousKeys = collectionSnapshotCache.get(key)?.mintKeys || new Set();
  const freshMints = recentMints.filter((mint) => !previousKeys.has(mintSnapshotKey(mint)));
  collectionSnapshotCache.set(key, {mintKeys: new Set(recentMints.map(mintSnapshotKey)), fetchedAt: Date.now()});
  return {data, freshMints};
}

async function emitOverviewDiff(data, {emitMints = true} = {}) {
  const current = new Map(overviewRows(data).map((item) => [overviewSignature(item), item]));
  if (emitMints && lastOverviewSnapshot) {
    for (const [key, item] of current) {
      const previous = lastOverviewSnapshot.get(key);
      if (!previous) continue;
      const delta = Math.max(0, Number(item.total_mints || 0) - Number(previous.total_mints || 0));
      if (!delta) continue;
      let detail = null;
      let freshMints = [];
      try {
        ({data: detail, freshMints} = await collectionMintSnapshot(item));
      } catch (error) {
        console.error(`Collection enrichment error for ${key}: ${errorMessage(error)}`);
      }
      const latestMint = freshMints[0] || detail?.recent_mints?.[0] || null;
      const timestamp = Number(latestMint?.timestamp || detail?.last_mint_time || Date.now() / 1000);
      broadcast({
        type: 'mint',
        source: 'overview_poll',
        activity_count: delta,
        address: item.address,
        name: item.name,
        chain: item.chain || 'ethereum',
        chain_label: item.chain_label,
        chain_emoji: item.chain_emoji,
        image_url: item.image_url,
        mint_price: detail?.mint_price || null,
        mint_price_raw: detail?.mint_price_raw ?? null,
        to_address: latestMint?.to_address || null,
        tx_hash: latestMint?.tx_hash || null,
        token_id: latestMint?.token_id ?? null,
        current_supply: detail?.current_supply ?? null,
        max_supply: detail?.max_supply ?? null,
        timestamp,
        is_airdrop: Boolean(detail?.is_airdrop ?? item.is_airdrop),
      });
    }
  }
  lastOverviewSnapshot = current;
}

async function pollOverview() {
  if (shuttingDown) return;
  try {
    const data = await proxyJson('/api/overview/all');
    await emitOverviewDiff(data, {emitMints: upstreamSocket?.readyState !== WebSocket.OPEN});
    const signature = crypto.createHash('sha256').update(JSON.stringify(data.windows || {})).digest('hex');
    if (signature !== lastOverviewSignature) {
      lastOverviewSignature = signature;
      broadcast(data);
    }
    if (upstreamSocket?.readyState !== WebSocket.OPEN) {
      broadcast({type: 'upstream_status', status: 'polling', timestamp: nowIso()});
    }
  } catch (error) {
    console.error(`Waypoint overview poll error: ${errorMessage(error)}`);
  } finally {
    overviewPollTimer = setTimeout(pollOverview, 5000);
    overviewPollTimer.unref();
  }
}

function walletConfiguration() {
  try {
    return {accounts: loadAccounts(), error: null};
  } catch (error) {
    return {accounts: [], error: errorMessage(error)};
  }
}

function selectedAccounts(walletAddresses) {
  if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
    throw new Error('Select at least one wallet for preview.');
  }
  if (walletAddresses.length > 500) throw new Error('Too many wallet addresses selected.');
  const requested = walletAddresses.map((value) => getAddress(String(value)));
  const requestedKeys = new Set(requested.map((address) => address.toLowerCase()));
  if (requestedKeys.size !== requested.length) throw new Error('Duplicate wallet address selected.');
  const {accounts, error} = walletConfiguration();
  if (error) throw new Error(error);
  const byAddress = new Map(accounts.map((account) => [account.address.toLowerCase(), account]));
  const unknown = requested.find((address) => !byAddress.has(address.toLowerCase()));
  if (unknown) throw new Error(`Selected wallet is not configured in the local signer: ${unknown}`);
  return requested.map((address) => byAddress.get(address.toLowerCase()));
}

function webChainEnv(chainKey) {
  const preset = CHAIN_PRESETS[chainKey] || CHAIN_PRESETS.hood;
  const prefix = chainKey === 'ethereum' ? 'ETHEREUM' : 'ROBINHOOD';
  return {
    ...process.env,
    CHAIN_IDENTIFIER: preset.chainIdentifier,
    CHAIN_ID: String(preset.chainId),
    CHAIN_NAME: preset.name,
    RPC_URL: process.env[`${prefix}_RPC_URL`]?.trim() || preset.rpcUrl,
  };
}

async function walletRows(chainKey = 'hood') {
  const {accounts, error} = walletConfiguration();
  if (error) return {configured: false, error, chainKey, wallets: []};
  const chainConfig = resolveChainConfig({chainKey, env: webChainEnv(chainKey)});
  const {publicClient} = createClients(chainConfig);
  const rows = await Promise.all(accounts.map(async (account, index) => {
    try {
      const balance = await publicClient.getBalance({address: account.address});
      return {index: index + 1, address: account.address, balance: balance.toString(), balanceEth: formatEther(balance)};
    } catch (balanceError) {
      return {index: index + 1, address: account.address, balance: null, balanceEth: null, error: errorMessage(balanceError)};
    }
  }));
  return {configured: true, error: null, chainKey, count: rows.length, wallets: rows};
}

function publicPlan(plan) {
  return serializePlan(plan);
}

function publicWallet(wallet) {
  if (!wallet) return wallet;
  const {transaction, ...rest} = wallet;
  return transaction ? {
    ...rest,
    transaction: {
      to: transaction.to,
      value: transaction.value,
      actionType: transaction.actionType,
      isSeaDropMintSigned: transaction.isSeaDropMintSigned,
    },
  } : rest;
}

function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    status: job.status,
    contractAddress: job.contractAddress,
    chainKey: job.chainKey,
    quantity: job.quantity,
    tokenId: job.tokenId,
    concurrency: job.concurrency,
    confirmationToken: job.status === 'previewed' ? job.confirmationToken : undefined,
    failedWallets: job.failedWallets,
    skippedWallets: job.skippedWallets,
    wallets: job.wallets.map(publicWallet),
    sent: job.sent,
    failed: job.failed,
  };
}

function broadcast(value) {
  const message = JSON.stringify(value);
  for (const socket of browserSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function emitJob(job, event) {
  job.updatedAt = nowIso();
  broadcast({
    type: 'mint_job',
    jobId: job.id,
    status: job.status,
    timestamp: job.updatedAt,
    event,
    job: publicJob(job),
  });
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAtMs < now && !['sending'].includes(job.status)) jobs.delete(id);
  }
}

setInterval(cleanupJobs, 60_000).unref();

app.get('/api/health', (req, res) => {
  const wallet = walletConfiguration();
  sendJson(res, 200, {
    ok: true,
    timestamp: nowIso(),
    upstreamWebSocket: upstreamSocket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    liveFeedMode: liveFeedStatus(),
    walletsConfigured: !wallet.error,
    walletCount: wallet.accounts.length,
  });
});

app.get('/api/rpc/status', async (req, res) => {
  const checks = await Promise.allSettled([
    rpcProbe(1, process.env, 5000),
    rpcProbe(4663, process.env, 5000),
  ]);
  const chain = (name, chainId, result) => result.status === 'fulfilled'
    ? {name, ok: true, ...result.value}
    : {name, chainId, ok: false, error: errorMessage(result.reason)};
  const chains = {
    ethereum: chain('Ethereum', 1, checks[0]),
    robinhood: chain('Robinhood Chain', 4663, checks[1]),
  };
  sendJson(res, Object.values(chains).every((item) => item.ok) ? 200 : 503, {
    ok: Object.values(chains).every((item) => item.ok),
    timestamp: nowIso(),
    chains,
  });
});

app.get('/api/chains', async (req, res) => {
  try {
    sendJson(res, 200, await proxyJson('/api/chains'));
  } catch (error) {
    sendJson(res, 502, {error: errorMessage(error)});
  }
});

app.get('/api/overview/all', async (req, res) => {
  try {
    sendJson(res, 200, await proxyJson('/api/overview/all'));
  } catch (error) {
    sendJson(res, 502, {error: errorMessage(error)});
  }
});

app.get('/api/collection/:address', async (req, res) => {
  try {
    const address = getAddress(req.params.address);
    const chain = req.query.chain === 'ethereum' ? 'ethereum' : 'hood';
    sendJson(res, 200, await proxyJson(`/api/collection/${address}?chain=${encodeURIComponent(chain)}`));
  } catch (error) {
    sendJson(res, 400, {error: errorMessage(error)});
  }
});

app.get('/api/wallets', async (req, res) => {
  try {
    const chainKey = req.query.chain === 'ethereum' ? 'ethereum' : 'hood';
    sendJson(res, 200, await walletRows(chainKey));
  } catch (error) {
    sendJson(res, 500, {configured: false, error: errorMessage(error), wallets: []});
  }
});

app.post('/api/mint/preview', async (req, res) => {
  try {
    const contractAddress = getAddress(req.body?.contractAddress);
    const chainKey = req.body?.chainKey === 'ethereum' ? 'ethereum' : 'hood';
    const quantity = parsePositiveInteger(req.body?.quantity ?? '1', 'quantity');
    const tokenId = String(req.body?.tokenId ?? '0');
    if (!/^(0|[1-9]\d*)$/.test(tokenId)) throw new Error('tokenId must be a non-negative integer string.');
    const concurrency = parseConcurrency(String(req.body?.concurrency ?? process.env.WALLET_CONCURRENCY ?? '0'), 'concurrency');
    const accounts = selectedAccounts(req.body?.walletAddresses);
    const preview = await previewMint({
      contractAddress,
      chainKey,
      quantity,
      tokenId,
      concurrency,
      accounts,
      env: webChainEnv(chainKey),
    });
    if (preview.failedWallets.length) {
      return sendJson(res, 422, {
        error: 'One or more wallets failed preflight; no Mint job was created.',
        failedWallets: preview.failedWallets,
        skippedWallets: preview.skippedWallets,
      });
    }

    const id = crypto.randomUUID();
    const confirmationToken = crypto.randomBytes(24).toString('hex');
    const createdAt = nowIso();
    const expiresAtMs = Date.now() + CONFIRM_TTL_MS;
    const wallets = [
      ...preview.readyPlans.map((plan) => ({...publicPlan(plan), status: 'ready'})),
      ...preview.skippedWallets.map((item) => ({...item, status: 'skipped'})),
    ];
    const job = {
      id,
      confirmationToken,
      createdAt,
      updatedAt: createdAt,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      status: 'previewed',
      contractAddress,
      chainKey,
      quantity: quantity.toString(),
      tokenId,
      concurrency,
      preview,
      failedWallets: preview.failedWallets,
      skippedWallets: preview.skippedWallets,
      wallets,
      sent: [],
      failed: [],
    };
    jobs.set(id, job);
    emitJob(job, {type: 'preview_ready'});
    sendJson(res, 201, publicJob(job));
  } catch (error) {
    sendJson(res, 400, {error: errorMessage(error)});
  }
});

app.post('/api/mint/send', async (req, res) => {
  const job = jobs.get(String(req.body?.jobId || ''));
  if (!job) return sendJson(res, 404, {error: 'Mint job was not found or expired.'});
  if (job.status !== 'previewed') return sendJson(res, 409, {error: `Mint job is ${job.status}.`});
  if (!req.body?.confirmationToken || req.body.confirmationToken !== job.confirmationToken) {
    return sendJson(res, 403, {error: 'Explicit confirmation token is missing or invalid.'});
  }
  if (job.expiresAtMs < Date.now()) {
    job.status = 'expired';
    return sendJson(res, 410, {error: 'Preview expired. Run it again before sending.'});
  }
  if (!job.preview.readyPlans.length) return sendJson(res, 409, {error: 'No wallet passed the balance preflight.'});

  job.confirmationToken = null;
  job.status = 'sending';
  for (const wallet of job.wallets) if (wallet.status === 'ready') wallet.status = 'pending';
  emitJob(job, {type: 'sending'});
  sendJson(res, 202, publicJob(job));

  void (async () => {
    const readyPlans = job.preview.readyPlans;
    const limit = job.concurrency === 0 ? readyPlans.length : Math.min(job.concurrency, readyPlans.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= readyPlans.length) return;
        const plan = readyPlans[index];
        const walletRow = job.wallets.find((item) => item.address === plan.account.address);
        try {
          const quote = await requoteSeaDropPlan({publicClient: job.preview.publicClient, plan});
          if (quote.changed && quote.newValue > quote.oldValue) {
            throw new Error(`Mint price increased from ${formatEther(quote.oldValue)} ETH to ${formatEther(quote.newValue)} ETH. Run preview again.`);
          }
          if (walletRow) {
            walletRow.status = 'pending';
            walletRow.valueEth = formatEther(plan.transaction.value);
            walletRow.requoted = quote.changed;
          }
          emitJob(job, {type: 'wallet_pending', address: plan.account.address});
          const result = await sendTransactionPlan({
            plan,
            publicClient: job.preview.publicClient,
            chain: job.preview.chain,
            rpcUrl: job.preview.rpcUrl,
            noWait: Boolean(req.body?.noWait),
          });
          const sent = {
            address: plan.account.address,
            hash: result.hash,
            status: result.receipt?.status ?? 'sent',
            blockNumber: result.receipt?.blockNumber?.toString() ?? null,
            valueEth: formatEther(plan.transaction.value),
          };
          job.sent.push(sent);
          if (walletRow) Object.assign(walletRow, sent, {status: result.receipt ? 'confirmed' : 'sent'});
          emitJob(job, {type: result.receipt ? 'wallet_confirmed' : 'wallet_sent', ...sent});
        } catch (error) {
          const failed = {address: plan.account.address, error: errorMessage(error)};
          job.failed.push(failed);
          if (walletRow) Object.assign(walletRow, failed, {status: 'failed'});
          emitJob(job, {type: 'wallet_failed', ...failed});
        }
      }
    }
    await Promise.all(Array.from({length: limit}, worker));
    job.status = job.failed.length ? (job.sent.length ? 'partial' : 'failed') : 'completed';
    job.expiresAtMs = Date.now() + JOB_TTL_MS;
    job.expiresAt = new Date(job.expiresAtMs).toISOString();
    emitJob(job, {type: 'finished'});
  })();
});

app.get('/api/mint/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return sendJson(res, 404, {error: 'Mint job was not found or expired.'});
  sendJson(res, 200, publicJob(job));
});

app.use(express.static(WEB_ROOT, {index: 'index.html', maxAge: '1m'}));
app.get('*', (req, res) => res.sendFile(path.join(WEB_ROOT, 'index.html')));

const server = app.listen(PORT, HOST, () => {
  console.log(`611nft multi-wallet server running on http://${HOST}:${PORT}`);
});

const wss = new WebSocketServer({
  server,
  path: '/ws/mints',
  verifyClient: ({origin, req}) => {
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.headers.host;
    } catch {
      return false;
    }
  },
});
wss.on('connection', (socket) => {
  browserSockets.add(socket);
  socket.send(JSON.stringify({type: 'local_status', connected: true, timestamp: nowIso()}));
  socket.send(JSON.stringify({
    type: 'upstream_status',
    status: liveFeedStatus(),
    timestamp: nowIso(),
  }));
  socket.on('message', (raw) => {
    let value;
    try { value = JSON.parse(raw.toString()); } catch { return; }
    if (value.type === 'view' && upstreamSocket?.readyState === WebSocket.OPEN) {
      upstreamSocket.send(JSON.stringify({type: 'view', address: value.address, chain: value.chain}));
    }
    if (['hide', 'report_scam', 'unreport_scam'].includes(value.type)
        && upstreamSocket?.readyState === WebSocket.OPEN) {
      upstreamSocket.send(JSON.stringify(value));
    }
  });
  socket.on('error', () => browserSockets.delete(socket));
  socket.on('close', () => browserSockets.delete(socket));
});

function connectUpstream() {
  if (shuttingDown || upstreamSocket?.readyState === WebSocket.CONNECTING || upstreamSocket?.readyState === WebSocket.OPEN) return;
  upstreamSocket = new WebSocket(UPSTREAM_WS, {headers: upstreamHeaders()});
  upstreamSocket.on('open', () => {
    upstreamReconnectDelayMs = 2000;
    console.log('Waypoint live feed connected');
    broadcast({type: 'upstream_status', status: 'connected', timestamp: nowIso()});
  });
  upstreamSocket.on('message', (raw) => {
    let value;
    try { value = JSON.parse(raw.toString()); } catch { return; }
    if (ALLOWED_UPSTREAM_TYPES.has(value.type)) broadcast(value);
  });
  upstreamSocket.on('close', (code, reason) => {
    upstreamSocket = null;
    broadcast({type: 'upstream_status', status: 'polling', code, reason: reason.toString(), timestamp: nowIso()});
    if (!shuttingDown) scheduleUpstreamReconnect();
  });
  upstreamSocket.on('error', (error) => console.error(`Waypoint live feed error: ${error.message}`));
  upstreamSocket.on('unexpected-response', (request, response) => {
    const retryAfterSeconds = Number(response.headers['retry-after']);
    upstreamReconnectDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(Math.max(upstreamReconnectDelayMs * 2, 30_000), 5 * 60_000);
    console.error(`Waypoint live feed HTTP ${response.statusCode}; retrying in ${Math.ceil(upstreamReconnectDelayMs / 1000)}s`);
    response.resume();
    upstreamSocket = null;
    if (!shuttingDown) scheduleUpstreamReconnect(upstreamReconnectDelayMs);
  });
}

function scheduleUpstreamReconnect(delay = upstreamReconnectDelayMs) {
  clearTimeout(upstreamReconnectTimer);
  upstreamReconnectTimer = setTimeout(connectUpstream, delay);
  upstreamReconnectTimer.unref();
}

connectUpstream();
pollOverview();

function shutdown() {
  shuttingDown = true;
  clearTimeout(upstreamReconnectTimer);
  clearTimeout(overviewPollTimer);
  upstreamSocket?.close();
  for (const socket of browserSockets) socket.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
