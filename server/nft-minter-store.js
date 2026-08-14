const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

function normalizeAddress(value) {
  const address = String(value || "").toLowerCase()
  return ADDRESS_PATTERN.test(address) ? address : null
}

function parsePage(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function migrateNftMinterStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_mint_minters (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      minter_address TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, contract_address, minter_address)
    );
    CREATE TABLE IF NOT EXISTS nft_minter_backfill (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      next_page_json TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT NOT NULL DEFAULT '',
      pages_scanned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, contract_address)
    );
    UPDATE nft_minter_backfill
    SET next_page_json = '', status = 'pending', error = '', pages_scanned = 0
    WHERE next_page_json LIKE '%"event_index"%';
  `)
}

export function createNftMinterStore(db) {
  migrateNftMinterStore(db)

  const ensureStatement = db.prepare(`
    INSERT OR IGNORE INTO nft_minter_backfill
      (chain_id, contract_address, next_page_json, status, error, pages_scanned, updated_at)
    VALUES (?, ?, '', 'pending', '', 0, ?)
  `)
  const insertMinterStatement = db.prepare(`
    INSERT OR IGNORE INTO nft_mint_minters
      (chain_id, contract_address, minter_address, discovered_at)
    VALUES (?, ?, ?, ?)
  `)
  const progressStatement = db.prepare(`
    SELECT status, error, next_page_json, pages_scanned, updated_at
    FROM nft_minter_backfill
    WHERE chain_id = ? AND contract_address = ?
  `)
  const snapshotStatement = db.prepare(`
    SELECT
      backfill.status,
      backfill.error,
      backfill.pages_scanned,
      backfill.updated_at,
      (
        SELECT COUNT(*)
        FROM nft_mint_minters AS minters
        WHERE minters.chain_id = backfill.chain_id
          AND minters.contract_address = backfill.contract_address
      ) AS unique_minter_count
    FROM nft_minter_backfill AS backfill
    WHERE backfill.chain_id = ? AND backfill.contract_address = ?
  `)
  const markLoadingStatement = db.prepare(`
    UPDATE nft_minter_backfill
    SET status = 'loading', error = '', updated_at = ?
    WHERE chain_id = ? AND contract_address = ? AND status <> 'complete'
  `)
  const markErrorStatement = db.prepare(`
    UPDATE nft_minter_backfill
    SET status = 'error', error = ?, updated_at = ?
    WHERE chain_id = ? AND contract_address = ? AND status <> 'complete'
  `)
  const savePageStatement = db.prepare(`
    UPDATE nft_minter_backfill
    SET next_page_json = ?, status = ?, error = '', pages_scanned = pages_scanned + 1, updated_at = ?
    WHERE chain_id = ? AND contract_address = ?
  `)

  function keyParts(chainId, contractAddress) {
    const address = normalizeAddress(contractAddress)
    if (!address) throw new Error(`Invalid NFT contract address: ${contractAddress}`)
    return [Number(chainId), address]
  }

  function ensure(chainId, contractAddress) {
    const [id, address] = keyParts(chainId, contractAddress)
    ensureStatement.run(id, address, new Date().toISOString())
    return progress(id, address)
  }

  function progress(chainId, contractAddress) {
    const [id, address] = keyParts(chainId, contractAddress)
    const row = progressStatement.get(id, address)
    if (!row) return null
    return {
      status: row.status,
      error: row.error || "",
      nextPageParams: parsePage(row.next_page_json),
      pagesScanned: Number(row.pages_scanned || 0),
      updatedAt: row.updated_at,
    }
  }

  function snapshot(chainId, contractAddress) {
    const [id, address] = keyParts(chainId, contractAddress)
    ensureStatement.run(id, address, new Date().toISOString())
    const row = snapshotStatement.get(id, address)
    return {
      count: Number(row?.unique_minter_count || 0),
      status: row?.status || "pending",
      error: row?.error || "",
      pagesScanned: Number(row?.pages_scanned || 0),
      updatedAt: row?.updated_at || null,
    }
  }

  function recordMinter(chainId, contractAddress, minterAddress) {
    const [id, address] = keyParts(chainId, contractAddress)
    const minter = normalizeAddress(minterAddress)
    if (!minter) return snapshot(id, address)
    const updatedAt = new Date().toISOString()
    ensureStatement.run(id, address, updatedAt)
    insertMinterStatement.run(id, address, minter, updatedAt)
    return snapshot(id, address)
  }

  function markLoading(chainId, contractAddress) {
    const [id, address] = keyParts(chainId, contractAddress)
    ensureStatement.run(id, address, new Date().toISOString())
    markLoadingStatement.run(new Date().toISOString(), id, address)
    return snapshot(id, address)
  }

  function markError(chainId, contractAddress, error) {
    const [id, address] = keyParts(chainId, contractAddress)
    ensureStatement.run(id, address, new Date().toISOString())
    markErrorStatement.run(String(error || "Historical minter backfill failed").slice(0, 500), new Date().toISOString(), id, address)
    return snapshot(id, address)
  }

  function savePage(chainId, contractAddress, minters, nextPageParams) {
    const [id, address] = keyParts(chainId, contractAddress)
    const updatedAt = new Date().toISOString()
    const normalizedMinters = [...new Set((minters || []).map(normalizeAddress).filter(Boolean))]
    const complete = !nextPageParams || typeof nextPageParams !== "object" || !Object.keys(nextPageParams).length
    db.exec("BEGIN IMMEDIATE")
    try {
      ensureStatement.run(id, address, updatedAt)
      for (const minter of normalizedMinters) insertMinterStatement.run(id, address, minter, updatedAt)
      savePageStatement.run(complete ? "" : JSON.stringify(nextPageParams), complete ? "complete" : "loading", updatedAt, id, address)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    return snapshot(id, address)
  }

  return { ensure, markError, markLoading, progress, recordMinter, savePage, snapshot }
}
