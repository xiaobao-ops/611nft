import { decodeEventLog } from "viem"

const PUBLIC_DROP_COMPONENTS = [
  { name: "mintPrice", type: "uint80" },
  { name: "startTime", type: "uint48" },
  { name: "endTime", type: "uint48" },
  { name: "maxTotalMintableByWallet", type: "uint16" },
  { name: "feeBps", type: "uint16" },
  { name: "restrictFeeRecipients", type: "bool" },
]

const SIGNED_VALIDATION_COMPONENTS = [
  { name: "minMintPrice", type: "uint80" },
  { name: "maxMaxTotalMintableByWallet", type: "uint24" },
  { name: "minStartTime", type: "uint40" },
  { name: "maxEndTime", type: "uint40" },
  { name: "maxMaxTokenSupplyForStage", type: "uint40" },
  { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" },
]

export const SEADROP_EVENTS_ABI = [
  {
    type: "event",
    name: "PublicDropUpdated",
    inputs: [
      { name: "nftContract", type: "address", indexed: true },
      { name: "publicDrop", type: "tuple", indexed: false, components: PUBLIC_DROP_COMPONENTS },
    ],
  },
  {
    type: "event",
    name: "AllowListUpdated",
    inputs: [
      { name: "nftContract", type: "address", indexed: true },
      { name: "previousMerkleRoot", type: "bytes32", indexed: true },
      { name: "newMerkleRoot", type: "bytes32", indexed: true },
      { name: "publicKeyURIs", type: "string[]", indexed: false },
      { name: "allowListURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SignedMintValidationParamsUpdated",
    inputs: [
      { name: "nftContract", type: "address", indexed: true },
      { name: "signer", type: "address", indexed: true },
      { name: "signedMintValidationParams", type: "tuple", indexed: false, components: SIGNED_VALIDATION_COMPONENTS },
    ],
  },
]

export const SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS = Object.freeze({
  1: 50_400,
  8453: 302_400,
  42161: 2_419_200,
  10: 302_400,
  137: 302_400,
  56: 201_600,
  4663: 302_400,
})

export function resolveSeaDropLookbackBlocks(chainId, overrides = {}) {
  const fallback = SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS[Number(chainId)] || SEADROP_SEVEN_DAY_LOOKBACK_BLOCKS[1]
  const configured = Number(overrides?.[Number(chainId)])
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback
}

function jsonValue(value) {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  return value
}

function normalizedAddress(value) {
  const result = String(value || "").toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(result) ? result : ""
}

function integerString(value) {
  if (value === null || value === undefined || value === "") return null
  try {
    return BigInt(value).toString()
  } catch {
    return null
  }
}

function isoFromSeconds(value) {
  const seconds = Number(value || 0)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function normalizedIso(value) {
  if (!value) return null
  const timestamp = Date.parse(String(value))
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function decodedLog(log) {
  if (log?.eventName && log?.args) return log
  try {
    const decoded = decodeEventLog({ abi: SEADROP_EVENTS_ABI, data: log?.data || "0x", topics: log?.topics || [], strict: true })
    return { ...log, ...decoded }
  } catch {
    return null
  }
}

function baseStage(chainId, log, args, stageType, stageKey) {
  const contract = normalizedAddress(args.nftContract)
  const dropAddress = normalizedAddress(log.address)
  const txHash = String(log.transactionHash || log.transaction_hash || "").toLowerCase()
  const logIndex = Number(log.logIndex ?? log.log_index ?? 0)
  if (!contract || !dropAddress || !/^0x[a-f0-9]{64}$/.test(txHash) || !Number.isSafeInteger(logIndex)) return null
  return {
    id: `${Number(chainId)}:${contract}:${stageKey}`,
    chainId: Number(chainId),
    contract,
    dropAddress,
    stageType,
    stageKey,
    label: ({ public: "公开", signed: "签名", allowlist: "白名单" })[stageType] || stageType,
    priceWei: null,
    startTime: null,
    endTime: null,
    maxPerWallet: null,
    maxSupplyForStage: null,
    feeBps: null,
    signer: "",
    merkleRoot: "",
    allowListUri: "",
    requiresCredentials: stageType !== "public",
    source: "seadrop_event",
    transactionHash: txHash,
    blockNumber: integerString(log.blockNumber) || "0",
    logIndex,
    removed: Boolean(log.removed),
  }
}

export function normalizeSeaDropLog(chainId, rawLog) {
  const log = decodedLog(rawLog)
  if (!log) return null
  const args = log.args || {}
  if (log.eventName === "PublicDropUpdated") {
    const stage = baseStage(chainId, log, args, "public", "public")
    if (!stage) return null
    const value = args.publicDrop || {}
    return {
      ...stage,
      priceWei: integerString(value.mintPrice ?? value[0]),
      startTime: isoFromSeconds(value.startTime ?? value[1]),
      endTime: isoFromSeconds(value.endTime ?? value[2]),
      maxPerWallet: integerString(value.maxTotalMintableByWallet ?? value[3]),
      feeBps: integerString(value.feeBps ?? value[4]),
    }
  }
  if (log.eventName === "SignedMintValidationParamsUpdated") {
    const signer = normalizedAddress(args.signer)
    const stage = baseStage(chainId, log, args, "signed", `signed:${signer}`)
    if (!stage || !signer) return null
    const value = args.signedMintValidationParams || {}
    return {
      ...stage,
      priceWei: integerString(value.minMintPrice ?? value[0]),
      startTime: isoFromSeconds(value.minStartTime ?? value[2]),
      endTime: isoFromSeconds(value.maxEndTime ?? value[3]),
      maxPerWallet: integerString(value.maxMaxTotalMintableByWallet ?? value[1]),
      maxSupplyForStage: integerString(value.maxMaxTokenSupplyForStage ?? value[4]),
      feeBps: integerString(value.maxFeeBps ?? value[6]),
      signer,
    }
  }
  if (log.eventName === "AllowListUpdated") {
    const stage = baseStage(chainId, log, args, "allowlist", "allowlist")
    if (!stage) return null
    return {
      ...stage,
      merkleRoot: String(args.newMerkleRoot || "").toLowerCase(),
      allowListUri: String(args.allowListURI || ""),
    }
  }
  return null
}

export function migrateSeaDropRadar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seadrop_drop_logs (
      chain_id INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      contract TEXT NOT NULL,
      block_number TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_seadrop_drop_logs_stage
      ON seadrop_drop_logs(chain_id, contract, stage_key, block_number);
    CREATE TABLE IF NOT EXISTS seadrop_drops (
      chain_id INTEGER NOT NULL,
      contract TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, contract, stage_key)
    );
    CREATE TABLE IF NOT EXISTS seadrop_checkpoints (
      chain_id INTEGER PRIMARY KEY,
      block_number TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function compareBlocks(left, right) {
  const blockDelta = BigInt(left.blockNumber || 0) - BigInt(right.blockNumber || 0)
  if (blockDelta !== 0n) return blockDelta > 0n ? -1 : 1
  return Number(right.logIndex || 0) - Number(left.logIndex || 0)
}

export function createSeaDropRadar({ db, now = Date.now, lookbackBlocksByChain = {} } = {}) {
  if (!db) throw new Error("SeaDrop 雷达需要数据库")
  migrateSeaDropRadar(db)
  const listeners = new Set()

  function reconcile(chainId, contract, stageKey) {
    const rows = db.prepare("SELECT payload_json FROM seadrop_drop_logs WHERE chain_id = ? AND contract = ? AND stage_key = ?").all(chainId, contract, stageKey)
    const latest = rows.map((row) => JSON.parse(row.payload_json)).sort(compareBlocks)[0]
    if (!latest) {
      db.prepare("DELETE FROM seadrop_drops WHERE chain_id = ? AND contract = ? AND stage_key = ?").run(chainId, contract, stageKey)
      return
    }
    const existing = db.prepare("SELECT name, image FROM seadrop_drops WHERE chain_id = ? AND contract = ? AND stage_key = ?").get(chainId, contract, stageKey)
    db.prepare(`
      INSERT INTO seadrop_drops (chain_id, contract, stage_key, payload_json, name, image, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, contract, stage_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(chainId, contract, stageKey, JSON.stringify(latest), existing?.name || "", existing?.image || "", new Date(now()).toISOString())
  }

  function ingest(chainId, logs) {
    let changed = 0
    let removed = 0
    for (const log of logs || []) {
      const stage = normalizeSeaDropLog(chainId, log)
      if (!stage) continue
      if (stage.removed) {
        const result = db.prepare("DELETE FROM seadrop_drop_logs WHERE chain_id = ? AND tx_hash = ? AND log_index = ?")
          .run(stage.chainId, stage.transactionHash, stage.logIndex)
        if (result.changes) {
          removed += 1
          reconcile(stage.chainId, stage.contract, stage.stageKey)
        }
        continue
      }
      const createdAt = new Date(now()).toISOString()
      const result = db.prepare(`
        INSERT OR IGNORE INTO seadrop_drop_logs
          (chain_id, tx_hash, log_index, stage_key, contract, block_number, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(stage.chainId, stage.transactionHash, stage.logIndex, stage.stageKey, stage.contract, stage.blockNumber, JSON.stringify(jsonValue(stage)), createdAt)
      if (!result.changes) continue
      changed += 1
      reconcile(stage.chainId, stage.contract, stage.stageKey)
    }
    if (changed || removed) {
      const snapshot = list({ chainId, includeUnscheduled: true })
      for (const listener of listeners) listener({ type: "seadrop_radar", chainId: Number(chainId), ...snapshot })
    }
    return { changed, removed }
  }

  function list({ chainId, horizonSeconds = 7 * 86400, includeUnscheduled = false, price = "all", liveOnly = false, publicOnly = false } = {}) {
    const current = Number(now())
    const horizon = current + Number(horizonSeconds) * 1000
    const rows = db.prepare("SELECT payload_json, name, image, updated_at FROM seadrop_drops WHERE chain_id = ?").all(Number(chainId))
    const drops = rows.map((row) => {
      const item = JSON.parse(row.payload_json)
      return {
        ...item,
        startTime: normalizedIso(item.startTime),
        endTime: normalizedIso(item.endTime),
        name: row.name || "",
        image: row.image || "",
        updatedAt: row.updated_at,
      }
    }).filter((item) => {
      const starts = item.startTime ? Date.parse(item.startTime) : null
      const ends = item.endTime ? Date.parse(item.endTime) : null
      if (!includeUnscheduled && starts === null) return false
      if (starts !== null && starts > horizon) return false
      if (ends !== null && ends < current) return false
      if (price === "free" && item.priceWei !== "0") return false
      if (price === "paid" && (item.priceWei === null || BigInt(item.priceWei) <= 0n)) return false
      if (liveOnly && !(starts !== null && starts <= current && (ends === null || ends >= current))) return false
      if (publicOnly && item.stageType !== "public") return false
      return true
    }).sort((left, right) => {
      if (!left.startTime) return 1
      if (!right.startTime) return -1
      return Date.parse(left.startTime) - Date.parse(right.startTime) || left.contract.localeCompare(right.contract)
    })
    const latest = drops.reduce((value, item) => value > String(item.updatedAt || "") ? value : String(item.updatedAt || ""), "")
    return { snapshotId: `${Number(chainId)}:${latest || "empty"}`, drops }
  }

  function enrich({ chainId, contract, name = "", image = "" }) {
    const normalized = normalizedAddress(contract)
    if (!normalized) throw new Error("合集地址无效")
    const nextName = String(name).slice(0, 240)
    const nextImage = String(image).slice(0, 2000)
    if (!nextName && !nextImage) return 0
    const result = db.prepare(`
      UPDATE seadrop_drops SET
        name = CASE WHEN ? <> '' THEN ? ELSE name END,
        image = CASE WHEN ? <> '' THEN ? ELSE image END,
        updated_at = ?
      WHERE chain_id = ? AND contract = ?
        AND ((? <> '' AND name <> ?) OR (? <> '' AND image <> ?))
    `).run(
      nextName, nextName, nextImage, nextImage, new Date(now()).toISOString(), Number(chainId), normalized,
      nextName, nextName, nextImage, nextImage,
    )
    if (result.changes) {
      const snapshot = list({ chainId, includeUnscheduled: true })
      for (const listener of listeners) listener({ type: "seadrop_radar", chainId: Number(chainId), ...snapshot })
    }
    return result.changes
  }

  function checkpoint(chainId) {
    return db.prepare("SELECT block_number FROM seadrop_checkpoints WHERE chain_id = ?").get(Number(chainId))?.block_number || null
  }

  async function scan({ chainId, client, dropAddresses, fromBlock, toBlock, maxBlocksPerRequest = 5000 } = {}) {
    const latest = toBlock === undefined ? await client.getBlockNumber() : BigInt(toBlock)
    const saved = checkpoint(chainId)
    const lookback = BigInt(resolveSeaDropLookbackBlocks(chainId, lookbackBlocksByChain))
    const start = fromBlock !== undefined ? BigInt(fromBlock) : saved !== null ? BigInt(saved) + 1n : latest > lookback ? latest - lookback : 0n
    if (start > latest) return { fromBlock: start.toString(), toBlock: latest.toString(), checkpoint: saved, changed: 0, removed: 0 }
    const addresses = [...new Set((dropAddresses || []).map(normalizedAddress).filter(Boolean))]
    if (!addresses.length) throw new Error("SeaDrop 合约地址未配置")
    const chunkSize = Number(maxBlocksPerRequest)
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 100_000) throw new Error("SeaDrop 扫描分块无效")
    let cursor = start
    let changed = 0
    let removed = 0
    let completed = saved
    while (cursor <= latest) {
      const chunkEnd = cursor + BigInt(chunkSize) - 1n < latest ? cursor + BigInt(chunkSize) - 1n : latest
      const logs = await client.getLogs({
        address: addresses.length === 1 ? addresses[0] : addresses,
        events: SEADROP_EVENTS_ABI,
        fromBlock: cursor,
        toBlock: chunkEnd,
      })
      const outcome = ingest(chainId, logs)
      changed += outcome.changed
      removed += outcome.removed
      completed = chunkEnd.toString()
      const updatedAt = new Date(now()).toISOString()
      db.prepare(`
        INSERT INTO seadrop_checkpoints (chain_id, block_number, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(chain_id) DO UPDATE SET block_number = excluded.block_number, updated_at = excluded.updated_at
      `).run(Number(chainId), completed, updatedAt)
      cursor = chunkEnd + 1n
    }
    return { fromBlock: start.toString(), toBlock: latest.toString(), checkpoint: completed, changed, removed }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { ingest, list, enrich, scan, checkpoint, subscribe }
}
