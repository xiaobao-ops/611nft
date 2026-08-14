import { readFile } from 'node:fs/promises';

import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';

const PRIVATE_KEY_RE = /0x[0-9a-fA-F]{64}/g;

// Derive `count` sequential BIP-44 accounts from one mnemonic so 50 wallets can
// be managed from a single backed-up phrase. Each entry keeps its index and HD
// path for auditable per-wallet logging; the raw wallet stays in memory only.
export function deriveWallets({ mnemonic, count, pathBase, provider }) {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('count must be a positive integer');
  }

  let phrase;
  try {
    phrase = Mnemonic.fromPhrase(mnemonic);
  } catch (error) {
    throw new Error('invalid mnemonic phrase', { cause: error });
  }

  const wallets = [];
  for (let index = 0; index < count; index += 1) {
    const hdPath = `${pathBase}/${index}`;
    let wallet = HDNodeWallet.fromMnemonic(phrase, hdPath);
    if (provider) wallet = wallet.connect(provider);
    wallets.push({ index, address: wallet.address, wallet, hdPath });
  }
  return wallets;
}

export function parsePrivateKeyList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line, index) => {
      const matches = line.match(PRIVATE_KEY_RE) || [];
      if (matches.length !== 1) {
        throw new Error(`wallet key line ${index + 1} must contain exactly one private key`);
      }
      const [privateKey] = matches;
      const label = line
        .slice(0, line.indexOf(privateKey))
        .replace(/[=,:\s]+$/g, '')
        .trim();
      return Object.freeze({ label, privateKey });
    });
}

export async function loadPrivateKeyWallets({ filePath, count, provider }) {
  if (!filePath) throw new Error('private key wallet file is required');
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('count must be a positive integer');
  }

  const entries = parsePrivateKeyList(await readFile(filePath, 'utf8'));
  if (entries.length !== count) {
    throw new Error(`expected exactly ${count} private keys, found ${entries.length}`);
  }

  const seen = new Set();
  return entries.map(({ privateKey, label }, index) => {
    let wallet;
    try {
      wallet = new Wallet(privateKey, provider);
    } catch (error) {
      throw new Error(`invalid private key at wallet key line ${index + 1}`, { cause: error });
    }
    const normalized = wallet.address.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`duplicate wallet address at wallet key line ${index + 1}`);
    }
    seen.add(normalized);
    return { index, address: wallet.address, wallet, label };
  });
}
