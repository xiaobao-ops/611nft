import 'dotenv/config';
import {ensureErpcBinary, spawnErpc, terminateChild, waitForErpc} from './erpc-runtime.mjs';

const binary = await ensureErpcBinary();
const child = spawnErpc(binary, process.env);
let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  terminateChild(child, signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (!stopping && code !== 0) console.error(`eRPC exited with ${code ?? signal}`);
  process.exitCode = code ?? (stopping ? 0 : 1);
});

try {
  const status = await waitForErpc();
  console.log(`eRPC ready: Ethereum #${status.ethereum.blockNumber}, Robinhood #${status.robinhood.blockNumber}`);
} catch (error) {
  console.error(`eRPC startup failed: ${error.message}`);
  stop();
  process.exitCode = 1;
}
