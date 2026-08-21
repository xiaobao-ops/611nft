import {
  formatEther,
  getAddress,
  isAddress,
  parseEther,
} from "viem"

export const DEFAULT_MINT_GRAPHQL_URL = "https://gql.opensea.io/graphql"
export const SEA_DROP_MINT_PUBLIC_SELECTOR = "0x161ac21f"
export const MAX_MINT_WALLETS = 200
export const MAX_MINT_CONCURRENCY = 32

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const SEA_DROP_PUBLIC_DROP_ABI = [{
  type: "function",
  name: "getPublicDrop",
  stateMutability: "view",
  inputs: [{ name: "nftContract", type: "address" }],
  outputs: [{
    name: "publicDrop",
    type: "tuple",
    components: [
      { name: "mintPrice", type: "uint80" },
      { name: "startTime", type: "uint48" },
      { name: "endTime", type: "uint48" },
      { name: "maxTotalMintableByWallet", type: "uint16" },
      { name: "feeBps", type: "uint16" },
      { name: "restrictFeeRecipients", type: "bool" },
    ],
  }],
}]
const NFT_MINT_STATS_ABI = [{
  type: "function",
  name: "getMintStats",
  stateMutability: "view",
  inputs: [{ name: "minter", type: "address" }],
  outputs: [
    { name: "minterNumMinted", type: "uint256" },
    { name: "currentTotalSupply", type: "uint256" },
    { name: "maxSupply", type: "uint256" },
  ],
}]

const MINT_ACTION_QUERY = `query MintActionTimelineQuery(
  $address: Address!
  $fromAssets: [AssetQuantityInput!]!
  $toAssets: [AssetQuantityInput!]!
  $recipient: Address
  $capabilities: WalletCapabilities
) {
  swap(
    address: $address
    fromAssets: $fromAssets
    toAssets: $toAssets
    recipient: $recipient
    action: MINT
    capabilities: $capabilities
  ) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData {
          to
          data
          value
          chain { networkId identifier gasLimitBufferMultiplier }
        }
      }
      ... on MintAction {
        relayerFulfillment { requestId sameChain crossChain }
        transactionSubmissionData {
          to
          data
          value
          chain { networkId identifier gasLimitBufferMultiplier }
        }
      }
    }
    errors { __typename }
  }
}`

const chainIdentifiers = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "matic",
  bsc: "bsc",
  robinhood: "robinhood",
}

export function mintChainIdentifier(chain) {
  return chainIdentifiers[chain?.key] || String(chain?.key || "")
}

export function parseMintPreviewInput(body = {}) {
  const contractAddress = String(body.contractAddress || "").trim()
  if (!isAddress(contractAddress)) throw new Error("请输入有效的 NFT 合约地址")

  const quantityText = String(body.quantity ?? "1").trim()
  if (!/^[1-9]\d*$/.test(quantityText)) throw new Error("数量必须是正整数")
  const quantity = BigInt(quantityText)
  if (quantity > 1000n) throw new Error("每个钱包的数量不得超过 1000")

  const tokenId = String(body.tokenId ?? "0").trim()
  if (!/^(0|[1-9]\d*)$/.test(tokenId)) throw new Error("代币编号必须是非负整数")

  const concurrencyText = String(body.concurrency ?? "5").trim()
  if (!/^\d+$/.test(concurrencyText)) throw new Error("并发数必须是非负整数")
  const concurrency = Number(concurrencyText)
  if (!Number.isSafeInteger(concurrency) || concurrency > MAX_MINT_CONCURRENCY) {
    throw new Error(`并发数不得超过 ${MAX_MINT_CONCURRENCY}`)
  }

  const maxMintCostEth = String(body.maxMintCostEth ?? "").trim()
  let maxMintCostWei = null
  if (maxMintCostEth) {
    if (!/^\d+(\.\d+)?$/.test(maxMintCostEth)) throw new Error("最大铸造金额必须是非负小数")
    maxMintCostWei = parseEther(maxMintCostEth)
  }

  return {
    contractAddress: getAddress(contractAddress),
    quantity,
    tokenId,
    concurrency,
    maxMintCostEth,
    maxMintCostWei,
  }
}

export function normalizeMintSubmission(action, { chainId, chainIdentifier }) {
  const submission = action?.transactionSubmissionData
  if (!submission) throw new Error("铸造服务未返回交易计划")

  const relayer = action.relayerFulfillment
  if (relayer && (relayer.crossChain === true || relayer.sameChain === false)) {
    throw new Error("当前不支持跨链铸造操作")
  }
  if (submission.chain?.identifier && submission.chain.identifier !== chainIdentifier) {
    throw new Error(`铸造服务返回链 ${submission.chain.identifier}，当前预期为 ${chainIdentifier}`)
  }
  if (submission.chain?.networkId && Number(submission.chain.networkId) !== Number(chainId)) {
    throw new Error(`铸造服务返回链编号 ${submission.chain.networkId}，当前预期为 ${chainId}`)
  }
  if (!isAddress(submission.to)) throw new Error("铸造服务返回了无效的交易目标")
  if (!/^0x[0-9a-fA-F]*$/.test(submission.data || "") || submission.data.length < 10) {
    throw new Error("铸造服务返回了无效的 calldata")
  }

  const value = BigInt(submission.value ?? "0")
  if (value < 0n) throw new Error("铸造服务返回了负数交易金额")

  return {
    to: getAddress(submission.to),
    data: submission.data,
    value,
    actionType: action.__typename || "TransactionAction",
    selector: submission.data.slice(0, 10).toLowerCase(),
  }
}

export async function requestMintAction({
  graphqlUrl = DEFAULT_MINT_GRAPHQL_URL,
  accountAddress,
  contractAddress,
  quantity,
  tokenId,
  chainIdentifier,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(graphqlUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://opensea.io",
      referer: "https://opensea.io/",
      "user-agent": process.env.MINT_USER_AGENT?.trim() || "evm-wallet-board/0.1",
      "x-app-id": "os2-web",
    },
    body: JSON.stringify({
      operationName: "MintActionTimelineQuery",
      variables: {
        address: accountAddress,
        fromAssets: [{ asset: { chain: chainIdentifier, contractAddress: ZERO_ADDRESS } }],
        toAssets: [{
          asset: { chain: chainIdentifier, contractAddress, tokenId },
          quantity: quantity.toString(),
        }],
        capabilities: { eip7702: false },
      },
      query: MINT_ACTION_QUERY,
    }),
    signal: AbortSignal.timeout(20000),
  })

  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`铸造服务返回了非 JSON 响应，HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`铸造服务请求失败，HTTP ${response.status}`)

  const swap = payload?.data?.swap
  if (!swap) {
    const message = payload?.errors?.map((error) => error?.message).filter(Boolean).join("; ")
    throw new Error(message || "铸造服务未返回交易计划")
  }
  const action = (swap.actions || []).find((item) => (
    item?.transactionSubmissionData?.to && item?.transactionSubmissionData?.data
  ))
  if (!action) {
    const names = (swap.errors || []).map((error) => error?.__typename).filter(Boolean).join(", ")
    throw new Error(names ? `没有可执行的铸造操作：${names}` : "当前没有可执行的铸造操作")
  }
  return action
}

export async function mapMintConcurrent(items, concurrency, worker) {
  if (!items.length) return []
  const requested = concurrency === 0 ? items.length : concurrency
  const limit = Math.max(1, Math.min(MAX_MINT_CONCURRENCY, requested, items.length))
  const output = new Array(items.length)
  let cursor = 0

  async function run() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      output[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: limit }, run))
  return output
}

export function publicMintPlan(plan) {
  return {
    walletId: plan.wallet.id,
    address: plan.wallet.address,
    status: plan.status,
    preflightStatus: plan.status,
    reason: plan.reason || "",
    transaction: plan.transaction ? {
      to: plan.transaction.to,
      valueWei: plan.transaction.value.toString(),
      valueEth: formatEther(plan.transaction.value),
      actionType: plan.transaction.actionType,
      selector: plan.transaction.selector,
    } : null,
    balanceWei: plan.balance?.toString() ?? "",
    balanceEth: plan.balance === undefined ? "" : formatEther(plan.balance),
    estimatedGas: plan.estimatedGas?.toString() ?? "",
    gasLimit: plan.gasLimit?.toString() ?? "",
    gasPriceWei: plan.gasPrice?.toString() ?? "",
    maxFeePerGasWei: plan.maxFeePerGas?.toString() ?? "",
    maxPriorityFeePerGasWei: plan.maxPriorityFeePerGas?.toString() ?? "",
    feeModel: plan.feeModel || (plan.maxFeePerGas !== undefined ? "eip1559" : "legacy"),
    estimatedFeeWei: plan.estimatedFee?.toString() ?? "",
    estimatedFeeEth: plan.estimatedFee === undefined ? "" : formatEther(plan.estimatedFee),
    estimatedTotalWei: plan.estimatedTotal?.toString() ?? "",
    estimatedTotalEth: plan.estimatedTotal === undefined ? "" : formatEther(plan.estimatedTotal),
  }
}

/**
 * Read the fee quote supported by the selected chain. EIP-1559 chains expose
 * maxFeePerGas; legacy chains and minimal providers fall back to gasPrice.
 */
async function resolveMintFeeQuote(client) {
  if (typeof client.estimateFeesPerGas === "function") {
    try {
      const fees = await client.estimateFeesPerGas({ type: "eip1559" })
      const maxFeePerGas = fees?.maxFeePerGas ?? fees?.gasPrice
      if (maxFeePerGas !== undefined && maxFeePerGas !== null) {
        return {
          feeModel: fees.maxFeePerGas !== undefined ? "eip1559" : "legacy",
          gasPrice: fees.gasPrice,
          maxFeePerGas: BigInt(maxFeePerGas),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas === undefined ? undefined : BigInt(fees.maxPriorityFeePerGas),
        }
      }
    } catch {
      // Some RPCs reject eth_feeHistory/eth_maxPriorityFeePerGas; use the
      // chain's gasPrice method rather than failing an otherwise valid preview.
    }
  }
  const gasPrice = BigInt(await client.getGasPrice())
  return { feeModel: "legacy", gasPrice, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }
}

export async function buildNftMintPreview({
  client,
  chain,
  wallets,
  contractAddress,
  quantity,
  tokenId,
  concurrency,
  maxMintCostWei,
  gasBufferBps = 12000n,
  graphqlUrl = DEFAULT_MINT_GRAPHQL_URL,
  fetchImpl = fetch,
}) {
  if (!wallets.length) throw new Error("请至少选择一个钱包")
  if (wallets.length > MAX_MINT_WALLETS) throw new Error(`最多选择 ${MAX_MINT_WALLETS} 个钱包`)
  if (gasBufferBps < 10000n || gasBufferBps > 20000n) throw new Error("Gas 缓冲比例必须介于 0% 和 100% 之间")

  const collectionCode = await client.getCode({ address: contractAddress })
  if (!collectionCode || collectionCode === "0x") throw new Error("该 NFT 合约在当前链上没有已部署字节码")

  const chainIdentifier = mintChainIdentifier(chain)
  const feeQuote = await resolveMintFeeQuote(client)
  const targetCode = new Map([[contractAddress.toLowerCase(), collectionCode]])
  const rows = await mapMintConcurrent(wallets, concurrency, async (wallet) => {
    try {
      const action = await requestMintAction({
        graphqlUrl,
        accountAddress: wallet.address,
        contractAddress,
        quantity,
        tokenId,
        chainIdentifier,
        fetchImpl,
      })
      const transaction = normalizeMintSubmission(action, { chainId: chain.id, chainIdentifier })
      const quote = await requoteSeaDropPlan({
        client,
        plan: { transaction },
        expectedContractAddress: contractAddress,
        expectedQuantity: quantity,
        walletAddress: wallet.address,
      })
      if (quote.changed) transaction.value = quote.newValue

      const targetKey = transaction.to.toLowerCase()
      if (!targetCode.has(targetKey)) {
        targetCode.set(targetKey, await client.getCode({ address: transaction.to }))
      }
      if (!targetCode.get(targetKey) || targetCode.get(targetKey) === "0x") {
        throw new Error("返回的铸造目标没有已部署字节码")
      }

      const [balance, estimatedGas] = await Promise.all([
        client.getBalance({ address: wallet.address }),
        client.estimateGas({
          account: wallet.address,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
        }),
      ])
      const gasLimit = (estimatedGas * gasBufferBps + 9999n) / 10000n
      // Use the chain's current EIP-1559 max fee as the preview ceiling. This
      // avoids presenting a legacy gasPrice estimate on chains where the
      // transaction will actually be priced with maxFeePerGas.
      const feePerGas = feeQuote.maxFeePerGas ?? feeQuote.gasPrice
      const estimatedFee = gasLimit * feePerGas
      const estimatedTotal = transaction.value + estimatedFee
      const base = {
        wallet,
        transaction,
        balance,
        estimatedGas,
        gasLimit,
        gasPrice: feeQuote.gasPrice,
        maxFeePerGas: feeQuote.maxFeePerGas,
        maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
        feeModel: feeQuote.feeModel,
        estimatedFee,
        estimatedTotal,
      }

      if (maxMintCostWei !== null && transaction.value > maxMintCostWei) {
        return {
          ...base,
          status: "skipped",
          reason: `铸造金额 ${formatEther(transaction.value)} 超过 ${formatEther(maxMintCostWei)} ${chain.nativeSymbol} 上限`,
        }
      }
      if (balance < estimatedTotal) {
        return {
          ...base,
          status: "skipped",
          reason: `余额不足：可用 ${formatEther(balance)}，预计需要 ${formatEther(estimatedTotal)} ${chain.nativeSymbol}`,
        }
      }
      return { ...base, status: "ready", reason: "" }
    } catch (error) {
      return {
        wallet,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return {
    chainIdentifier,
    plans: rows,
    readyPlans: rows.filter((row) => row.status === "ready"),
    wallets: rows.map(publicMintPlan),
    actualConcurrency: Math.max(1, Math.min(MAX_MINT_CONCURRENCY, concurrency || wallets.length, wallets.length)),
  }
}

export async function requoteSeaDropPlan({
  client,
  plan,
  expectedContractAddress = "",
  expectedQuantity = null,
  walletAddress = "",
}) {
  const transaction = plan.transaction
  if (!transaction?.data?.toLowerCase().startsWith(SEA_DROP_MINT_PUBLIC_SELECTOR)) {
    return { changed: false, oldValue: transaction.value, newValue: transaction.value }
  }

  const words = transaction.data.slice(10)
  if (words.length < 64 * 4) throw new Error("SeaDrop calldata 长度低于预期")
  const nftContract = getAddress(`0x${words.slice(24, 64)}`)
  const quantity = BigInt(`0x${words.slice(64 * 3, 64 * 4)}`)
  if (expectedContractAddress && nftContract.toLowerCase() !== getAddress(expectedContractAddress).toLowerCase()) {
    throw new Error("OpenSea 报价中的 NFT 合约与所选项目不一致")
  }
  if (expectedQuantity !== null && quantity !== BigInt(expectedQuantity)) {
    throw new Error("OpenSea 报价中的铸造数量与当前输入不一致")
  }

  const publicDrop = await client.readContract({
    address: transaction.to,
    abi: SEA_DROP_PUBLIC_DROP_ABI,
    functionName: "getPublicDrop",
    args: [nftContract],
  })
  if (!publicDrop) throw new Error("SeaDrop 未返回当前公开铸造数据")

  const maxPerWallet = BigInt(publicDrop.maxTotalMintableByWallet ?? publicDrop[3] ?? 0n)
  let mintedByWallet = null
  if (walletAddress && maxPerWallet > 0n) {
    const stats = await client.readContract({
      address: nftContract,
      abi: NFT_MINT_STATS_ABI,
      functionName: "getMintStats",
      args: [getAddress(walletAddress)],
    })
    mintedByWallet = BigInt(stats?.minterNumMinted ?? stats?.[0] ?? 0n)
    if (mintedByWallet + quantity > maxPerWallet) {
      throw new Error(`每钱包上限为 ${maxPerWallet} 个，当前钱包已铸造 ${mintedByWallet} 个`)
    }
  } else if (maxPerWallet > 0n && quantity > maxPerWallet) {
    throw new Error(`每钱包上限为 ${maxPerWallet} 个`)
  }

  const oldValue = transaction.value
  const newValue = BigInt(publicDrop.mintPrice ?? publicDrop[0]) * quantity
  return { changed: newValue !== oldValue, oldValue, newValue, quantity, maxPerWallet, mintedByWallet, nftContract }
}

export async function refreshNftMintPlan({
  client,
  chain,
  plan,
  contractAddress,
  quantity,
  tokenId,
  maxMintCostWei,
  gasBufferBps = 12000n,
  graphqlUrl = DEFAULT_MINT_GRAPHQL_URL,
  fetchImpl = fetch,
}) {
  const refreshed = await buildNftMintPreview({
    client,
    chain,
    wallets: [plan.wallet],
    contractAddress,
    quantity,
    tokenId,
    concurrency: 1,
    maxMintCostWei,
    gasBufferBps,
    graphqlUrl,
    fetchImpl,
  })
  const next = refreshed.plans[0]
  if (!next || next.status !== "ready") throw new Error(next?.reason || "发送前重新报价失败")
  if (next.transaction.value > plan.transaction.value) {
    throw new Error(`铸造价格已从 ${formatEther(plan.transaction.value)} 上涨到 ${formatEther(next.transaction.value)} ${chain.nativeSymbol}，请重新预览`)
  }
  return next
}
