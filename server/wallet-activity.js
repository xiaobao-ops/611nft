function positiveChainId(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("链编号无效")
  return parsed
}

function normalizedAddress(value) {
  const parsed = String(value || "").toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(parsed) ? parsed : ""
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).split("\n").find(Boolean)?.slice(0, 240) || "钱包活动观察失败"
}

function transactionHash(value) {
  const parsed = String(value || "").toLowerCase()
  return /^0x[a-f0-9]{64}$/.test(parsed) ? parsed : ""
}

export function createWalletActivityMonitor({
  getClient,
  getWatchedAddresses,
  onActivity = () => {},
  maxGapBlocks = 20,
  maxSeenTransactions = 5000,
} = {}) {
  if (typeof getClient !== "function") throw new TypeError("钱包活动观察器需要 RPC 客户端")
  if (typeof getWatchedAddresses !== "function") throw new TypeError("钱包活动观察器需要关注地址来源")
  const states = new Map()
  let stopped = false

  function stateFor(chainId) {
    const id = positiveChainId(chainId)
    if (!states.has(id)) {
      states.set(id, {
        state: "idle",
        lastObservedBlock: null,
        latestRequestedBlock: null,
        observedBlocks: 0,
        matchedTransactions: 0,
        seenTransactions: new Set(),
        seenQueue: [],
        lastError: "",
        promise: null,
      })
    }
    return states.get(id)
  }

  function remember(state, hash) {
    if (state.seenTransactions.has(hash)) return false
    state.seenTransactions.add(hash)
    state.seenQueue.push(hash)
    while (state.seenQueue.length > maxSeenTransactions) {
      state.seenTransactions.delete(state.seenQueue.shift())
    }
    return true
  }

  async function watched(chainId) {
    const values = await getWatchedAddresses(chainId)
    return new Set((values || []).map(normalizedAddress).filter(Boolean))
  }

  async function blockNumber(client, value) {
    if (value !== undefined && value !== null && value !== "") return BigInt(value)
    return BigInt(await client.getBlockNumber())
  }

  function activityFrom(transaction, block, chainId, watchedAddresses) {
    if (!transaction || typeof transaction !== "object") return null
    const hash = transactionHash(transaction.hash)
    const from = normalizedAddress(transaction.from)
    const to = normalizedAddress(transaction.to)
    const matches = [...new Set([from, to].filter((address) => watchedAddresses.has(address)))]
    if (!hash || !matches.length) return null
    return {
      id: hash,
      type: "wallet_activity",
      chainId,
      address: matches[0],
      watchedAddresses: matches,
      from,
      to,
      txHash: hash,
      valueWei: transaction.value === null || transaction.value === undefined ? null : BigInt(transaction.value).toString(),
      blockNumber: BigInt(block.number).toString(),
      blockHash: transactionHash(block.hash),
      timestamp: Number(block.timestamp),
    }
  }

  async function observeHead(rawChainId, requestedBlock) {
    const chainId = positiveChainId(rawChainId)
    const state = stateFor(chainId)
    if (stopped) return []
    const watchedAddresses = await watched(chainId)
    if (!watchedAddresses.size) {
      state.state = "idle"
      state.lastError = ""
      return []
    }
    const client = getClient(chainId)
    const target = await blockNumber(client, requestedBlock)
    if (target < 0n) throw new Error("区块号无效")
    if (state.latestRequestedBlock === null || target > state.latestRequestedBlock) state.latestRequestedBlock = target
    if (state.promise) {
      await state.promise
      return []
    }

    const matches = []
    state.promise = (async () => {
      state.state = "observing"
      state.lastError = ""
      while (!stopped && (state.lastObservedBlock === null || state.lastObservedBlock < state.latestRequestedBlock)) {
        let next = state.lastObservedBlock === null ? state.latestRequestedBlock : state.lastObservedBlock + 1n
        const earliest = state.latestRequestedBlock - BigInt(Math.max(1, maxGapBlocks)) + 1n
        if (next < earliest) next = earliest
        const block = await client.getBlock({ blockNumber: next, includeTransactions: true })
        for (const transaction of block.transactions || []) {
          const activity = activityFrom(transaction, block, chainId, watchedAddresses)
          if (!activity || !remember(state, activity.txHash)) continue
          matches.push(activity)
          state.matchedTransactions += 1
          await onActivity(activity)
        }
        state.lastObservedBlock = next
        state.observedBlocks += 1
      }
      state.state = stopped ? "stopped" : "active"
    })().catch((error) => {
      state.state = "degraded"
      state.lastError = errorMessage(error)
      throw error
    }).finally(() => {
      state.promise = null
    })
    await state.promise
    return matches
  }

  function status(chainId) {
    const state = stateFor(chainId)
    return {
      state: stopped ? "stopped" : state.state,
      lastObservedBlock: state.lastObservedBlock?.toString() || null,
      observedBlocks: state.observedBlocks,
      matchedTransactions: state.matchedTransactions,
      lastError: state.lastError,
    }
  }

  function stop() {
    stopped = true
    for (const state of states.values()) state.state = "stopped"
  }

  return { observeHead, status, stop }
}
