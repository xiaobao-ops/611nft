import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime', 'erpc');
const BINARY_PATH = path.join(RUNTIME_DIR, process.platform === 'win32' ? 'erpc.exe' : 'erpc');
const METADATA_PATH = path.join(RUNTIME_DIR, 'build.json');

export const ERPC_VERSION = '0.1.2';
export const ERPC_COMMIT = '803b67d8d5551275136c7ffca191060288f4ceb5';
export const ERPC_SOURCE_SHA256 = 'df6d039f9e1fdcb5d353dc78cd2f577b1298ec4ec384937495de0fb9bf59a9ab';
export const ERPC_SOURCE_URL = `https://codeload.github.com/erpc/erpc/tar.gz/${ERPC_COMMIT}`;
export const ERPC_CONFIG_PATH = path.join(ROOT, 'erpc', 'erpc.js');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, {signal: AbortSignal.timeout(120_000)});
  if (!response.ok) throw new Error(`eRPC source download returned HTTP ${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function existingBinaryIsValid() {
  try {
    const metadata = JSON.parse(await fs.readFile(METADATA_PATH, 'utf8'));
    if (metadata.version !== ERPC_VERSION || metadata.commit !== ERPC_COMMIT) return false;
    return await sha256File(BINARY_PATH) === metadata.binarySha256;
  } catch {
    return false;
  }
}

export async function ensureErpcBinary({force = false} = {}) {
  if (!force && await existingBinaryIsValid()) return BINARY_PATH;

  await run('go', ['version']);
  await fs.mkdir(RUNTIME_DIR, {recursive: true});
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '611nft-erpc-'));
  const archive = path.join(tempRoot, 'source.tar.gz');
  const sourceParent = path.join(tempRoot, 'source');
  await fs.mkdir(sourceParent, {recursive: true});

  console.log(`Downloading eRPC ${ERPC_VERSION} source at ${ERPC_COMMIT.slice(0, 12)}…`);
  await download(ERPC_SOURCE_URL, archive);
  const sourceSha256 = await sha256File(archive);
  if (sourceSha256 !== ERPC_SOURCE_SHA256) {
    throw new Error(`eRPC source checksum mismatch: ${sourceSha256}`);
  }

  await run('tar', ['-xzf', archive, '-C', sourceParent]);
  const entries = await fs.readdir(sourceParent, {withFileTypes: true});
  const sourceDir = path.join(sourceParent, entries.find((entry) => entry.isDirectory())?.name || '');
  const builtBinary = path.join(tempRoot, process.platform === 'win32' ? 'erpc.exe' : 'erpc');
  const ldflags = [
    '-s', '-w',
    `-X github.com/erpc/erpc/common.ErpcVersion=${ERPC_VERSION}`,
    `-X github.com/erpc/erpc/common.ErpcCommitSha=${ERPC_COMMIT}`,
  ].join(' ');
  console.log('Building verified eRPC source…');
  await run('go', ['build', '-trimpath', '-buildvcs=false', `-ldflags=${ldflags}`, '-o', builtBinary, './cmd/erpc'], {
    cwd: sourceDir,
    env: {...process.env, CGO_ENABLED: '0'},
  });

  const binarySha256 = await sha256File(builtBinary);
  await fs.copyFile(builtBinary, BINARY_PATH);
  await fs.chmod(BINARY_PATH, 0o755);
  await fs.writeFile(METADATA_PATH, `${JSON.stringify({
    version: ERPC_VERSION,
    commit: ERPC_COMMIT,
    sourceUrl: ERPC_SOURCE_URL,
    sourceSha256,
    binarySha256,
    builtAt: new Date().toISOString(),
    go: process.env.GOTOOLCHAIN || 'auto',
  }, null, 2)}\n`);
  await fs.rm(tempRoot, {recursive: true, force: true});
  return BINARY_PATH;
}

export function erpcBaseUrl(env = process.env) {
  const configured = env.ERPC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return `http://${env.ERPC_HOST?.trim() || '127.0.0.1'}:${Number(env.ERPC_PORT || 4000)}`;
}

export function erpcRpcUrl(chainId, env = process.env) {
  return `${erpcBaseUrl(env)}/main/evm/${chainId}`;
}

function splitUrls(value) {
  return String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function isErpcLoop(endpoint, env = process.env) {
  try {
    const target = new URL(endpoint);
    const base = new URL(erpcBaseUrl(env));
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const basePort = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
    return localHosts.has(target.hostname) && localHosts.has(base.hostname) && targetPort === basePort;
  } catch {
    return false;
  }
}

export function erpcProcessEnv(env = process.env) {
  const next = {...env};
  const mappings = [
    ['ETHEREUM_RPC_UPSTREAMS', 'ETHEREUM_RPC_URL'],
    ['ROBINHOOD_RPC_UPSTREAMS', 'ROBINHOOD_RPC_URL'],
  ];
  for (const [listKey, legacyKey] of mappings) {
    const explicit = splitUrls(env[listKey]).filter((endpoint) => !isErpcLoop(endpoint, env));
    const legacy = splitUrls(env[legacyKey]).filter((endpoint) => !isErpcLoop(endpoint, env));
    if (explicit.length) next[listKey] = explicit.join(',');
    else if (legacy.length) next[listKey] = legacy.join(',');
    else delete next[listKey];
    delete next[legacyKey];
  }
  delete next.ERPC_BASE_URL;
  return next;
}

export async function rpcProbe(chainId, env = process.env, timeoutMs = 12_000) {
  const endpoint = erpcRpcUrl(chainId, env);
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify([
      {jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: []},
      {jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: []},
    ]),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body)) throw new Error(`eRPC probe HTTP ${response.status}`);
  const byId = new Map(body.map((item) => [item.id, item]));
  const returnedChainId = Number.parseInt(byId.get(1)?.result, 16);
  const blockNumber = Number.parseInt(byId.get(2)?.result, 16);
  if (returnedChainId !== chainId || !Number.isSafeInteger(blockNumber)) {
    throw new Error(`eRPC probe mismatch for chain ${chainId}`);
  }
  return {endpoint, chainId: returnedChainId, blockNumber, latencyMs: Math.round(performance.now() - started)};
}

export async function waitForErpc(env = process.env, {attempts = 90, delayMs = 500} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [ethereum, robinhood] = await Promise.all([rpcProbe(1, env), rpcProbe(4663, env)]);
      return {ethereum, robinhood};
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error('eRPC health check timed out');
}

export function spawnErpc(binaryPath, env = process.env, stdio = 'inherit') {
  return spawn(binaryPath, ['start', '--require-config', '--config', ERPC_CONFIG_PATH], {
    // eRPC automatically parses a .env from its working directory. The project
    // .env intentionally contains bare wallet-key lines, so run eRPC inside its
    // private runtime directory and pass only the prepared environment values.
    cwd: RUNTIME_DIR,
    env: erpcProcessEnv(env),
    stdio,
  });
}

export function applicationRpcEnv(env = process.env) {
  const next = {
    ...env,
    ERPC_BASE_URL: erpcBaseUrl(env),
    ETHEREUM_RPC_URL: erpcRpcUrl(1, env),
    ROBINHOOD_RPC_URL: erpcRpcUrl(4663, env),
  };
  for (const [listKey, legacyKey] of [
    ['ETHEREUM_RPC_UPSTREAMS', 'ETHEREUM_RPC_URL'],
    ['ROBINHOOD_RPC_UPSTREAMS', 'ROBINHOOD_RPC_URL'],
  ]) {
    const explicit = splitUrls(env[listKey]).filter((endpoint) => !isErpcLoop(endpoint, env));
    const legacy = splitUrls(env[legacyKey]).filter((endpoint) => !isErpcLoop(endpoint, env));
    if (explicit.length) next[listKey] = explicit.join(',');
    else if (legacy.length) next[listKey] = legacy.join(',');
  }
  return next;
}

export function terminateChild(child, signal = 'SIGTERM') {
  if (child && child.exitCode == null && !child.killed) child.kill(signal);
}

export {BINARY_PATH, METADATA_PATH, ROOT, RUNTIME_DIR};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureErpcBinary({force: process.argv.includes('--force')})
    .then((binaryPath) => console.log(`eRPC ${ERPC_VERSION} ready: ${binaryPath}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
