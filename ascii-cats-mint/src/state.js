import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXISTING_STATE_ERROR = 'mint state already exists; manual inspection required';
const UNREADABLE_STATE_ERROR = 'mint state is unreadable; manual inspection required';

async function loadState(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(UNREADABLE_STATE_ERROR, { cause: error });
  }
}

export function createStateStore(path) {
  const tempPath = `${path}.tmp`;

  return Object.freeze({
    async load() {
      return loadState(path);
    },

    async reservePrepared({ wallet }) {
      let handle;
      try {
        handle = await open(path, 'wx');
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error(EXISTING_STATE_ERROR);
        throw error;
      }

      const state = {
        status: 'prepared',
        wallet,
        preparedAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
    },

    async markTicketRequested({ wallet }) {
      const prepared = await loadState(path);
      if (
        prepared?.status !== 'prepared' ||
        String(prepared.wallet).toLowerCase() !== wallet.toLowerCase()
      ) {
        throw new Error('prepared mint state missing or mismatched; manual inspection required');
      }

      const state = {
        status: 'ticket-requested',
        wallet,
        ticketRequestedAt: new Date().toISOString(),
      };

      try {
        await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await rename(tempPath, path);
      } catch (error) {
        try {
          await unlink(tempPath);
        } catch {
          // The prepared primary state remains the fail-closed recovery marker.
        }
        throw error;
      }
    },

    async saveSubmitted({ txHash, wallet }) {
      const submittable = await loadState(path);
      if (
        !['ticket-requested', 'submitted'].includes(submittable?.status) ||
        String(submittable.wallet).toLowerCase() !== wallet.toLowerCase()
      ) {
        throw new Error(
          'submittable mint state missing or mismatched; manual inspection required',
        );
      }

      const state = {
        status: 'submitted',
        txHash,
        wallet,
        submittedAt: new Date().toISOString(),
      };

      try {
        await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await rename(tempPath, path);
      } catch (error) {
        try {
          await unlink(tempPath);
        } catch {
          // The ticket-requested primary state remains the fail-closed marker.
        }
        throw error;
      }
    },

    async clear() {
      try {
        await unlink(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  });
}

// One isolated state file per wallet under `dir` (e.g. .mint-state/<addr>.json),
// each reusing the audited prepared→ticket-requested→submitted store. Addresses are lowercased so
// the filename is stable across checksum casing and case-insensitive filesystems.
export async function createWalletStateStores(dir, addresses) {
  await mkdir(dir, { recursive: true });
  return addresses.map((address) =>
    createStateStore(join(dir, `${address.toLowerCase()}.json`)),
  );
}
