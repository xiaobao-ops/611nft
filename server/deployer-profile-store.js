function chainId(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("链编号无效")
  return parsed
}

function address(value) {
  const parsed = String(value || "").toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(parsed)) throw new Error("部署者地址无效")
  return parsed
}

function threshold(value, fallback, label) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}无效`)
  return parsed
}

export function migrateDeployerProfiles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployer_profiles (
      chain_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      profile_json TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, address)
    );
    CREATE INDEX IF NOT EXISTS idx_deployer_profiles_fetched
      ON deployer_profiles(fetched_at);
  `)
}

function profileRisk(profile, nowMs, options) {
  const youngWalletDays = threshold(options?.youngWalletDays, 7, "钱包年龄阈值")
  const projectCountThreshold = threshold(options?.projectCountThreshold, 5, "项目数量阈值")
  const firstSeenMs = Date.parse(profile.firstSeenAt)
  const walletAgeDays = Number.isFinite(firstSeenMs) ? Math.max(0, Math.floor((nowMs - firstSeenMs) / 86400000)) : null
  const nftProjectCount = profile.nftProjectCount === null || profile.nftProjectCount === undefined
    ? null
    : Number(profile.nftProjectCount)
  const reasons = []
  if (walletAgeDays !== null && walletAgeDays < youngWalletDays) reasons.push(`wallet_younger_than_${youngWalletDays}d`)
  if (nftProjectCount !== null && nftProjectCount >= projectCountThreshold) reasons.push(`nft_projects_at_least_${projectCountThreshold}`)
  return { walletAgeDays, risk: { risky: reasons.length > 0, reasons } }
}

function normalizeProfile(value, id, normalizedAddress) {
  if (!value) return null
  return {
    chainId: id,
    address: normalizedAddress,
    firstSeenAt: value.firstSeenAt ? new Date(value.firstSeenAt).toISOString() : null,
    deployedContractCount: value.deployedContractCount === null || value.deployedContractCount === undefined ? null : Number(value.deployedContractCount),
    nftProjectCount: value.nftProjectCount === null || value.nftProjectCount === undefined ? null : Number(value.nftProjectCount),
  }
}

export function createDeployerProfileStore({ db, fetchProfile, ttlMs = 86400000, now = Date.now } = {}) {
  if (!db) throw new Error("部署者画像需要数据库")
  if (typeof fetchProfile !== "function") throw new Error("部署者画像需要抓取函数")
  migrateDeployerProfiles(db)
  const requests = new Map()

  function cached(id, normalizedAddress) {
    return db.prepare("SELECT profile_json, fetched_at FROM deployer_profiles WHERE chain_id = ? AND address = ?")
      .get(id, normalizedAddress)
  }

  function present(row, options) {
    if (!row?.profile_json) return null
    const value = JSON.parse(row.profile_json)
    return { ...value, fetchedAt: row.fetched_at, ...profileRisk(value, Number(now()), options) }
  }

  async function get(rawChainId, rawAddress, options = {}) {
    const id = chainId(rawChainId)
    const normalizedAddress = address(rawAddress)
    const key = `${id}:${normalizedAddress}`
    const row = cached(id, normalizedAddress)
    if (row && Number(now()) - Date.parse(row.fetched_at) <= ttlMs) return present(row, options)
    if (requests.has(key)) {
      await requests.get(key)
      return present(cached(id, normalizedAddress), options)
    }
    const request = (async () => {
      let value = null
      try {
        value = normalizeProfile(await fetchProfile(id, normalizedAddress), id, normalizedAddress)
      } catch {
        value = null
      }
      const fetchedAt = new Date(now()).toISOString()
      db.prepare(`
        INSERT INTO deployer_profiles (chain_id, address, profile_json, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chain_id, address) DO UPDATE SET
          profile_json = excluded.profile_json,
          fetched_at = excluded.fetched_at
      `).run(id, normalizedAddress, value ? JSON.stringify(value) : null, fetchedAt)
    })().finally(() => requests.delete(key))
    requests.set(key, request)
    await request
    return present(cached(id, normalizedAddress), options)
  }

  function invalidate(rawChainId, rawAddress) {
    return db.prepare("DELETE FROM deployer_profiles WHERE chain_id = ? AND address = ?")
      .run(chainId(rawChainId), address(rawAddress)).changes > 0
  }

  return { get, invalidate }
}
