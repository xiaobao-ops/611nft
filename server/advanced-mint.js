import {
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  parseEther,
  parseGwei,
} from "viem"

const WALLET_TOKENS = new Set(["&", "{wallet}"])

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? "").trim()
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是整数`)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必须介于 ${min} 和 ${max} 之间`)
  }
  return parsed
}

function decimal(value, label, { optional = false } = {}) {
  const text = String(value ?? "").trim()
  if (!text && optional) return ""
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`${label}必须是非负小数`)
  return text
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback
  return value === true || value === 1 || value === "1"
}

function parseArray(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return []
  if (text.startsWith("[")) {
    const value = JSON.parse(text)
    if (!Array.isArray(value)) throw new Error("数组参数必须包含 JSON 数组")
    return value
  }
  return text.split(",").map((value) => value.trim())
}

function parameterValue(input, raw, walletAddress) {
  const type = input.type
  if (type.endsWith("]")) {
    const baseType = type.replace(/\[[0-9]*\]$/, "")
    const values = parseArray(raw)
    const expected = /\[([0-9]+)\]$/.exec(type)?.[1]
    if (expected && values.length !== Number(expected)) throw new Error(`${type} 需要 ${expected} 个值`)
    return values.map((value) => parameterValue({ ...input, type: baseType }, value, walletAddress))
  }
  if (type === "tuple") {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!value || typeof value !== "object") throw new Error("元组参数必须包含 JSON")
    if (Array.isArray(value)) {
      return input.components.map((component, index) => parameterValue(component, value[index], walletAddress))
    }
    return Object.fromEntries(input.components.map((component) => [
      component.name,
      parameterValue(component, value[component.name], walletAddress),
    ]))
  }
  if (WALLET_TOKENS.has(String(raw).trim())) raw = walletAddress
  if (type === "address") return getAddress(String(raw).trim())
  if (/^u?int(?:[0-9]+)?$/.test(type)) {
    const text = String(raw).trim()
    if (!/^-?\d+$/.test(text)) throw new Error(`${type} 参数必须是整数`)
    return BigInt(text)
  }
  if (type === "bool") {
    const text = String(raw).trim().toLowerCase()
    if (!["true", "false", "1", "0"].includes(text)) throw new Error("bool 参数必须为 true 或 false")
    return text === "true" || text === "1"
  }
  if (/^bytes(?:[0-9]+)?$/.test(type)) {
    const text = String(raw).trim()
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(text)) throw new Error(`${type} 参数必须是十六进制字节`)
    return text
  }
  return String(raw ?? "")
}

function methodAbi(signature) {
  const source = String(signature || "").trim()
  if (!source) throw new Error("必须填写方法签名")
  const item = parseAbiItem(source.startsWith("function ") ? source : `function ${source}`)
  if (item.type !== "function") throw new Error("方法签名必须描述一个函数")
  return item
}

function methodData({ signature, parameters, walletAddress }) {
  const item = methodAbi(signature)
  const values = Array.isArray(parameters) ? parameters : []
  if (values.length !== item.inputs.length) {
    throw new Error(`方法需要 ${item.inputs.length} 个参数，当前收到 ${values.length} 个`)
  }
  const args = item.inputs.map((input, index) => parameterValue(input, values[index], walletAddress))
  return {
    data: encodeFunctionData({ abi: [item], functionName: item.name, args }),
    method: item.name,
    parameterTypes: item.inputs.map((input) => input.type),
  }
}

function hexData({ calldata, replaceWallet, walletAddress }) {
  const paddedAddress = walletAddress.slice(2).toLowerCase().padStart(64, "0")
  let data = String(calldata || "").trim()
  if (replaceWallet) data = data.replaceAll("{wallet}", paddedAddress).replaceAll("&", paddedAddress)
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(data)) throw new Error("Hex calldata 必须包含完整字节和函数选择器")
  if (data.length < 10) throw new Error("Hex calldata 必须包含 4 字节函数选择器")
  return { data, method: "原始 calldata", parameterTypes: [] }
}

function scheduleTime(value) {
  const text = String(value || "").trim()
  if (!text) return null
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw new Error("定时执行时间无效")
  if (parsed > Date.now() + 7 * 24 * 60 * 60 * 1000) throw new Error("定时执行时间必须在七天以内")
  return new Date(parsed).toISOString()
}

export function normalizeAdvancedMintInput(input) {
  const mode = input.mode === "method" ? "method" : "hex"
  const valueEth = decimal(input.valueEth ?? "0", "交易金额")
  const autoFee = boolean(input.autoFee, true)
  const eip1559 = boolean(input.eip1559, true)
  return {
    chainId: integer(input.chainId ?? 1, "链编号", { min: 1, max: 10_000_000 }),
    rpcProfileId: String(input.rpcProfileId || "main").trim().toLowerCase() || "main",
    rpcProfileRef: String(input.rpcProfileRef || input.profileRef || "").trim(),
    walletIds: [...new Set((Array.isArray(input.walletIds) ? input.walletIds : []).map(String).filter(Boolean))],
    contractAddress: getAddress(String(input.contractAddress || "").trim()),
    mode,
    methodSignature: String(input.methodSignature || "").trim(),
    parameters: Array.isArray(input.parameters) ? input.parameters.map((value) => String(value ?? "")) : [],
    calldata: String(input.calldata || "").trim(),
    replaceWallet: boolean(input.replaceWallet),
    valueEth,
    valueWei: parseEther(valueEth).toString(),
    rounds: integer(input.rounds ?? 1, "轮次", { min: 1, max: 100_000 }),
    frequencyMs: integer(input.frequencyMs ?? 400, "间隔", { min: 50, max: 3_600_000 }),
    executionMode: input.executionMode === "burst" ? "burst" : "sequential",
    waitMode: input.waitMode === "zero-block" ? "zero-block" : "confirmed",
    scheduleAt: scheduleTime(input.scheduleAt),
    preflight: boolean(input.preflight, true),
    allowGasFailure: boolean(input.allowGasFailure),
    autoGas: boolean(input.autoGas, true),
    gasLimit: boolean(input.autoGas, true) ? "" : String(integer(input.gasLimit, "Gas 上限", { min: 21_000 })),
    autoFee,
    eip1559,
    gasPriceWei: !eip1559 && !autoFee ? parseGwei(decimal(input.gasPriceGwei, "Gas 单价")).toString() : "",
    maxFeePerGasWei: eip1559 && !autoFee ? parseGwei(decimal(input.maxFeeGwei, "最高费")).toString() : "",
    maxPriorityFeePerGasWei: eip1559 && !autoFee ? parseGwei(decimal(input.priorityFeeGwei, "优先费")).toString() : "",
    prefetchNonce: boolean(input.prefetchNonce, true),
  }
}

export function buildAdvancedMintTransactions(input, wallets) {
  if (!input.walletIds.length) throw new Error("请至少选择一个钱包")
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]))
  return input.walletIds.map((walletId) => {
    const wallet = byId.get(walletId)
    if (!wallet) throw new Error(`未找到钱包：${walletId}`)
    const encoded = input.mode === "method"
      ? methodData({ signature: input.methodSignature, parameters: input.parameters, walletAddress: wallet.address })
      : hexData({ calldata: input.calldata, replaceWallet: input.replaceWallet, walletAddress: wallet.address })
    return {
      walletId,
      address: wallet.address,
      to: input.contractAddress,
      data: encoded.data,
      valueWei: input.valueWei,
      selector: encoded.data.slice(0, 10).toLowerCase(),
      method: encoded.method,
      parameterTypes: encoded.parameterTypes,
      calldataBytes: (encoded.data.length - 2) / 2,
      summary: `${walletId} ${encoded.method} ${input.contractAddress.slice(0, 6)}...${input.contractAddress.slice(-4)}`,
      ...(input.gasLimit ? { gas: input.gasLimit } : {}),
      ...(input.gasPriceWei ? { gasPrice: input.gasPriceWei } : {}),
      ...(input.maxFeePerGasWei ? { maxFeePerGas: input.maxFeePerGasWei } : {}),
      ...(input.maxPriorityFeePerGasWei ? { maxPriorityFeePerGas: input.maxPriorityFeePerGasWei } : {}),
    }
  })
}
