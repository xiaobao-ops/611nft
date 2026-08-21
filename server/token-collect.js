import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, parseAbiItem } from "viem"
import { mapWithLimit } from "./concurrency.js"

const ERC721_INTERFACE = "0x80ac58cd"
const ERC1155_INTERFACE = "0xd9b67a26"
const ZERO_CODE = new Set([undefined, null, "", "0x", "0x0"])
const MAX_ENUMERATED_TOKENS = 5000
const ENUMERATION_CONCURRENCY = 10
const INITIAL_LOG_CHUNK = 100000n
const MIN_LOG_CHUNK = 250n

const ERC165_ABI = parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"])
const ERC721_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function symbol() view returns (string)",
])
const ERC1155_ABI = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
])
const ERC721_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)")
const ERC1155_TRANSFER_SINGLE = parseAbiItem("event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)")
const ERC1155_TRANSFER_BATCH = parseAbiItem("event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)")

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || ""))
  } catch {
    throw new Error(`${label}无效`)
  }
}

function logOrder(a, b) {
  const block = BigInt(a.blockNumber || 0) - BigInt(b.blockNumber || 0)
  if (block !== 0n) return block < 0n ? -1 : 1
  return Number(a.logIndex || 0) - Number(b.logIndex || 0)
}

function uniqueLogs(logs) {
  const values = new Map()
  for (const log of logs) {
    const key = `${log.transactionHash || ""}:${log.logIndex ?? ""}:${log.blockNumber ?? ""}`
    if (!values.has(key)) values.set(key, log)
  }
  return [...values.values()].sort(logOrder)
}

export function reduceNftTransferLogs({ standard, walletAddresses, logs }) {
  const selected = new Set(walletAddresses.map((value) => String(value).toLowerCase()))
  const tokensByWallet = new Map([...selected].map((address) => [address, new Set()]))
  for (const log of uniqueLogs(logs)) {
    const from = String(log.args?.from || "").toLowerCase()
    const to = String(log.args?.to || "").toLowerCase()
    const ids = standard === "ERC721" ? [log.args?.tokenId] : (log.args?.ids || [log.args?.id])
    for (const id of ids) {
      if (id === undefined || id === null) continue
      const tokenId = BigInt(id).toString()
      if (selected.has(from)) tokensByWallet.get(from).add(tokenId)
      if (selected.has(to)) tokensByWallet.get(to).add(tokenId)
    }
  }
  return Object.fromEntries([...tokensByWallet.entries()].map(([address, ids]) => [
    address,
    [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
  ]))
}

async function supports(client, address, interfaceId) {
  try {
    return Boolean(await client.readContract({ address, abi: ERC165_ABI, functionName: "supportsInterface", args: [interfaceId] }))
  } catch {
    return false
  }
}

async function tokenStandard(client, address) {
  if (await supports(client, address, ERC1155_INTERFACE)) return "ERC1155"
  if (await supports(client, address, ERC721_INTERFACE)) return "ERC721"
  try {
    await client.readContract({ address, abi: erc20Abi, functionName: "decimals" })
    return "ERC20"
  } catch {
    throw new Error("合约未识别为 ERC20、ERC721 或 ERC1155")
  }
}

async function contractStartBlock(client, address, latest) {
  if (typeof client.getBytecode !== "function") return 0n
  try {
    const current = await client.getBytecode({ address, blockNumber: latest })
    if (ZERO_CODE.has(current)) throw new Error("目标地址没有合约代码")
    let low = 0n
    let high = latest
    while (low < high) {
      const middle = (low + high) / 2n
      const code = await client.getBytecode({ address, blockNumber: middle })
      if (ZERO_CODE.has(code)) low = middle + 1n
      else high = middle
    }
    return low
  } catch (error) {
    if (String(error?.message || "").includes("没有合约代码")) throw error
    return 0n
  }
}

// Public RPC nodes reject historical log queries outright ("archive requests require a
// personal token"), so the chunk-halving loop can never succeed no matter how small the
// range gets. Say that instead of leaking the provider's raw parameter error.
export function archiveScanError(cause) {
  const detail = String(cause?.details || cause?.shortMessage || cause?.message || "")
  const error = new Error(
    "当前 RPC 节点不支持历史日志查询，无法枚举这个合约的持仓。"
    + "该合约没有实现 ERC721Enumerable，只能靠 Transfer 日志回溯。"
    + "请配置一个支持 archive 的 RPC（ETH_RPC_URL），或配置 NFT 索引器 API Key（ALCHEMY_API_KEY / OPENSEA_API_KEY）。"
    + (detail ? `原始错误：${detail.slice(0, 200)}` : ""),
  )
  error.code = "ARCHIVE_SCAN_UNAVAILABLE"
  error.cause = cause
  return error
}

async function scanEvent(client, request) {
  const rows = []
  let cursor = request.fromBlock
  let chunk = INITIAL_LOG_CHUNK
  while (cursor <= request.toBlock) {
    const end = cursor + chunk - 1n > request.toBlock ? request.toBlock : cursor + chunk - 1n
    try {
      rows.push(...await client.getLogs({ ...request, fromBlock: cursor, toBlock: end }))
      cursor = end + 1n
      if (chunk < INITIAL_LOG_CHUNK) chunk = chunk * 2n > INITIAL_LOG_CHUNK ? INITIAL_LOG_CHUNK : chunk * 2n
    } catch (error) {
      if (chunk <= MIN_LOG_CHUNK) throw archiveScanError(error)
      chunk /= 2n
    }
  }
  return rows
}

async function transferCandidates({ client, address, wallets, standard }) {
  const latest = await client.getBlockNumber()
  const fromBlock = await contractStartBlock(client, address, latest)
  const addresses = wallets.map((wallet) => wallet.address)
  const events = standard === "ERC721" ? [ERC721_TRANSFER] : [ERC1155_TRANSFER_SINGLE, ERC1155_TRANSFER_BATCH]
  const requests = []
  for (const event of events) {
    requests.push(scanEvent(client, { address, event, args: { from: addresses }, fromBlock, toBlock: latest }))
    requests.push(scanEvent(client, { address, event, args: { to: addresses }, fromBlock, toBlock: latest }))
  }
  const logs = (await Promise.all(requests)).flat()
  return {
    candidates: reduceNftTransferLogs({ standard, walletAddresses: addresses, logs }),
    fromBlock: fromBlock.toString(),
    toBlock: latest.toString(),
  }
}

async function queryErc20(client, address, wallets) {
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "ERC20"),
  ])
  const values = await Promise.all(wallets.map((wallet) => client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] })))
  const rows = wallets.map((wallet, index) => ({
    id: `${wallet.id}:erc20`, standard: "ERC20", walletId: wallet.id, address: wallet.address,
    tokenId: null, count: values[index].toString(), formatted: formatUnits(values[index], Number(decimals)), symbol: String(symbol),
  }))
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n)
  return { standard: "ERC20", symbol: String(symbol), decimals: Number(decimals), rows, totalCount: total.toString(), totalFormatted: formatUnits(total, Number(decimals)), coverageComplete: true }
}

async function queryErc721(client, address, wallets) {
  const balances = await Promise.all(wallets.map((wallet) => client.readContract({ address, abi: ERC721_ABI, functionName: "balanceOf", args: [wallet.address] })))
  const total = balances.reduce((sum, value) => sum + BigInt(value), 0n)
  if (total > BigInt(MAX_ENUMERATED_TOKENS)) throw new Error(`所选钱包合计持仓超过 ${MAX_ENUMERATED_TOKENS}，请缩小查询范围`)
  let rows = []
  let scan = null
  // One probe decides whether the contract implements ERC721Enumerable. Without it a
  // parallel fan-out would fire a burst of doomed calls before the first rejection lands.
  const slots = []
  for (let walletIndex = 0; walletIndex < wallets.length; walletIndex += 1) {
    for (let index = 0n; index < BigInt(balances[walletIndex]); index += 1n) slots.push({ walletIndex, index })
  }
  const enumerable = slots.length
    ? await client.readContract({ address, abi: ERC721_ABI, functionName: "tokenOfOwnerByIndex", args: [wallets[slots[0].walletIndex].address, slots[0].index] })
      .then(() => true, () => false)
    : true
  if (enumerable) {
    // Serial enumeration cost one RPC round trip per token (~292ms against a public
    // node), so a 300-token wallet took 90s. These reads are independent.
    const enumerated = await mapWithLimit(slots, ENUMERATION_CONCURRENCY, async ({ walletIndex, index }) => {
      const wallet = wallets[walletIndex]
      const tokenId = await client.readContract({ address, abi: ERC721_ABI, functionName: "tokenOfOwnerByIndex", args: [wallet.address, index] })
      return { id: `${wallet.id}:${tokenId}`, standard: "ERC721", walletId: wallet.id, address: wallet.address, tokenId: BigInt(tokenId).toString(), count: "1", formatted: "1", symbol: "NFT" }
    }).catch(() => null)
    rows = enumerated || []
    if (!enumerated) scan = await transferCandidates({ client, address, wallets, standard: "ERC721" })
  } else {
    scan = await transferCandidates({ client, address, wallets, standard: "ERC721" })
  }
  if (scan) {
    const walletByAddress = new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]))
    const candidateIds = [...new Set(Object.values(scan.candidates).flat())]
    const owned = await mapWithLimit(candidateIds, ENUMERATION_CONCURRENCY, async (tokenId) => {
      const owner = await client.readContract({ address, abi: ERC721_ABI, functionName: "ownerOf", args: [BigInt(tokenId)] }).catch(() => "")
      const wallet = walletByAddress.get(String(owner).toLowerCase())
      return wallet ? { id: `${wallet.id}:${tokenId}`, standard: "ERC721", walletId: wallet.id, address: wallet.address, tokenId, count: "1", formatted: "1", symbol: "NFT" } : null
    })
    rows = owned.filter(Boolean)
  }
  rows.sort((a, b) => a.walletId.localeCompare(b.walletId) || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1))
  return { standard: "ERC721", symbol: await client.readContract({ address, abi: ERC721_ABI, functionName: "symbol" }).catch(() => "NFT"), decimals: 0, rows, totalCount: total.toString(), totalFormatted: total.toString(), coverageComplete: BigInt(rows.length) === total, ...(scan ? { scan } : {}) }
}

async function queryErc1155(client, address, wallets) {
  const scan = await transferCandidates({ client, address, wallets, standard: "ERC1155" })
  const rows = []
  for (const wallet of wallets) {
    for (const tokenId of scan.candidates[wallet.address.toLowerCase()] || []) {
      const balance = await client.readContract({ address, abi: ERC1155_ABI, functionName: "balanceOf", args: [wallet.address, BigInt(tokenId)] })
      if (balance > 0n) rows.push({ id: `${wallet.id}:${tokenId}`, standard: "ERC1155", walletId: wallet.id, address: wallet.address, tokenId, count: balance.toString(), formatted: balance.toString(), symbol: "NFT" })
    }
  }
  const total = rows.reduce((sum, row) => sum + BigInt(row.count), 0n)
  return { standard: "ERC1155", symbol: "NFT", decimals: 0, rows, totalCount: total.toString(), totalFormatted: total.toString(), coverageComplete: true, scan }
}

export async function queryContractHoldings({ client, contractAddress, wallets }) {
  if (!client || typeof client.readContract !== "function") throw new TypeError("查询需要 RPC 客户端")
  if (!Array.isArray(wallets) || !wallets.length) throw new Error("请至少选择一个钱包")
  const address = requiredAddress(contractAddress, "合约地址")
  const selected = wallets.map((wallet) => ({ ...wallet, address: requiredAddress(wallet.address, `钱包 ${wallet.id} 地址`) }))
  const standard = await tokenStandard(client, address)
  const result = standard === "ERC20"
    ? await queryErc20(client, address, selected)
    : standard === "ERC721"
      ? await queryErc721(client, address, selected)
      : await queryErc1155(client, address, selected)
  return { contractAddress: address, walletCount: selected.length, ...result }
}

export function buildTokenCollectPlan({ contractAddress, destination, rows }) {
  const token = requiredAddress(contractAddress, "合约地址")
  const receiver = requiredAddress(destination, "接收地址")
  if (!Array.isArray(rows) || !rows.length) throw new Error("请至少选择一条有效持仓")
  const entries = []
  for (const row of rows) {
    const source = requiredAddress(row.address, `钱包 ${row.walletId} 地址`)
    const amount = BigInt(row.count || 0)
    if (amount <= 0n || source.toLowerCase() === receiver.toLowerCase()) continue
    let data
    if (row.standard === "ERC20") {
      data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [receiver, amount] })
    } else if (row.standard === "ERC721") {
      data = encodeFunctionData({ abi: ERC721_ABI, functionName: "safeTransferFrom", args: [source, receiver, BigInt(row.tokenId)] })
    } else if (row.standard === "ERC1155") {
      data = encodeFunctionData({ abi: ERC1155_ABI, functionName: "safeTransferFrom", args: [source, receiver, BigInt(row.tokenId), amount, "0x"] })
    } else {
      throw new Error(`不支持的代币标准：${row.standard}`)
    }
    entries.push({
      walletId: row.walletId,
      to: token,
      recipient: receiver,
      valueWei: "0",
      data,
      tokenId: row.tokenId,
      amount: amount.toString(),
      standard: row.standard,
      summary: `${row.walletId} 归集 ${row.standard}${row.tokenId === null || row.tokenId === undefined ? "" : ` #${row.tokenId}`} × ${amount} -> ${receiver.slice(0, 6)}...${receiver.slice(-4)}`,
    })
  }
  if (!entries.length) throw new Error("所选持仓没有可归集余额")
  return { contractAddress: token, destination: receiver, entries }
}
