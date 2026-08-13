import 'dotenv/config';
import {spawn} from 'node:child_process';
import {
  ROOT,
  applicationRpcEnv,
  ensureErpcBinary,
  erpcRpcUrl,
  rpcProbe,
  spawnErpc,
  terminateChild,
  waitForErpc,
} from './erpc-runtime.mjs';

const env = applicationRpcEnv(process.env);
const chainId = Number(process.env.CHAIN_ID || 4663);
env.RPC_URL = erpcRpcUrl(chainId, env);
let erpcChild = null;
let mintChild = null;
let stopping = false;

try {
  await rpcProbe(chainId, env, 1500);
} catch {
  const binary = await ensureErpcBinary();
  erpcChild = spawnErpc(binary, env);
  await waitForErpc(env);
}

mintChild = spawn(process.execPath, ['mint.mjs', ...process.argv.slice(2)], {cwd: ROOT, env, stdio: 'inherit'});

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  terminateChild(mintChild, signal);
  terminateChild(erpcChild, signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
mintChild.once('exit', (code, signal) => {
  stop();
  process.exitCode = code ?? (signal ? 1 : 0);
});
