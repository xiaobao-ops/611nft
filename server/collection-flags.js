const FLAGS = new Set(["scam", "blocked", "watch"])

function chainId(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("链编号无效")
  return parsed
}

function address(value) {
  const parsed = String(value || "").toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(parsed)) throw new Error("合集地址无效")
  return parsed
}

function flag(value) {
  const parsed = String(value || "").toLowerCase()
  if (!FLAGS.has(parsed)) throw new Error("合集标记无效")
  return parsed
}

function note(value) {
  const parsed = String(value || "").trim()
  if (parsed.length > 500) throw new Error("合集标记备注不能超过 500 个字符")
  return parsed
}

function hydrate(row) {
  if (!row) return null
  return {
    chainId: Number(row.chain_id),
    address: row.address,
    flag: row.flag,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function migrateCollectionFlags(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_flags (
      chain_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      flag TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, address)
    );
    CREATE INDEX IF NOT EXISTS idx_collection_flags_chain_flag
      ON collection_flags(chain_id, flag, updated_at DESC);
  `)
}

export function createCollectionFlagStore({ db, now = Date.now } = {}) {
  if (!db) throw new Error("合集标记需要数据库")
  migrateCollectionFlags(db)

  function get(rawChainId, rawAddress) {
    return hydrate(db.prepare("SELECT * FROM collection_flags WHERE chain_id = ? AND address = ?")
      .get(chainId(rawChainId), address(rawAddress)))
  }

  function list({ chainId: rawChainId, flag: rawFlag } = {}) {
    const id = chainId(rawChainId)
    const rows = rawFlag
      ? db.prepare("SELECT * FROM collection_flags WHERE chain_id = ? AND flag = ? ORDER BY updated_at DESC").all(id, flag(rawFlag))
      : db.prepare("SELECT * FROM collection_flags WHERE chain_id = ? ORDER BY updated_at DESC").all(id)
    return { flags: rows.map(hydrate) }
  }

  function upsert(input = {}) {
    const id = chainId(input.chainId)
    const contract = address(input.address)
    const value = flag(input.flag || "scam")
    const annotation = note(input.note)
    const at = new Date(now()).toISOString()
    db.prepare(`
      INSERT INTO collection_flags (chain_id, address, flag, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, address) DO UPDATE SET
        flag = excluded.flag,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run(id, contract, value, annotation, at, at)
    return get(id, contract)
  }

  function remove(rawChainId, rawAddress) {
    return db.prepare("DELETE FROM collection_flags WHERE chain_id = ? AND address = ?")
      .run(chainId(rawChainId), address(rawAddress)).changes > 0
  }

  function blocksExecution(rawChainId, rawAddress) {
    const value = get(rawChainId, rawAddress)
    return Boolean(value && ["scam", "blocked"].includes(value.flag))
  }

  return { get, list, upsert, remove, blocksExecution }
}
