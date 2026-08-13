import 'dotenv/config';
import {spawn} from 'node:child_process';
import {
  ROOT,
  applicationRpcEnv,
  ensureErpcBinary,
  rpcProbe,
  spawnErpc,
  terminateChild,
  waitForErpc,
} from './erpc-runtime.mjs';

const env = applicationRpcEnv(process.env);
let erpcChild = null;
let appChild = null;
let stopping = false;

try {
  await Promise.all([rpcProbe(1, env, 1500), rpcProbe(4663, env, 1500)]);
  console.log('Using the healthy eRPC instance already running on the configured port.');
} catch {
  const binary = await ensureErpcBinary();
  erpcChild = spawnErpc(binary, env);
  erpcChild.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`eRPC exited with ${code ?? signal}`);
      terminateChild(appChild);
      process.exitCode = code || 1;
    }
  });
}

const status = await waitForErpc(env);
console.log(`RPC pool ready: Ethereum #${status.ethereum.blockNumber}, Robinhood #${status.robinhood.blockNumber}`);
appChild = spawn(process.execPath, ['server/index.mjs'], {cwd: ROOT, env, stdio: 'inherit'});

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  terminateChild(appChild, signal);
  terminateChild(erpcChild, signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
appChild.once('error', (error) => {
  console.error(error);
  stop();
  process.exitCode = 1;
});
appChild.once('exit', (code, signal) => {
  stop();
  process.exitCode = code ?? (signal ? 1 : 0);
});
