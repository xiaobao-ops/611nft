import {
  decodeAbiParameters,
  encodeFunctionData,
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
  if (!isAddress(contractAddress)) throw new Error("Enter a valid NFT contract address")

  const quantityText = String(body.quantity ?? "1").trim()
  if (!/^[1-9]\d*$/.test(quantityText)) throw new Error("Quantity must be a positive integer")
  const quantity = BigInt(quantityText)
  if (quantity > 1000n) throw new Error("Quantity cannot exceed 1000 per wallet")

  const tokenId = String(body.tokenId ?? "0").trim()
  if (!/^(0|[1-9]\d*)$/.test(tokenId)) throw new Error("Token ID must be a non-negative integer")

  const concurrencyText = String(body.concurrency ?? "5").trim()
  if (!/^\d+$/.test(concurrencyText)) throw new Error("Concurrency must be a non-negative integer")
  const concurrency = Number(concurrencyText)
  if (!Number.isSafeInteger(concurrency) || concurrency > MAX_MINT_CONCURRENCY) {
    throw new Error(`Concurrency cannot exceed ${MAX_MINT_CONCURRENCY}`)
  }

  const maxMintCostEth = String(body.maxMintCostEth ?? "").trim()
  let maxMintCostWei = null
  if (maxMintCostEth) {
    if (!/^\d+(\.\d+)?$/.test(maxMintCostEth)) throw new Error("Max mint value must be a native-token amount")
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
  if (!submission) throw new Error("Mint provider returned no transaction plan")

  const relayer = action.relayerFulfillment
  if (relayer && (relayer.crossChain === true || relayer.sameChain === false)) {
    throw new Error("Cross-chain mint actions are not supported")
  }
  if (submission.chain?.identifier && submission.chain.identifier !== chainIdentifier) {
    throw new Error(`Mint provider returned ${submission.chain.identifier}, expected ${chainIdentifier}`)
  }
  if (submission.chain?.networkId && Number(submission.chain.networkId) !== Number(chainId)) {
    throw new Error(`Mint provider returned chain ${submission.chain.networkId}, expected ${chainId}`)
  }
  if (!isAddress(submission.to)) throw new Error("Mint provider returned an invalid transaction target")
  if (!/^0x[0-9a-fA-F]*$/.test(submission.data || "") || submission.data.length < 10) {
    throw new Error("Mint provider returned invalid calldata")
  }

  const value = BigInt(submission.value ?? "0")
  if (value < 0n) throw new Error("Mint provider returned a negative transaction value")

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
    throw new Error(`Mint provider returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`Mint provider HTTP ${response.status}`)

  const swap = payload?.data?.swap
  if (!swap) {
    const message = payload?.errors?.map((error) => error?.message).filter(Boolean).join("; ")
    throw new Error(message || "Mint provider returned no swap plan")
  }
  const action = (swap.actions || []).find((item) => (
    item?.transactionSubmissionData?.to && item?.transactionSubmissionData?.data
  ))
  if (!action) {
    const names = (swap.errors || []).map((error) => error?.__typename).filter(Boolean).join(", ")
    throw new Error(names ? `No executable mint action: ${names}` : "No executable mint action is available")
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
    estimatedFeeWei: plan.estimatedFee?.toString() ?? "",
    estimatedFeeEth: plan.estimatedFee === undefined ? "" : formatEther(plan.estimatedFee),
    estimatedTotalWei: plan.estimatedTotal?.toString() ?? "",
    estimatedTotalEth: plan.estimatedTotal === undefined ? "" : formatEther(plan.estimatedTotal),
  }
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
  if (!wallets.length) throw new Error("Select at least one wallet")
  if (wallets.length > MAX_MINT_WALLETS) throw new Error(`Select no more than ${MAX_MINT_WALLETS} wallets`)
  if (gasBufferBps < 10000n || gasBufferBps > 20000n) throw new Error("Gas buffer must be between 0% and 100%")

  const collectionCode = await client.getCode({ address: contractAddress })
  if (!collectionCode || collectionCode === "0x") throw new Error("The NFT contract has no deployed bytecode on this chain")

  const chainIdentifier = mintChainIdentifier(chain)
  const gasPrice = await client.getGasPrice()
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

      const targetKey = transaction.to.toLowerCase()
      if (!targetCode.has(targetKey)) {
        targetCode.set(targetKey, await client.getCode({ address: transaction.to }))
      }
      if (!targetCode.get(targetKey) || targetCode.get(targetKey) === "0x") {
        throw new Error("The returned mint target has no deployed bytecode")
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
      const estimatedFee = gasLimit * gasPrice
      const estimatedTotal = transaction.value + estimatedFee
      const base = { wallet, transaction, balance, estimatedGas, gasLimit, gasPrice, estimatedFee, estimatedTotal }

      if (maxMintCostWei !== null && transaction.value > maxMintCostWei) {
        return {
          ...base,
          status: "skipped",
          reason: `Mint value ${formatEther(transaction.value)} exceeds the ${formatEther(maxMintCostWei)} native-token cap`,
        }
      }
      if (balance < estimatedTotal) {
        return {
          ...base,
          status: "skipped",
          reason: `Insufficient balance: ${formatEther(balance)} available, about ${formatEther(estimatedTotal)} required`,
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

export async function requoteSeaDropPlan({ client, plan }) {
  const transaction = plan.transaction
  if (!transaction?.data?.toLowerCase().startsWith(SEA_DROP_MINT_PUBLIC_SELECTOR)) {
    return { changed: false, oldValue: transaction.value, newValue: transaction.value }
  }

  const words = transaction.data.slice(10)
  if (words.length < 64 * 4) throw new Error("SeaDrop calldata is shorter than expected")
  const nftContract = getAddress(`0x${words.slice(24, 64)}`)
  const quantity = BigInt(`0x${words.slice(64 * 3, 64 * 4)}`)
  const response = await client.call({
    to: transaction.to,
    data: encodeFunctionData({
      abi: [{
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
      }],
      functionName: "getPublicDrop",
      args: [nftContract],
    }),
  })
  if (!response.data) throw new Error("SeaDrop returned no current public-drop data")

  const [publicDrop] = decodeAbiParameters([{
    type: "tuple",
    components: [
      { name: "mintPrice", type: "uint80" },
      { name: "startTime", type: "uint48" },
      { name: "endTime", type: "uint48" },
      { name: "maxTotalMintableByWallet", type: "uint16" },
      { name: "feeBps", type: "uint16" },
      { name: "restrictFeeRecipients", type: "bool" },
    ],
  }], response.data)
  const oldValue = transaction.value
  const newValue = BigInt(publicDrop.mintPrice) * quantity
  return { changed: newValue !== oldValue, oldValue, newValue, quantity }
}
