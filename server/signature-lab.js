import { decodeFunctionData, formatEther, getAddress, isAddress, zeroAddress } from "viem"

const STAGE_COMPONENTS = [
  { name: "mintPrice", type: "uint256" },
  { name: "maxTotalMintableByWallet", type: "uint256" },
  { name: "startTime", type: "uint256" },
  { name: "endTime", type: "uint256" },
  { name: "dropStageIndex", type: "uint256" },
  { name: "maxTokenSupplyForStage", type: "uint256" },
  { name: "feeBps", type: "uint256" },
  { name: "restrictFeeRecipients", type: "bool" },
]

const SEA_DROP_ABI = [
  {
    type: "function",
    name: "mintPublic",
    stateMutability: "payable",
    inputs: [
      { name: "nftContract", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "minterIfNotPayer", type: "address" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mintSigned",
    stateMutability: "payable",
    inputs: [
      { name: "nftContract", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "minterIfNotPayer", type: "address" },
      { name: "quantity", type: "uint256" },
      { name: "mintParams", type: "tuple", components: STAGE_COMPONENTS },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mintAllowList",
    stateMutability: "payable",
    inputs: [
      { name: "nftContract", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "minterIfNotPayer", type: "address" },
      { name: "quantity", type: "uint256" },
      { name: "mintParams", type: "tuple", components: STAGE_COMPONENTS },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
]

function jsonValue(value) {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  }
  return value
}

function assertHex(value, label, { exactBytes = null } = {}) {
  const text = String(value || "").trim()
  if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(text)) throw new Error(`${label}必须是偶数长度的十六进制数据`)
  if (exactBytes !== null && text.length !== 2 + exactBytes * 2) throw new Error(`${label}必须为 ${exactBytes} 字节`)
  return text
}

function valueWei(value) {
  const text = String(value ?? "0").trim()
  if (!/^\d+$/.test(text)) throw new Error("交易金额必须是非负 wei 整数")
  return text
}

function decodedSignature(signature) {
  const hex = String(signature || "")
  const bytes = hex.startsWith("0x") ? (hex.length - 2) / 2 : 0
  if (bytes !== 65) return { bytes, r: "", s: "", v: "" }
  return {
    bytes,
    r: `0x${hex.slice(2, 66)}`,
    s: `0x${hex.slice(66, 130)}`,
    v: Number.parseInt(hex.slice(130, 132), 16),
  }
}

function stageWindow(params) {
  if (!params) return null
  const start = Number(params.startTime || 0)
  const end = Number(params.endTime || 0)
  const current = Math.floor(Date.now() / 1000)
  return {
    startTime: start,
    endTime: end,
    started: !start || current >= start,
    ended: Boolean(end && current > end),
  }
}

export function analyzeMintCalldata({ chainId, to, from = "", data, valueWei: rawValue = "0", txHash = "" }) {
  const target = getAddress(to)
  const calldata = assertHex(data, "calldata")
  if (calldata.length < 10) throw new Error("calldata 必须包含 4 字节函数选择器")
  const selector = calldata.slice(0, 10).toLowerCase()
  const value = valueWei(rawValue)
  let decoded = null
  try {
    decoded = decodeFunctionData({ abi: SEA_DROP_ABI, data: calldata })
  } catch {
    // Unknown calldata is still useful for selector and preflight analysis.
  }

  const analysis = {
    chainId: Number(chainId),
    txHash,
    from,
    to: target,
    selector,
    valueWei: value,
    valueEth: formatEther(BigInt(value)),
    provider: decoded ? "SeaDrop" : "未知",
    method: decoded?.functionName || "未知方法",
    signatureMode: decoded?.functionName === "mintSigned"
      ? "signed"
      : decoded?.functionName === "mintAllowList" ? "allowlist" : decoded?.functionName === "mintPublic" ? "public" : "unknown",
    decoded: decoded ? jsonValue(decoded.args) : null,
    nftContract: "",
    feeRecipient: "",
    minterIfNotPayer: "",
    quantity: "",
    mintParams: null,
    stageWindow: null,
    salt: "",
    signature: null,
    proofCount: 0,
    observations: [],
  }

  if (!decoded) {
    analysis.observations.push("选择器不属于内置 SeaDrop 铸造方法；仍可使用原始 calldata 进行钱包预检。")
    return analysis
  }

  const [nftContract, feeRecipient, minterIfNotPayer, quantity, extra, last] = decoded.args
  analysis.nftContract = getAddress(nftContract)
  analysis.feeRecipient = getAddress(feeRecipient)
  analysis.minterIfNotPayer = getAddress(minterIfNotPayer)
  analysis.quantity = String(quantity)

  if (decoded.functionName === "mintSigned") {
    analysis.mintParams = jsonValue(extra)
    analysis.stageWindow = stageWindow(extra)
    analysis.salt = String(last)
    analysis.signature = decodedSignature(decoded.args[6])
    analysis.observations.push("签名铸造 calldata 包含项目签发的签名字节与阶段参数。")
  } else if (decoded.functionName === "mintAllowList") {
    analysis.mintParams = jsonValue(extra)
    analysis.stageWindow = stageWindow(extra)
    analysis.proofCount = Array.isArray(last) ? last.length : 0
    analysis.observations.push("白名单 calldata 包含由目标合约在链上验证的 Merkle 证明。")
  } else {
    analysis.observations.push("公开铸造 calldata 不包含项目签名或白名单证明。")
  }

  if (analysis.minterIfNotPayer !== zeroAddress) {
    analysis.observations.push("calldata 指定了独立的铸造接收者；钱包预检会判断是否接受其他付款方。")
  }
  if (analysis.stageWindow?.ended) analysis.observations.push("编码的铸造阶段结束时间已经过去。")
  if (analysis.stageWindow && !analysis.stageWindow.started) analysis.observations.push("编码的铸造阶段尚未开始。")
  return analysis
}

export function normalizeSignatureLabInput(body) {
  const chainId = Number(body.chainId || 1)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("链编号无效")
  const txHash = String(body.txHash || "").trim()
  if (txHash) assertHex(txHash, "交易哈希", { exactBytes: 32 })
  const to = String(body.to || "").trim()
  const data = String(body.data || "").trim()
  if (!txHash) {
    if (!isAddress(to)) throw new Error("未提供交易哈希时必须填写合约地址")
    assertHex(data, "calldata")
  }
  return { chainId, txHash, to, data, valueWei: valueWei(body.valueWei) }
}

export async function resolveSignatureLabTransaction({ client, input }) {
  if (input.txHash) {
    const transaction = await client.getTransaction({ hash: input.txHash })
    if (!transaction?.to) throw new Error("该交易未指向合约")
    return {
      txHash: input.txHash,
      from: transaction.from || "",
      to: transaction.to,
      data: transaction.input || transaction.data || "0x",
      valueWei: String(transaction.value || 0n),
      blockNumber: transaction.blockNumber?.toString() || null,
    }
  }
  return {
    txHash: "",
    from: "",
    to: getAddress(input.to),
    data: assertHex(input.data, "calldata"),
    valueWei: input.valueWei,
    blockNumber: null,
  }
}

export async function inspectSignatureTransaction({ client, input }) {
  const transaction = await resolveSignatureLabTransaction({ client, input })
  const code = await client.getCode({ address: transaction.to })
  if (!code || code === "0x") throw new Error("交易目标没有已部署字节码")
  return {
    transaction,
    analysis: analyzeMintCalldata({ chainId: input.chainId, ...transaction }),
    codePresent: true,
  }
}

export async function preflightSignatureTransaction({ client, transaction, wallets }) {
  const rows = []
  for (const wallet of wallets) {
    try {
      await client.call({
        account: wallet.address,
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.valueWei || "0"),
      })
      rows.push({ walletId: wallet.id, address: wallet.address, status: "ready", reason: "" })
    } catch (error) {
      rows.push({
        walletId: wallet.id,
        address: wallet.address,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    ready: rows.filter((row) => row.status === "ready").length,
    failed: rows.filter((row) => row.status === "failed").length,
    wallets: rows,
  }
}

export { SEA_DROP_ABI }
