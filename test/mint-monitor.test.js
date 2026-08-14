import assert from "node:assert/strict"
import test from "node:test"
import { createMintMonitor } from "../server/mint-monitor.js"

const collectionAddress = "0x1111111111111111111111111111111111111111"
const recipient = "0x2222222222222222222222222222222222222222"
const minter = "0x3333333333333333333333333333333333333333"
const txHash = `0x${"44".repeat(32)}`

function fakeClient() {
  return {
    async getBlockNumber() { return 1000n },
    async getLogs({ event }) {
      if (event.name !== "Transfer") return []
      return [{
        address: collectionAddress,
        eventName: "Transfer",
        args: {
          from: "0x0000000000000000000000000000000000000000",
          to: recipient,
          tokenId: 7n,
        },
        transactionHash: txHash,
        blockNumber: 999n,
      }]
    },
    async getTransaction() { return { from: minter, value: 100_000_000_000_000_000n } },
    async getTransactionReceipt() { return { gasUsed: 21_000n, effectiveGasPrice: 2_000_000_000n, status: "success" } },
    async getBlock() { return { timestamp: BigInt(Math.floor(Date.now() / 1000)) } },
    async readContract({ functionName, args }) {
      if (functionName === "name") return "Live Cats"
      if (functionName === "symbol") return "LCAT"
      if (functionName === "supportsInterface") return args[0] === "0x80ac58cd"
      if (functionName === "totalSupply") return 77n
      if (functionName === "maxSupply") return 611n
      throw new Error("not supported")
    },
  }
}

function indexedTopic(value) {
  return `0x${value.slice(2).padStart(64, "0")}`
}

function receiptFallbackClient() {
  const client = fakeClient()
  client.getLogs = async () => { throw new Error("Please specify an address") }
  client.request = async ({ method }) => {
    if (method === "eth_getLogs") throw new Error("Please specify an address")
    if (method !== "eth_getBlockReceipts") throw new Error(`unexpected ${method}`)
    return [{
      logs: [{
        address: collectionAddress,
        data: "0x",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          indexedTopic("0x0"),
          indexedTopic(recipient),
          indexedTopic("0x07"),
        ],
        transactionHash: txHash,
        blockNumber: "0x3e7",
      }],
    }]
  }
  return client
}

test("direct RPC fallback turns zero-address NFT transfers into overview and detail", async () => {
  const client = fakeClient()
  const getReceipt = client.getTransactionReceipt
  let receiptCalls = 0
  client.getTransactionReceipt = async (...args) => {
    receiptCalls += 1
    return getReceipt(...args)
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "https://provider.invalid",
    fetchImpl: async () => ({ ok: false, status: 403, async json() { return {} } }),
    autoPoll: false,
  })

  const overview = await monitor.overview(1, 1800)
  assert.equal(overview.source, "direct_rpc")
  assert.match(overview.providerError, /403/)
  assert.equal(overview.windows["1800"].length, 1)
  assert.equal(overview.windows["1800"][0].name, "Live Cats")
  assert.equal(overview.windows["1800"][0].recent_mints, 1)
  assert.equal(overview.windows["1800"][0].recent_mint_preview.length, 1)
  assert.equal(overview.windows["1800"][0].recent_mint_preview[0].tx_hash, txHash)
  assert.equal(overview.windows["1800"][0].recent_mint_preview[0].token_id, "7")
  assert.equal(overview.windows["1800"][0].recent_mint_preview[0].mint_value_raw, "100000000000000000")
  assert.equal(overview.windows["1800"][0].recent_mint_preview[0].gas_used, null)
  assert.equal(overview.windows["1800"][0].recent_mint_preview[0].gas_fee_wei, null)
  assert.equal(overview.windows["1800"][0].recent_mint_preview[0].gas_fee_native, null)
  assert.equal(overview.events[0].mintPrice, "0.1 native")
  assert.equal(overview.events[0].isAirdrop, false)
  assert.equal(overview.events[0].gasUsed, null)
  assert.equal(overview.events[0].gasFeeWei, null)
  assert.equal(overview.events[0].gasFeeNative, null)
  assert.equal(receiptCalls, 0)

  const detail = await monitor.collection(1, collectionAddress)
  assert.equal(detail.name, "Live Cats")
  assert.equal(detail.current_supply, "77")
  assert.equal(detail.max_supply, "611")
  assert.equal(detail.unique_minters, 1)
  assert.equal(detail.recent_mints[0].tx_hash, txHash)
  assert.equal(detail.recent_mints[0].quantity, "1")
  assert.equal(detail.recent_mints[0].mint_value_raw, "100000000000000000")
  assert.equal(detail.recent_mints[0].unit_price_raw, "100000000000000000")
  assert.equal(detail.recent_mints[0].gas_used, "21000")
  assert.equal(detail.recent_mints[0].gas_fee_wei, "42000000000000")
  assert.equal(detail.recent_mints[0].gas_fee_native, "0.000042")
  assert.equal(receiptCalls, 1)
  monitor.stop()
})

test("an unavailable transaction value stays unknown instead of becoming a false free mint", async () => {
  const client = fakeClient()
  client.getTransaction = async () => { throw new Error("temporary RPC rate limit") }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })

  const overview = await monitor.overview(1, 1800)
  assert.equal(overview.windows["1800"][0].mint_price, "Unknown")
  assert.equal(overview.windows["1800"][0].mint_price_raw, null)
  assert.equal(overview.events[0].mintPrice, "Unknown")
  assert.equal(overview.events[0].mintValueWei, null)
  assert.equal(overview.events[0].isFree, false)
  monitor.stop()
})

test("unique minters is a collection lifetime metric, independent of the overview time window", async () => {
  const olderRecipient = "0x5555555555555555555555555555555555555555"
  const now = Math.floor(Date.now() / 1000)
  const client = fakeClient()
  client.getLogs = async ({ event }) => event.name === "Transfer" ? [
    {
      address: collectionAddress,
      eventName: "Transfer",
      args: { from: "0x0000000000000000000000000000000000000000", to: recipient, tokenId: 7n },
      transactionHash: txHash,
      blockNumber: 1000n,
    },
    {
      address: collectionAddress,
      eventName: "Transfer",
      args: { from: "0x0000000000000000000000000000000000000000", to: olderRecipient, tokenId: 8n },
      transactionHash: `0x${"66".repeat(32)}`,
      blockNumber: 999n,
    },
  ] : []
  client.getBlock = async ({ blockNumber }) => ({ timestamp: BigInt(blockNumber === 1000n ? now : now - 120) })

  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })

  await monitor.scan(1)
  const oneMinute = monitor.directOverview(1, 60).windows["60"][0]
  const thirtyMinutes = monitor.directOverview(1, 1800).windows["1800"][0]
  assert.equal(oneMinute.recent_mints, 1)
  assert.equal(thirtyMinutes.recent_mints, 2)
  assert.equal(oneMinute.unique_minters, 2)
  assert.equal(thirtyMinutes.unique_minters, 2)
  monitor.stop()
})

test("historical minter backfill merges paginated recipients, reports progress, and resumes its cursor", async () => {
  const historicalRecipient = "0x7777777777777777777777777777777777777777"
  const snapshots = new Map()
  const key = `${1}:${collectionAddress}`
  snapshots.set(key, { count: 0, status: "pending", error: "", pagesScanned: 0, updatedAt: null, nextPageParams: null })
  const minters = new Set()
  const minterStore = {
    ensure() { return this.progress() },
    progress() { return snapshots.get(key) },
    snapshot() { return { ...snapshots.get(key), count: minters.size } },
    markLoading() {
      snapshots.set(key, { ...snapshots.get(key), status: "loading", error: "" })
      return this.snapshot()
    },
    markError(_chainId, _address, error) {
      snapshots.set(key, { ...snapshots.get(key), status: "error", error })
      return this.snapshot()
    },
    recordMinter(_chainId, _address, address) {
      minters.add(address.toLowerCase())
      return this.snapshot()
    },
    savePage(_chainId, _address, addresses, nextPageParams) {
      addresses.forEach((address) => minters.add(address.toLowerCase()))
      snapshots.set(key, {
        ...snapshots.get(key),
        status: nextPageParams ? "loading" : "complete",
        error: "",
        pagesScanned: snapshots.get(key).pagesScanned + 1,
        nextPageParams,
        updatedAt: new Date().toISOString(),
      })
      return this.snapshot()
    },
  }
  const requestedUrls = []
  const updates = []
  const monitor = createMintMonitor({
    getClient: fakeClient,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    minterStore,
    blockscoutBases: { 1: "https://explorer.test" },
    minterBackfillPageDelayMs: 0,
    minterBackfillRetryMs: 5,
    fetchImpl: async (url) => {
      requestedUrls.push(url)
      const secondPage = url.includes("block_number=123")
      return {
        ok: true,
        async json() {
          return secondPage ? {
            items: [{ from: { hash: "0x0000000000000000000000000000000000000000" }, to: { hash: historicalRecipient } }],
            next_page_params: null,
          } : {
            items: [
              { from: { hash: "0x0000000000000000000000000000000000000000" }, to: { hash: recipient } },
              { from: { hash: historicalRecipient }, to: { hash: recipient } },
            ],
            next_page_params: { block_number: 123, index: 9 },
          }
        },
      }
    },
    autoPoll: false,
  })
  const complete = new Promise((resolve) => {
    const unsubscribe = monitor.subscribe(1, (event) => {
      if (event.type === "minter_backfill_update") {
        updates.push(event)
        if (event.unique_minters_status === "complete") {
          unsubscribe()
          resolve()
        }
      }
    })
  })

  await monitor.scan(1)
  await complete
  assert.equal(requestedUrls.length, 2)
  assert.match(requestedUrls[1], /block_number=123/)
  assert.match(requestedUrls[1], /index=9/)
  assert.equal(updates[0].unique_minters_status, "loading")
  assert.equal(updates.at(-1).unique_minters_status, "complete")
  assert.equal(monitor.directOverview(1, 60).windows["60"][0].unique_minters, 2)
  assert.equal(monitor.directOverview(1, 1800).windows["1800"][0].unique_minters, 2)
  const detail = await monitor.collection(1, collectionAddress)
  assert.equal(detail.unique_minters, 2)
  assert.equal(detail.unique_minters_status, "complete")
  monitor.stop()
})

test("active collections refresh total supply and read SeaDrop wallet limits on-chain", async () => {
  const seaDropAddress = "0x00005ea00ac477b1030ce78506496e8c2de24bf5"
  let latestBlock = 1000n
  let totalSupply = 77n
  const client = fakeClient()
  client.getBlockNumber = async () => latestBlock
  client.getLogs = async ({ event }) => {
    if (event.name !== "Transfer") return []
    return [{
      address: collectionAddress,
      eventName: "Transfer",
      args: {
        from: "0x0000000000000000000000000000000000000000",
        to: recipient,
        tokenId: latestBlock === 1000n ? 7n : 8n,
      },
      transactionHash: latestBlock === 1000n ? txHash : `0x${"55".repeat(32)}`,
      blockNumber: latestBlock,
    }]
  }
  client.getTransaction = async () => ({
    from: minter,
    to: seaDropAddress,
    input: "0x161ac21f",
    value: 0n,
  })
  client.readContract = async ({ functionName, args }) => {
    if (functionName === "name") return "Live Cats"
    if (functionName === "symbol") return "LCAT"
    if (functionName === "supportsInterface") return args[0] === "0x80ac58cd"
    if (functionName === "totalSupply") return totalSupply
    if (functionName === "maxSupply") return 611n
    if (functionName === "getPublicDrop") return {
      mintPrice: 10_000_000_000_000_000n,
      startTime: 0,
      endTime: 0,
      maxTotalMintableByWallet: 20,
      feeBps: 0,
      restrictFeeRecipients: false,
    }
    throw new Error("not supported")
  }

  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })

  await monitor.scan(1)
  let overview = monitor.directOverview(1, 1800)
  assert.equal(overview.windows["1800"][0].current_supply, "77")
  assert.equal(overview.windows["1800"][0].max_per_wallet, "20")
  assert.equal(overview.windows["1800"][0].mint_price, "0.01 native")
  assert.equal(overview.windows["1800"][0].mint_price_raw, "10000000000000000")

  latestBlock = 1001n
  totalSupply = 78n
  await monitor.scan(1)
  overview = monitor.directOverview(1, 1800)
  assert.equal(overview.windows["1800"][0].current_supply, "78")
  const detail = await monitor.collection(1, collectionAddress)
  assert.equal(detail.current_supply, "78")
  assert.equal(detail.max_per_wallet, "20")
  assert.equal(detail.mint_price, "0.01 native")
  assert.equal(detail.mint_price_raw, "10000000000000000")
  monitor.stop()
})

test("supply fallback never increments past a known max supply", async () => {
  let latestBlock = 1000n
  let totalSupplyReadable = true
  const client = fakeClient()
  client.getBlockNumber = async () => latestBlock
  client.readContract = async ({ functionName, args }) => {
    if (functionName === "name") return "Sold Out Cats"
    if (functionName === "symbol") return "SOC"
    if (functionName === "supportsInterface") return args[0] === "0x80ac58cd"
    if (functionName === "totalSupply") {
      if (!totalSupplyReadable) throw new Error("temporary RPC failure")
      return 611n
    }
    if (functionName === "maxSupply") return 611n
    throw new Error("not supported")
  }

  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })
  await monitor.scan(1)
  totalSupplyReadable = false
  latestBlock = 1001n
  await monitor.scan(1)
  const row = monitor.directOverview(1, 1800).windows["1800"][0]
  assert.equal(row.current_supply, "611")
  assert.equal(row.max_supply, "611")
  assert.equal(row.is_mintable, false)
  monitor.stop()
})

test("high-density Mint enrichment runs with bounded concurrency", async () => {
  const eventCount = 24
  const logs = Array.from({ length: eventCount }, (_, index) => ({
    address: collectionAddress,
    eventName: "Transfer",
    args: {
      from: "0x0000000000000000000000000000000000000000",
      to: recipient,
      tokenId: BigInt(index + 1),
    },
    transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    blockNumber: 999n,
  }))
  let activeTransactions = 0
  let peakTransactions = 0
  const client = fakeClient()
  client.getLogs = async ({ event }) => event.name === "Transfer" ? logs : []
  client.getTransaction = async () => {
    activeTransactions += 1
    peakTransactions = Math.max(peakTransactions, activeTransactions)
    await new Promise((resolve) => setTimeout(resolve, 12))
    activeTransactions -= 1
    return { from: minter, value: 0n }
  }
  client.getTransactionReceipt = async () => {
    await new Promise((resolve) => setTimeout(resolve, 12))
    return { gasUsed: 21_000n, effectiveGasPrice: 2_000_000_000n, status: "success" }
  }

  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })
  const started = performance.now()
  await monitor.scan(1)
  const elapsedMs = performance.now() - started

  assert.ok(peakTransactions > 1, `expected concurrent transaction reads, saw ${peakTransactions}`)
  assert.ok(elapsedMs < 250, `high-density scan took ${Math.round(elapsedMs)}ms`)
  assert.equal(monitor.directOverview(1, 1800).events.length, eventCount)
  monitor.stop()
})

test("a backlogged scan advances through contiguous batches without skipping blocks", async () => {
  const ranges = []
  const client = fakeClient()
  client.getBlockNumber = async () => 100n
  client.getLogs = async ({ event, fromBlock, toBlock }) => {
    if (event.name === "Transfer") ranges.push([fromBlock, toBlock])
    return []
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    initialBlocks: 10,
    maxBlocksPerScan: 4,
    autoPoll: false,
  })

  await monitor.scan(1)

  assert.deepEqual(ranges, [[90n, 93n], [94n, 97n], [98n, 100n]])
  const status = monitor.status(1)
  assert.equal(status.latestBlock, "100")
  assert.equal(status.chainHeadBlock, "100")
  assert.equal(status.backlogBlockCount, 0)
  monitor.stop()
})

test("cached direct collection detail does not wait for a new scan or slow provider", async () => {
  let providerStarted = false
  let releaseProvider
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const client = fakeClient()
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "https://provider.invalid",
    fetchImpl: async (url) => {
      assert.match(url, /\/api\/collection\//)
      providerStarted = true
      await providerGate
      return { ok: false, status: 503, async json() { return {} } }
    },
    autoPoll: false,
  })

  await monitor.scan(1)
  client.getBlockNumber = async () => { throw new Error("detail started a redundant RPC scan") }
  const result = await Promise.race([
    monitor.collection(1, collectionAddress),
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 50)),
  ])

  assert.notEqual(result, "timed out")
  assert.equal(result.name, "Live Cats")
  assert.equal(result.recent_mints.length, 1)
  assert.equal(providerStarted, true)
  releaseProvider()
  monitor.stop()
})

test("monitor subscribers receive real mint events", async () => {
  const monitor = createMintMonitor({
    getClient: fakeClient,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })
  const received = []
  const unsubscribe = monitor.subscribe(1, (event) => received.push(event))
  await monitor.scan(1)
  unsubscribe()
  assert.equal(received.some((event) => event.type === "mint" && event.txHash === txHash), true)
  assert.equal(received.some((event) => event.type === "monitor_status" && event.status === "live"), true)
  monitor.stop()
})

test("monitor publishes asynchronous NFT image enrichment", async () => {
  const monitor = createMintMonitor({
    getClient: fakeClient,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    mediaResolver: {
      async resolveToken({ tokenId, tokenStandard }) {
        assert.equal(tokenId, "7")
        assert.equal(tokenStandard, "ERC721")
        return { imageUrl: "/api/mint-monitor/media/abc", tokenName: "Live Cat #7" }
      },
    },
    autoPoll: false,
  })
  const update = new Promise((resolve) => {
    const unsubscribe = monitor.subscribe(1, (event) => {
      if (event.type === "mint_update") {
        unsubscribe()
        resolve(event)
      }
    })
  })
  await monitor.scan(1)
  const event = await update
  assert.equal(event.imageUrl, "/api/mint-monitor/media/abc")
  assert.equal(event.tokenName, "Live Cat #7")
  const overview = monitor.directOverview(1, 1800)
  assert.equal(overview.windows["1800"][0].image_url, "/api/mint-monitor/media/abc")
  monitor.stop()
})

test("media enrichment gives every active collection a queue turn", async () => {
  const coldAddress = "0x5555555555555555555555555555555555555555"
  const hotLogs = Array.from({ length: 140 }, (_, index) => ({
    address: collectionAddress,
    eventName: "Transfer",
    args: {
      from: "0x0000000000000000000000000000000000000000",
      to: recipient,
      tokenId: BigInt(index + 1),
    },
    transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    blockNumber: 999n,
  }))
  const coldLog = {
    ...hotLogs[0],
    address: coldAddress,
    args: { ...hotLogs[0].args, tokenId: 999n },
    transactionHash: `0x${"aa".repeat(32)}`,
  }
  const client = fakeClient()
  client.getLogs = async ({ event }) => event.name === "Transfer"
    ? [...hotLogs.slice(0, 4), coldLog, ...hotLogs.slice(4)]
    : []
  const resolvedAddresses = []
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum", nativeSymbol: "ETH" }),
    providerBase: "",
    mediaResolver: {
      async resolveToken({ address, tokenId }) {
        resolvedAddresses.push(address.toLowerCase())
        await new Promise((resolve) => setImmediate(resolve))
        return { imageUrl: `/api/mint-monitor/media/${tokenId}`, tokenName: "" }
      },
    },
    autoPoll: false,
  })

  const coldUpdate = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("cold collection never received a media turn")), 1000)
    const unsubscribe = monitor.subscribe(1, (event) => {
      if (event.type === "mint_update" && event.address.toLowerCase() === coldAddress) {
        clearTimeout(timeout)
        unsubscribe()
        resolve(event)
      }
    })
  })
  await monitor.scan(1)
  await coldUpdate
  assert.equal(resolvedAddresses.includes(coldAddress), true)
  monitor.stop()
})

test("first overview returns a bounded starting snapshot while the initial RPC scan continues", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const client = fakeClient()
  const originalBlockNumber = client.getBlockNumber
  client.getBlockNumber = async () => {
    await gate
    return originalBlockNumber()
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: true,
    pollIntervalMs: 60000,
    initialResponseWaitMs: 5,
  })
  const pending = monitor.overview(1, 1800)
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 50)),
  ])
  release()
  if (result === "timed out") await pending
  assert.notEqual(result, "timed out")
  assert.equal(result.mode, "starting")
  assert.equal(result.latestBlock, null)
  assert.deepEqual(result.windows["1800"], [])
  monitor.stop()
})

test("collection detail does not join an unbounded in-progress initial scan", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const client = fakeClient()
  client.getBlockNumber = async () => {
    await gate
    return 1000n
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: true,
    pollIntervalMs: 60000,
    initialResponseWaitMs: 5,
  })

  const pending = monitor.collection(1, collectionAddress)
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 50)),
  ])
  release()
  if (result === "timed out") await pending
  assert.notEqual(result, "timed out")
  assert.equal(result, null)
  monitor.stop()
})

test("missing local collection does not wait for a slow provider fallback", async () => {
  let releaseProvider
  let providerStarted = false
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const client = fakeClient()
  client.getLogs = async () => []
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "https://provider.invalid",
    providerResponseWaitMs: 5,
    fetchImpl: async () => {
      providerStarted = true
      await providerGate
      return { ok: false, status: 503, async json() { return {} } }
    },
    autoPoll: false,
  })

  await monitor.scan(1)
  const pending = monitor.collection(1, collectionAddress)
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 50)),
  ])
  assert.notEqual(result, "timed out")
  assert.equal(result, null)
  assert.equal(providerStarted, true)
  releaseProvider()
  monitor.stop()
})

test("concurrent overview calls join the same initial scan", async () => {
  let release
  let blockCalls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const client = fakeClient()
  client.getBlockNumber = async () => {
    blockCalls += 1
    await gate
    return 1000n
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    autoPoll: false,
  })

  const first = monitor.overview(1, 1800)
  const second = monitor.overview(1, 1800)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(blockCalls, 1)
  assert.equal(a.mode, "live")
  assert.equal(b.mode, "live")
  assert.equal(a.latestBlock, "1000")
  assert.equal(b.latestBlock, "1000")
  monitor.stop()
})

test("addressless log rejection falls back to block receipts and stays live", async () => {
  const monitor = createMintMonitor({
    getClient: receiptFallbackClient,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    initialBlocks: 1,
    autoPoll: false,
  })

  const overview = await monitor.overview(1, 1800)
  assert.equal(overview.mode, "live")
  assert.equal(overview.scanStrategy, "block_receipts")
  assert.match(overview.scanDiagnostics[0], /Range log scan unavailable/)
  assert.equal(overview.events.length, 1)
  assert.equal(overview.events[0].txHash, txHash)
  monitor.stop()
})

test("range log rejection prefers safe per-block log scanning before receipts", async () => {
  const client = fakeClient()
  const originalLogs = client.getLogs
  client.getLogs = async (request) => {
    if (request.fromBlock !== request.toBlock) throw new Error("Please specify an address")
    return originalLogs(request)
  }
  client.request = async ({ method }) => {
    if (method !== "eth_getLogs") throw new Error("receipt calls should not be used")
    return [{
      address: collectionAddress,
      data: "0x",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        indexedTopic("0x0"),
        indexedTopic(recipient),
        indexedTopic("0x07"),
      ],
      transactionHash: txHash,
      blockNumber: "0x3e7",
    }]
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    initialBlocks: 2,
    autoPoll: false,
  })

  const overview = await monitor.overview(1, 1800)
  assert.equal(overview.mode, "live")
  assert.equal(overview.scanStrategy, "per_block_eth_getLogs")
  assert.equal(overview.latestBlock, "1000")
  assert.equal(overview.events.length, 1)
  monitor.stop()
})

test("all direct scan strategies failing reports degraded instead of false live", async () => {
  const client = fakeClient()
  client.getLogs = async () => { throw new Error("logs unavailable") }
  client.request = async () => { throw new Error("receipts unavailable") }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    initialBlocks: 1,
    autoPoll: false,
  })

  const overview = await monitor.overview(1, 1800)
  assert.equal(overview.mode, "degraded")
  assert.equal(overview.latestBlock, null)
  assert.equal(overview.scanStrategy, null)
  assert.match(overview.error, /No mint scan strategy succeeded/)
  monitor.stop()
})

test("fallback scanning preserves the full contiguous initial coverage", async () => {
  let latest = 1000n
  const client = fakeClient()
  client.getBlockNumber = async () => latest
  const originalLogs = client.getLogs
  client.getLogs = async (request) => {
    if (request.fromBlock !== request.toBlock) throw new Error("archive requests require a token")
    return originalLogs(request)
  }
  client.request = async ({ method, params }) => {
    if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`)
    if (params[0].fromBlock !== "0x3e7") return []
    return [{
      address: collectionAddress,
      data: "0x",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        indexedTopic("0x0"),
        indexedTopic(recipient),
        indexedTopic("0x07"),
      ],
      transactionHash: txHash,
      blockNumber: "0x3e7",
    }]
  }
  const monitor = createMintMonitor({
    getClient: () => client,
    getChain: () => ({ id: 1, key: "ethereum", name: "Ethereum" }),
    providerBase: "",
    initialBlocks: 120,
    autoPoll: false,
  })

  const first = await monitor.overview(1, 86400)
  assert.equal(first.coverageLimited, false)
  assert.equal(first.coverageFromBlock, "880")
  latest = 1001n
  await monitor.scan(1)
  const next = monitor.directOverview(1, 86400)
  assert.equal(next.coverageLimited, false)
  assert.equal(next.coverageFromBlock, "880")
  monitor.stop()
})
