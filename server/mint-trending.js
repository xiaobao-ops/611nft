const WINDOWS = new Set([60, 300, 600, 1800, 3600, 21600, 43200, 86400])

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label}无效`)
  return parsed
}

function quantity(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function address(value) {
  const normalized = String(value || "").toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : ""
}

function eventTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed)
}

export function createMintTrending({ now = Date.now, maxEvents = 200_000, maxAgeSeconds = 86400 } = {}) {
  const limitEvents = positiveInteger(maxEvents, "事件容量")
  const retention = Math.max(86400, positiveInteger(maxAgeSeconds, "保留时间"))
  const byChain = new Map()

  function stateFor(chainId) {
    const id = positiveInteger(chainId, "链编号")
    if (!byChain.has(id)) byChain.set(id, { events: [], ids: new Set() })
    return byChain.get(id)
  }

  function prune(state) {
    const cutoff = Math.floor(Number(now()) / 1000) - retention
    if (state.events.length <= limitEvents && (!state.events.length || state.events[0].timestamp >= cutoff)) return
    state.events = state.events.filter((event) => event.timestamp >= cutoff)
    if (state.events.length > limitEvents) state.events = state.events.slice(-limitEvents)
    state.ids = new Set(state.events.map((event) => event.id))
  }

  function ingest(event) {
    if (event?.type !== "mint") return false
    const chainId = positiveInteger(event.chainId, "链编号")
    const contract = address(event.address)
    const id = String(event.id || "")
    const timestamp = eventTimestamp(event.timestamp)
    if (!contract || !id || timestamp === null) return false
    const state = stateFor(chainId)
    if (state.ids.has(id)) return false
    state.ids.add(id)
    state.events.push({
      id,
      chainId,
      address: contract,
      timestamp,
      mintCount: quantity(event.quantity),
      minter: address(event.minter || event.recipient),
      txHash: String(event.txHash || id),
      name: String(event.name || event.tokenName || ""),
      symbol: String(event.symbol || ""),
      tokenStandard: String(event.tokenStandard || ""),
      mintPrice: event.mintPrice ?? null,
      mintValueWei: event.mintValueWei ?? null,
      nativeSymbol: String(event.nativeSymbol || ""),
      imageUrl: event.projectImageUrl || event.imageUrl || "",
      collectionSnapshot: event.collection_snapshot || null,
      floorPriceEth: event.floorPriceEth ?? event.floor_price_eth ?? null,
      lastEvent: event,
    })
    state.events.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    prune(state)
    return true
  }

  function discard(chainId, eventIds) {
    const state = stateFor(chainId)
    const ids = new Set((eventIds || []).map(String))
    if (!ids.size) return 0
    const before = state.events.length
    state.events = state.events.filter((event) => !ids.has(event.id))
    for (const id of ids) state.ids.delete(id)
    return before - state.events.length
  }

  function snapshot({ chainId, window, limit = 20 } = {}) {
    const seconds = positiveInteger(window, "热度窗口")
    if (!WINDOWS.has(seconds)) throw new Error("热度窗口无效")
    const rowLimit = positiveInteger(limit, "返回数量")
    if (rowLimit > 200) throw new Error("返回数量无效")
    const id = positiveInteger(chainId, "链编号")
    const state = stateFor(id)
    prune(state)
    const current = Math.floor(Number(now()) / 1000)
    const cutoff = current - seconds
    const groups = new Map()
    for (const event of state.events) {
      if (event.timestamp < cutoff || event.timestamp > current) continue
      let group = groups.get(event.address)
      if (!group) {
        group = {
          address: event.address,
          mintCount: 0,
          txHashes: new Set(),
          minters: new Set(),
          lastMintAt: 0,
          latest: event,
        }
        groups.set(event.address, group)
      }
      group.mintCount += event.mintCount
      group.txHashes.add(event.txHash)
      if (event.minter) group.minters.add(event.minter)
      if (event.timestamp >= group.lastMintAt) {
        group.lastMintAt = event.timestamp
        group.latest = event
      }
    }
    const collections = [...groups.values()].map((group) => ({
      address: group.address,
      name: group.latest.name,
      symbol: group.latest.symbol,
      tokenStandard: group.latest.tokenStandard,
      mintCount: group.mintCount,
      txCount: group.txHashes.size,
      uniqueMinters: group.minters.size,
      lastMintAt: group.lastMintAt,
      mintPrice: group.latest.mintPrice,
      mintValueWei: group.latest.mintValueWei,
      nativeSymbol: group.latest.nativeSymbol,
      imageUrl: group.latest.imageUrl,
      floorPriceEth: group.latest.floorPriceEth,
      collection_snapshot: group.latest.collectionSnapshot,
      latestEvent: group.latest.lastEvent,
    })).sort((left, right) => (
      right.mintCount - left.mintCount
      || right.txCount - left.txCount
      || right.lastMintAt - left.lastMintAt
      || left.address.localeCompare(right.address)
    )).slice(0, rowLimit).map((row, index) => ({ rank: index + 1, ...row }))
    return {
      type: "trending_snapshot",
      chainId: id,
      window: seconds,
      snapshotId: `${id}:${seconds}:${current}`,
      generatedAt: new Date(current * 1000).toISOString(),
      collections,
    }
  }

  function attach(monitor, chainIds) {
    const unsubscribers = (chainIds || []).map((chainId) => monitor.subscribe(chainId, (event) => {
      if (event?.type === "mint") ingest(event)
      if (event?.type === "discard") discard(chainId, event.eventIds)
    }))
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }

  return { ingest, discard, snapshot, attach }
}
