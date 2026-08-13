import 'dotenv/config';
import {spawn} from 'node:child_process';
import {ERPC_CONFIG_PATH, RUNTIME_DIR, ensureErpcBinary} from './erpc-runtime.mjs';

const binary = await ensureErpcBinary();
const child = spawn(binary, ['validate', '--format', 'json', '--config', ERPC_CONFIG_PATH], {
  cwd: RUNTIME_DIR,
  env: process.env,
  stdio: 'inherit',
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
