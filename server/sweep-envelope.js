import { baseNonce, pendingGap } from "./nonce-baseline.js"

const BPS_SCALE = 10_000n
const DEFAULT_GAS_LIMIT_MULTIPLIER_BPS = 13_000n
const MAX_GAS_ESTIMATE_PASSES = 4

function ceilRatio(value, numerator, denominator = BPS_SCALE) {
  return (BigInt(value) * BigInt(numerator) + BigInt(denominator) - 1n) / BigInt(denominator)
}

function positiveBps(value, label, minimum = BPS_SCALE) {
  const result = BigInt(value)
  if (result < minimum) throw new Error(`${label}不能低于 1`)
  return result
}

async function readFeeQuote(client) {
  let estimateError = null
  if (typeof client.estimateFeesPerGas === "function") {
    try {
      const estimate = await client.estimateFeesPerGas()
      if (estimate?.maxFeePerGas !== undefined && estimate?.maxFeePerGas !== null) {
        const maxFeePerGas = BigInt(estimate.maxFeePerGas)
        const maxPriorityFeePerGas = BigInt(estimate.maxPriorityFeePerGas ?? 0n)
        if (maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n) throw new Error("写入 RPC 返回无效的 EIP-1559 费用")
        return { type: "eip1559", maxFeePerGas, maxPriorityFeePerGas }
      }
      if (estimate?.gasPrice !== undefined && estimate?.gasPrice !== null) {
        const gasPrice = BigInt(estimate.gasPrice)
        if (gasPrice <= 0n) throw new Error("写入 RPC 返回无效的 legacy Gas Price")
        return { type: "legacy", gasPrice }
      }
    } catch (error) {
      estimateError = error
    }
  }
  if (typeof client.getGasPrice === "function") {
    const gasPrice = BigInt(await client.getGasPrice())
    if (gasPrice <= 0n) throw new Error("写入 RPC 返回无效的 legacy Gas Price")
    return { type: "legacy", gasPrice }
  }
  if (estimateError) throw estimateError
  throw new Error("写入 RPC 未返回可用的交易费用")
}

function finalFeeFields(fees, multiplier) {
  if (fees.type === "eip1559") {
    const maxFeePerGas = ceilRatio(fees.maxFeePerGas, multiplier)
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas > maxFeePerGas
      ? maxFeePerGas
      : fees.maxPriorityFeePerGas
    return {
      request: { type: "eip1559", maxFeePerGas, maxPriorityFeePerGas },
      reservationFeePerGas: maxFeePerGas,
    }
  }
  const gasPrice = ceilRatio(fees.gasPrice, multiplier)
  return {
    request: { type: "legacy", gasPrice },
    reservationFeePerGas: gasPrice,
  }
}

async function estimateFinalTransfer({
  client,
  address,
  to,
  data,
  balance,
  keep,
  nonce,
  feeRequest,
  reservationFeePerGas,
  gasLimitMultiplier,
}) {
  let gasLimit = 0n
  let value = 0n

  // Nitro includes L1 calldata cost in eth_estimateGas, so the encoded value can affect
  // the estimate. Iterate from a zero-value probe until the exact value and buffered gas
  // limit agree. Gas only moves upward within this loop; failure to converge is rejected.
  for (let pass = 0; pass < MAX_GAS_ESTIMATE_PASSES; pass += 1) {
    const estimated = BigInt(await client.estimateGas({
      account: address,
      to,
      data,
      value,
      nonce,
      blockTag: "pending",
      prepare: false,
      ...(feeRequest.gasPrice !== undefined ? { gasPrice: feeRequest.gasPrice } : {}),
      ...(feeRequest.maxFeePerGas !== undefined ? { maxFeePerGas: feeRequest.maxFeePerGas } : {}),
      ...(feeRequest.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: feeRequest.maxPriorityFeePerGas } : {}),
    }))
    if (estimated <= 0n) throw new Error("归集 Gas 估算无效")
    const measuredLimit = ceilRatio(estimated, gasLimitMultiplier)
    const nextGasLimit = measuredLimit > gasLimit ? measuredLimit : gasLimit
    const reservedFeeWei = nextGasLimit * reservationFeePerGas
    const nextValue = balance - keep - reservedFeeWei
    if (nextValue <= 0n) throw new Error("钱包余额不足以支付归集手续费和保留金额")
    if (nextGasLimit === gasLimit && nextValue === value) {
      return { gasLimit, value, reservedFeeWei }
    }
    gasLimit = nextGasLimit
    value = nextValue
  }
  throw new Error("归集 Gas 估算未能与最终金额收敛")
}

export async function prepareSweepEnvelope({
  client,
  address,
  to,
  chainId,
  data = "0x",
  keepReserveWei = 0n,
  multiplierBps = 12_500n,
  gasLimitMultiplierBps = DEFAULT_GAS_LIMIT_MULTIPLIER_BPS,
}) {
  const multiplier = positiveBps(multiplierBps, "归集手续费倍数")
  const gasLimitMultiplier = positiveBps(gasLimitMultiplierBps, "归集 Gas Limit 倍数")
  const keep = BigInt(keepReserveWei)
  if (keep < 0n) throw new Error("归集保留金额不能为负数")

  try {
    let [balance, latest, pending, fees] = await Promise.all([
      client.getBalance({ address, blockTag: "pending" }),
      client.getTransactionCount({ address, blockTag: "latest" }),
      client.getTransactionCount({ address, blockTag: "pending" }),
      readFeeQuote(client),
    ])
    balance = BigInt(balance)
    if (balance <= keep) throw new Error("钱包余额不足以支付归集手续费和保留金额")
    const nonce = baseNonce({ latest, pending })
    const nonceGap = pendingGap({ latest, pending })
    const feeFields = finalFeeFields(fees, multiplier)
    const estimated = await estimateFinalTransfer({
      client,
      address,
      to,
      data,
      balance,
      keep,
      nonce,
      feeRequest: feeFields.request,
      reservationFeePerGas: feeFields.reservationFeePerGas,
      gasLimitMultiplier,
    })
    const request = Object.freeze({
      chainId: Number(chainId),
      nonce,
      gas: estimated.gasLimit,
      to,
      data,
      value: estimated.value,
      ...feeFields.request,
    })
    return Object.freeze({
      request,
      balance,
      valueWei: estimated.value.toString(),
      reservedFeeWei: estimated.reservedFeeWei.toString(),
      keepReserveWei: keep.toString(),
      feeType: fees.type,
      latestNonce: Number(latest),
      pendingNonce: Number(pending),
      pendingGap: nonceGap,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/^归集 envelope 估算失败：/.test(message)) throw error
    throw new Error(`归集 envelope 估算失败：${message}`, { cause: error })
  }
}

export async function signSweepEnvelope({ account, envelope }) {
  if (!account || typeof account.signTransaction !== "function") {
    throw new Error("钱包提供方不能签名最终归集 envelope")
  }
  return account.signTransaction(envelope.request)
}

function requestForLog(request) {
  const output = {
    chainId: Number(request.chainId),
    nonce: Number(request.nonce),
    gas: BigInt(request.gas).toString(),
    to: String(request.to),
    data: String(request.data || "0x"),
    value: BigInt(request.value).toString(),
    type: String(request.type),
  }
  if (request.gasPrice !== undefined) output.gasPrice = BigInt(request.gasPrice).toString()
  if (request.maxFeePerGas !== undefined) output.maxFeePerGas = BigInt(request.maxFeePerGas).toString()
  if (request.maxPriorityFeePerGas !== undefined) output.maxPriorityFeePerGas = BigInt(request.maxPriorityFeePerGas).toString()
  return Object.freeze(output)
}

export function serializeSweepEnvelope(envelope) {
  return Object.freeze({
    request: requestForLog(envelope.request),
    balanceWei: BigInt(envelope.balance).toString(),
    valueWei: String(envelope.valueWei),
    reservedFeeWei: String(envelope.reservedFeeWei),
    keepReserveWei: String(envelope.keepReserveWei),
    feeType: String(envelope.feeType),
    latestNonce: Number(envelope.latestNonce),
    pendingNonce: Number(envelope.pendingNonce),
    pendingGap: Number(envelope.pendingGap || 0),
  })
}

export function sweepEntryFromEnvelope(entry, envelope, { nativeSymbol = "", formatAmount = String } = {}) {
  const amount = formatAmount(envelope.valueWei)
  const to = String(entry.to || envelope.request.to || "")
  const recipient = to.length > 10 ? `${to.slice(0, 6)}...${to.slice(-4)}` : to
  const request = envelope.request
  return {
    ...entry,
    plannedValueWei: entry.plannedValueWei ?? entry.valueWei,
    valueWei: envelope.valueWei,
    amountWei: envelope.valueWei,
    amount,
    gas: String(request.gas),
    nonce: Number(request.nonce),
    gasReserveWei: envelope.reservedFeeWei,
    keepReserveWei: envelope.keepReserveWei,
    summary: `${entry.walletId} -> ${recipient} ${amount}${nativeSymbol ? ` ${nativeSymbol}` : ""}`,
    ...(request.gasPrice !== undefined ? { gasPrice: String(request.gasPrice) } : {}),
    ...(request.maxFeePerGas !== undefined ? { maxFeePerGas: String(request.maxFeePerGas) } : {}),
    ...(request.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: String(request.maxPriorityFeePerGas) } : {}),
  }
}
