import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export const AWP_PROVIDER_CAPABILITIES = Object.freeze({
  sendTransaction: true,
  prepareOnWriterEndpoint: false,
  signExactEnvelope: false,
  deterministicHash: false,
  sweep: false,
  signMessage: false,
  signTypedData: false,
  customFees: false,
  exportPrivateKey: false,
  removeWallet: false,
})

export const AWP_MANAGEMENT_CAPABILITIES = Object.freeze({
  createWallets: true,
  importPrivateKeys: false,
  exportPrivateKeys: false,
  removeWallets: false,
})

function profileId(value) {
  const id = String(value || "")
  if (!PROFILE_ID_PATTERN.test(id)) throw new Error(`AWP 钱包编号无效：${id || "<empty>"}`)
  return id
}

function walletAddress(value, id = "") {
  const address = String(value || "")
  if (!ADDRESS_PATTERN.test(address)) throw new Error(`AWP 钱包 ${id || "profile"} 的地址无效`)
  return address
}

export function walletProviderDescriptor(info = {}, id = "") {
  return {
    address: walletAddress(info.address, id),
    source: "awp",
    provider: "awp",
    capabilities: { ...AWP_PROVIDER_CAPABILITIES },
    createdAt: String(info.createdAt || ""),
    lastUsed: String(info.lastUsed || ""),
  }
}

export function readAwpWalletRegistry(walletsPath) {
  if (!existsSync(walletsPath)) return {}
  let payload
  try {
    payload = JSON.parse(readFileSync(walletsPath, "utf8"))
  } catch (error) {
    throw new Error(`AWP 钱包注册表无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AWP 钱包注册表必须是 profile 对象")
  }
  return Object.fromEntries(Object.entries(payload).map(([rawId, info]) => {
    const id = profileId(rawId)
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(`AWP 钱包 ${id} 的记录无效`)
    return [id, walletProviderDescriptor(info, id)]
  }))
}

export function walletProviderSummary() {
  return {
    kind: "awp",
    management: { ...AWP_MANAGEMENT_CAPABILITIES },
  }
}

export function requireWalletCapability(wallet, capability) {
  if (wallet?.capabilities?.[capability] === true) return wallet
  const provider = wallet?.provider || "unknown"
  const detail = capability === "sweep"
    ? "该钱包提供方不能保证在同一写入 RPC 上准备交易、签名最终 envelope 并得到确定性哈希"
    : capability === "signMessage"
      ? "该钱包提供方不支持消息签名"
      : capability === "signTypedData"
        ? "该钱包提供方不支持 EIP-712 typed-data 签名"
        : capability === "customFees"
          ? "该钱包提供方不支持冻结自定义交易费用"
          : `钱包提供方不支持能力：${capability}`
  const error = new Error(`${detail}（provider=${provider}）`)
  error.code = "WALLET_CAPABILITY_UNSUPPORTED"
  error.status = 400
  error.capability = capability
  error.provider = provider
  throw error
}

export function normalizeWalletGroup(value) {
  let output = ""
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0)
    output += code < 32 || code === 127 ? " " : character
  }
  return output.trim().slice(0, 80)
}

function accountAdapter(wallet) {
  return Object.freeze({
    address: wallet.address,
    type: "local",
    source: "custom",
    capabilities: wallet.capabilities,
    async signMessage() {
      requireWalletCapability(wallet, "signMessage")
    },
    async signTransaction() {
      requireWalletCapability(wallet, "signExactEnvelope")
    },
    async signTypedData() {
      requireWalletCapability(wallet, "signTypedData")
    },
  })
}

function parseCommandOutput(text) {
  const trimmed = String(text || "").trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { stdout: trimmed }
  }
}

function safeCommandError(value) {
  return String(value || "").replace(/https?:\/\/[^\s)]+/gi, "<rpc>")
}

export function createAwpWalletProvider({
  root,
  walletRoot,
  walletsPath,
  command = "awp-wallet",
  spawnProcess = spawn,
} = {}) {
  if (!root || !walletRoot || !walletsPath) throw new TypeError("AWP provider requires root, walletRoot and walletsPath")

  const registry = () => readAwpWalletRegistry(walletsPath)
  const getWallet = (walletId) => registry()[String(walletId)] || null
  const accountForWallet = (walletId) => {
    const wallet = getWallet(walletId)
    return wallet ? accountAdapter(wallet) : null
  }

  function commandEnv(walletId) {
    const env = { ...process.env }
    delete env.AWP_SESSION_ID
    delete env.AWP_AGENT_ID
    if (walletId !== "default") env.AWP_AGENT_ID = walletId
    return env
  }

  function run(walletId, args, { timeoutMs = 120_000, uncertainOnTimeout = false } = {}) {
    const id = profileId(walletId)
    return new Promise((resolve, reject) => {
      const child = spawnProcess(command, args, {
        cwd: root,
        env: commandEnv(id),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      let timer
      const finish = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      timer = setTimeout(() => {
        child.kill("SIGTERM")
        const error = new Error(uncertainOnTimeout ? "awp-wallet 广播超时，结果待确认" : "awp-wallet 执行超时")
        if (uncertainOnTimeout) {
          error.code = "BROADCAST_UNCERTAIN"
          error.broadcastUncertain = true
        }
        finish(() => reject(error))
      }, timeoutMs)
      child.stdout.on("data", (data) => { stdout += data.toString() })
      child.stderr.on("data", (data) => { stderr += data.toString() })
      child.on("error", (error) => finish(() => reject(error)))
      child.on("close", (code) => finish(() => {
        if (code !== 0) {
          reject(new Error(safeCommandError(stderr.trim() || stdout.trim() || `awp-wallet 退出码 ${code}`)))
          return
        }
        resolve(parseCommandOutput(stdout))
      }))
    })
  }

  async function createWallets({ count, prefix, start }) {
    mkdirSync(walletRoot, { recursive: true, mode: 0o700 })
    const created = []
    const skipped = []
    const known = registry()
    for (let index = 0; index < count; index += 1) {
      const id = profileId(`${prefix}-${String(start + index).padStart(3, "0")}`)
      if (known[id]) {
        skipped.push({ id, address: known[id].address })
        continue
      }
      const result = await run(id, ["init"])
      const refreshed = registry()
      const address = result?.address || refreshed[id]?.address
      walletAddress(address, id)
      const descriptor = walletProviderDescriptor({ address, source: "awp" }, id)
      known[id] = descriptor
      created.push({ id, address: descriptor.address, source: "awp" })
    }
    return { created, skipped }
  }

  async function sendTransaction(walletId, args, options) {
    const wallet = getWallet(walletId)
    if (!wallet) {
      const error = new Error(`未找到钱包：${walletId}`)
      error.status = 404
      throw error
    }
    requireWalletCapability(wallet, "sendTransaction")
    return run(String(walletId), args, { ...options, uncertainOnTimeout: true })
  }

  return Object.freeze({
    kind: "awp",
    management: AWP_MANAGEMENT_CAPABILITIES,
    registry,
    getWallet,
    accountForWallet,
    createWallets,
    sendTransaction,
    summary: walletProviderSummary,
  })
}
