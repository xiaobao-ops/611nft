import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const BARE_PRIVATE_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

function unquote(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export function extractBarePrivateKeys(text) {
  const keys = [];
  const invalidLines = [];

  for (const [offset, sourceLine] of String(text ?? '').split(/\r?\n/).entries()) {
    const lineNumber = offset + 1;
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Standard dotenv settings, including legacy PRIVATE_KEY*=..., remain valid.
    if (/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;

    const value = unquote(line);
    if (BARE_PRIVATE_KEY_PATTERN.test(value)) keys.push(value);
    else invalidLines.push(lineNumber);
  }

  return {keys, invalidLines};
}

export function loadBarePrivateKeys({env = process.env, envPath} = {}) {
  const configuredPath = env.WALLET_KEYS_FILE?.trim();
  const resolvedPath = path.resolve(envPath || configuredPath || DEFAULT_ENV_PATH);
  try {
    return {...extractBarePrivateKeys(fs.readFileSync(resolvedPath, 'utf8')), path: resolvedPath};
  } catch (error) {
    if (error?.code === 'ENOENT') return {keys: [], invalidLines: [], path: resolvedPath};
    throw error;
  }
}

export function normalizePrivateKey(value, index) {
  const trimmed = String(value ?? '').trim();
  const bare = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!BARE_PRIVATE_KEY_PATTERN.test(bare)) {
    throw new Error(`Private key #${index + 1} must contain exactly 64 hexadecimal characters; 0x is optional for legacy settings.`);
  }
  return `0x${bare}`;
}
