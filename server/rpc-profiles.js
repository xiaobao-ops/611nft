import { randomBytes } from "node:crypto"

const MAIN_PROFILE = Object.freeze(
  { id: "main", label: "Main", chainIds: "all", envKey: "NFT_WRITE_RPC_MAIN_URL", urlsKey: "NFT_WRITE_RPC_MAIN_URLS" },
)

// `main` remains an internal migration/default profile for existing jobs. It is
// deliberately excluded from the public choices: a sender must name the chain
// it is going to broadcast on.
const PROFILE_DEFINITIONS = Object.freeze([
  {
    id: "ethereum",
    label: "Ethereum",
    chainId: 1,
    chainIds: [1],
    envKey: "NFT_WRITE_RPC_ETHEREUM_URL",
    urlsKey: "NFT_WRITE_RPC_ETHEREUM_URLS",
    legacyEnvKey: "NFT_WRITE_RPC_HK_URL",
    legacyUrlsKey: "NFT_WRITE_RPC_HK_URLS",
    defaultUrls: [
      "https://ethereum.publicnode.com",
      "https://eth-mainnet.public.blastapi.io",
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://rpc.mevblocker.io",
    ],
  },
  {
    id: "bsc",
    label: "BSC",
    chainId: 56,
    chainIds: [56],
    envKey: "NFT_WRITE_RPC_BSC_URL",
    urlsKey: "NFT_WRITE_RPC_BSC_URLS",
    defaultUrls: ["https://bsc-dataseed.binance.org", "https://bsc-dataseed1.binance.org"],
  },
  {
    id: "base",
    label: "Base",
    chainId: 8453,
    chainIds: [8453],
    envKey: "NFT_WRITE_RPC_BASE_URL",
    urlsKey: "NFT_WRITE_RPC_BASE_URLS",
    defaultUrls: [
      "https://base.publicnode.com",
      "https://mainnet.base.org",
      "https://developer-access-mainnet.base.org",
      "https://base.drpc.org",
    ],
  },
  {
    id: "robinhood",
    label: "Robinhood",
    chainId: 4663,
    chainIds: [4663],
    envKey: "NFT_WRITE_RPC_ROBINHOOD_URL",
    urlsKey: "NFT_WRITE_RPC_ROBINHOOD_URLS",
    defaultUrls: [
      "https://rpc.mainnet.chain.robinhood.com",
      "https://robinhood.api.pocket.network",
      "https://rpc.arrowrpc.com",
    ],
  },
  { id: "custom", label: "自定义", chainIds: "all", envKey: "NFT_WRITE_RPC_CUSTOM_URL", urlsKey: "NFT_WRITE_RPC_CUSTOM_URLS" },
])

const ALL_PROFILE_DEFINITIONS = Object.freeze([MAIN_PROFILE, ...PROFILE_DEFINITIONS])
const PROFILE_BY_ID = new Map(ALL_PROFILE_DEFINITIONS.map((definition) => [definition.id, definition]))
const PROFILE_ALIASES = Object.freeze({ hk: "ethereum" })
const RETIRED_PROFILE_IDS = new Set(["flashbots", "arbitrum", "zks", "shib"])
const DEFAULT_PROFILE_TTL_MS = 15 * 60 * 1000
const MAX_ENDPOINTS = 16

function profileError(message, status = 400, code = "rpc_profile_error") {
  return Object.assign(new Error(message), { status, code })
}

function normalizeProfileId(profileId = "main") {
  const raw = String(profileId || "main").trim().toLowerCase()
  if (PROFILE_ALIASES[raw]) return PROFILE_ALIASES[raw]
  if (RETIRED_PROFILE_IDS.has(raw)) throw profileError(`RPC profile ${raw} 已退役，请重新预览`, 409, "profile_retired")
  if (!PROFILE_BY_ID.has(raw)) throw profileError(`未知 RPC profile：${raw}`)
  return raw
}

function hostFor(url) {
  try { return new URL(url).hostname } catch { return "" }
}

function validRpcUrl(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return ""
    return url.toString()
  } catch {
    return ""
  }
}

function splitValues(value) {
  if (Array.isArray(value)) return value.flatMap(splitValues)
  return String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
}

function uniqueUrls(values) {
  const urls = []
  for (const value of splitValues(values)) {
    const url = validRpcUrl(value)
    if (!url) throw profileError("RPC 地址必须是 HTTP(S) URL")
    if (!urls.includes(url)) urls.push(url)
  }
  if (urls.length > MAX_ENDPOINTS) throw profileError(`RPC endpoint 最多支持 ${MAX_ENDPOINTS} 个`)
  return urls
}

function redactMessage(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s)]+/gi, "<rpc>")
    .replace(/wss?:\/\/[^\s)]+/gi, "<rpc>")
    .replace(/([?&](?:token|key|api[_-]?key|secret|password|auth|project[_-]?id)=)[^&\s]+/gi, "$1<redacted>")
}

function parseRpcResult(payload, method) {
  if (payload?.error) throw profileError(payload.error.message || `${method} failed`, 502, "rpc_upstream_error")
  if (payload?.result === undefined || payload?.result === null) throw profileError(`${method} returned no result`, 502, "rpc_upstream_error")
  return payload.result
}

function chainEnvKeys(chain, suffix) {
  const key = String(chain?.key || "").toUpperCase()
  const aliases = key === "ETHEREUM" ? ["ETH"] : [key]
  return [...new Set(aliases.map((name) => `${name}_RPC_${suffix}`))]
}

function readEnvUrls(env, keys) {
  const values = []
  for (const key of keys) if (env[key]) values.push(env[key])
  return uniqueUrls(values)
}

function customInput(options = {}) {
  return options.endpoints ?? options.urls ?? options.rpcUrls ?? options.rpcUrl ?? options.customRpcUrls
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

export const RPC_PROFILE_DEFINITIONS = PROFILE_DEFINITIONS
export const RPC_PROFILE_ALIASES = PROFILE_ALIASES
export const RETIRED_RPC_PROFILE_IDS = Object.freeze([...RETIRED_PROFILE_IDS])
export const RPC_PROFILE_IDS = Object.freeze(PROFILE_DEFINITIONS.map((definition) => definition.id))

export function createRpcProfileStore({
  chains,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 12000,
  profileTtlMs = DEFAULT_PROFILE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!chains || typeof chains !== "object") throw new TypeError("RPC profile store requires chains")
  const pools = new Map()
  const customRefs = new Map()
  const lastTests = new Map()

  function cleanupRefs() {
    const timestamp = now()
    for (const [ref, value] of customRefs) if (value.expiresAt <= timestamp) customRefs.delete(ref)
  }

  function numericChainId(value, { required = false } = {}) {
    if (value === undefined || value === null || String(value).trim() === "") {
      if (required) throw profileError("缺少 chainId")
      return null
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) throw profileError(`无效 chainId：${value}`)
    return parsed
  }

  function chainFor(chainId, { allowUnknown = false } = {}) {
    const numeric = numericChainId(chainId, { required: true })
    const chain = chains[numeric]
    if (chain) return chain
    if (allowUnknown) {
      return {
        id: numeric,
        key: "custom",
        name: "Custom Chain",
        nativeSymbol: "ETH",
        rpcUrl: "",
        rpcUrls: [],
      }
    }
    throw profileError(`不支持的链：${chainId}`)
  }

  function configuredUrls(definition, chain) {
    if (definition.id === "main") {
      const profileUrls = readEnvUrls(env, [definition.envKey, definition.urlsKey])
      if (profileUrls.length) return profileUrls
      return uniqueUrls(chain.rpcUrls || chain.rpcUrl)
    }
    const keys = [definition.envKey, definition.urlsKey]
    if (definition.legacyEnvKey) keys.push(definition.legacyEnvKey, definition.legacyUrlsKey)
    const configured = readEnvUrls(env, keys)
    if (configured.length) return configured
    if (definition.defaultUrls?.length) return uniqueUrls(definition.defaultUrls)
    return []
  }

  function customUrls(options, chain) {
    const supplied = customInput(options)
    if (supplied !== undefined && supplied !== null && String(supplied).trim() !== "") return uniqueUrls(supplied)
    return configuredUrls(PROFILE_BY_ID.get("custom"), chain)
  }

  function configuredCustomChainId() {
    return numericChainId(env.NFT_WRITE_RPC_CUSTOM_CHAIN_ID)
  }

  function profileChainId(definition, requestedChainId) {
    const requested = numericChainId(requestedChainId)
    if (definition.id === "main") return requested || 1
    if (definition.id === "custom") return requested || configuredCustomChainId()
    const ownChainId = definition.chainId ?? definition.chainIds[0]
    if (requested !== null && requested !== ownChainId) {
      throw profileError(`RPC profile ${definition.label} 只发送到链 ${ownChainId}，当前请求为 ${requested}`, 409, "profile_chain_mismatch")
    }
    return ownChainId
  }

  function refFor(value) {
    cleanupRefs()
    const ref = String(value || "").trim()
    if (!ref) return null
    const record = customRefs.get(ref)
    if (!record) throw profileError("自定义 RPC profileRef 已失效，请重新测试并选择", 409, "profile_ref_expired")
    return record
  }

  function newPool(id, chain, urls, profileRef = "") {
    const key = `${id}:${chain.id}:${profileRef || "configured"}`
    if (pools.has(key)) return pools.get(key)
    const pool = {
      key,
      profileId: id,
      profileRef,
      chainId: Number(chain.id),
      endpoints: urls.map((url, index) => ({ id: `rpc-${index}`, url, state: "probing", reportedChainId: null, latencyMs: null, lastError: "", backoffUntil: 0 })),
    }
    pools.set(key, pool)
    return pool
  }

  function context(profileId, chainId, options = {}) {
    const id = normalizeProfileId(profileId)
    const definition = PROFILE_BY_ID.get(id)
    const requestedChainId = numericChainId(chainId)
    const referencedCustom = id === "custom" ? refFor(options.profileRef) : null
    const effectiveChainId = id === "custom" && referencedCustom
      ? referencedCustom.chainId
      : profileChainId(definition, requestedChainId)
    if (effectiveChainId === null) throw profileError("自定义 RPC 需要 chainId，或先测试 endpoint 推断链 ID", 400, "custom_chain_required")
    const chain = chainFor(effectiveChainId, { allowUnknown: id === "custom" })
    let profileRef = ""
    let urls
    if (id === "custom") {
      const record = referencedCustom
      if (record) {
        if (requestedChainId !== null && record.chainId !== requestedChainId) throw profileError("自定义 RPC profileRef 与当前链不匹配", 409, "profile_ref_chain_mismatch")
        profileRef = String(options.profileRef).trim()
        urls = record.urls
      } else {
        urls = customUrls(options, chain)
      }
      if (!urls.length) throw profileError("自定义 RPC 需要至少一个 endpoint", 400, "custom_profile_required")
    } else {
      urls = configuredUrls(definition, chain)
      if (!urls.length && id === "main") urls = uniqueUrls(chain.rpcUrls || chain.rpcUrl)
      if (!urls.length) throw profileError(`RPC profile ${definition.label} 尚未配置`, 400, "profile_unconfigured")
    }
    return { id, label: definition.label, chain, chainId: chain.id, profileRef, urls, applicable: true, pool: newPool(id, chain, urls, profileRef) }
  }

  async function rpcCall(url, method, params = []) {
    const request = timeoutSignal(timeoutMs)
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: request.signal })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw profileError(`HTTP ${response.status}`, 502, "rpc_upstream_error")
      return parseRpcResult(payload, method)
    } finally {
      request.clear()
    }
  }

  async function probe(endpoint, pool) {
    const started = performance.now()
    try {
      const result = await rpcCall(endpoint.url, "eth_chainId")
      const reported = Number(BigInt(result))
      endpoint.reportedChainId = reported
      endpoint.latencyMs = Math.round(performance.now() - started)
      if (reported !== pool.chainId) {
        endpoint.state = "mismatch"
        endpoint.lastError = `reported chainId ${reported}`
        endpoint.backoffUntil = now() + 5 * 60 * 1000
        return false
      }
      endpoint.state = "ready"
      endpoint.lastError = ""
      endpoint.backoffUntil = 0
      return true
    } catch (error) {
      endpoint.state = "backoff"
      endpoint.backoffUntil = now() + 1500
      endpoint.lastError = redactMessage(error instanceof Error ? error.message : String(error))
      endpoint.latencyMs = Math.round(performance.now() - started)
      return false
    }
  }

  async function readyEndpoints(pool) {
    const toProbe = pool.endpoints.filter((endpoint) => endpoint.state === "probing" || endpoint.reportedChainId === null)
    if (toProbe.length) await Promise.all(toProbe.map((endpoint) => probe(endpoint, pool)))
    const timestamp = now()
    return pool.endpoints.filter((endpoint) => endpoint.state === "ready" && endpoint.backoffUntil <= timestamp && endpoint.reportedChainId === pool.chainId)
      .sort((a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER))
  }

  function publicMetadata(profile, { includeRef = false } = {}) {
    const custom = profile.id === "custom"
    const chainId = profile.chainId === null || profile.chainId === undefined ? null : Number(profile.chainId)
    const chainName = profile.chain?.name || (custom ? "自定义" : "")
    return {
      id: profile.id,
      label: profile.label,
      chainId,
      chainName,
      configured: Boolean(profile.urls?.length > 0),
      // A public profile is a sender choice, not a read-pool choice. Never
      // mark a valid built-in profile unavailable just because the monitor is
      // currently looking at another chain.
      applicable: true,
      available: custom ? Boolean(profile.urls?.length > 0) : Boolean(profile.urls?.length > 0),
      endpointCount: profile.urls?.length || 0,
      host: custom ? "" : hostFor(profile.urls?.[0]),
      ...(custom ? { requiresInput: true } : {}),
      ...(includeRef && profile.profileRef ? { profileRef: profile.profileRef } : {}),
      lastTest: chainId === null ? null : lastTests.get(`${chainId}:${profile.id}`) || null,
    }
  }

  function metadata(profileId, chainId, profileRef = "") {
    const id = normalizeProfileId(profileId)
    const definition = PROFILE_BY_ID.get(id)
    const requestedChainId = numericChainId(chainId)
    if (id === "custom" && profileRef) {
      return publicMetadata(context(id, requestedChainId, { profileRef }), { includeRef: true })
    }
    const effectiveChainId = profileChainId(definition, requestedChainId)
    if (effectiveChainId === null) {
      const configured = readEnvUrls(env, [definition.envKey, definition.urlsKey])
      return publicMetadata({ id, label: definition.label, chain: null, chainId: null, urls: configured, profileRef: "", applicable: true })
    }
    const chain = chainFor(effectiveChainId, { allowUnknown: id === "custom" })
    let urls = configuredUrls(definition, chain)
    if (!urls.length && id === "main") urls = uniqueUrls(chain.rpcUrls || chain.rpcUrl)
    return publicMetadata({ id, label: definition.label, chain, chainId: chain.id, urls, profileRef: "", applicable: true })
  }

  function listAll(chainId) {
    return PROFILE_DEFINITIONS.map((definition) => {
      if (definition.id === "custom") {
        const urls = readEnvUrls(env, [definition.envKey, definition.urlsKey])
        const configuredChainId = numericChainId(chainId) ?? configuredCustomChainId()
        const chain = configuredChainId === null ? null : chainFor(configuredChainId, { allowUnknown: true })
        return publicMetadata({ id: definition.id, label: definition.label, chain, chainId: configuredChainId, urls, profileRef: "", applicable: true })
      }
      const profileChainId = definition.chainId ?? definition.chainIds[0]
      const chain = chainFor(profileChainId)
      const urls = configuredUrls(definition, chain)
      return publicMetadata({ id: definition.id, label: definition.label, chain, chainId: profileChainId, urls, profileRef: "", applicable: true })
    })
  }

  function list(chainId) {
    // The sender selector is global. `chainId` remains accepted for older callers,
    // but it must never filter or disable another chain's write profile.
    return listAll(chainId)
  }

  function resolve(profileId, chainId, profileRef = "", options = {}) {
    const profile = context(profileId || "main", chainId, { ...options, profileRef })
    return {
      id: profile.id,
      label: profile.label,
      chainId: profile.chainId,
      chainName: profile.chain.name,
      profileRef: profile.profileRef || "",
      url: profile.urls[0],
      urls: profile.urls,
      host: profile.id === "custom" ? "" : hostFor(profile.urls[0]),
    }
  }

  async function verifyChain(profileId, chainId, profileRef = "", options = {}) {
    const profile = context(profileId || "main", chainId, { ...options, profileRef })
    const candidates = await readyEndpoints(profile.pool)
    if (!candidates.length) throw profileError(`没有通过链 ID 校验的 ${profile.label} RPC endpoint`, 502, "rpc_chain_verification_failed")
    return {
      id: profile.id,
      label: profile.label,
      chainId: profile.chainId,
      chainName: profile.chain.name,
      profileRef: profile.profileRef || "",
      url: candidates[0].url,
      host: profile.id === "custom" ? "" : hostFor(candidates[0].url),
      endpointId: candidates[0].id,
      endpoints: candidates.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, host: profile.id === "custom" ? "" : hostFor(endpoint.url) })),
    }
  }

  async function runTest(profile, { createRef = false } = {}) {
    const started = performance.now()
    const reports = []
    for (const endpoint of profile.pool.endpoints) {
      const endpointStarted = performance.now()
      try {
        const reportedChainId = Number(BigInt(await rpcCall(endpoint.url, "eth_chainId")))
        endpoint.reportedChainId = reportedChainId
        if (reportedChainId !== profile.chainId) throw profileError(`RPC 返回链 ID ${reportedChainId}，预期 ${profile.chainId}`, 502, "rpc_chain_mismatch")
        const blockNumber = BigInt(await rpcCall(endpoint.url, "eth_blockNumber")).toString()
        endpoint.state = "ready"
        endpoint.latencyMs = Math.round(performance.now() - endpointStarted)
        reports.push({ ok: true, reportedChainId, blockNumber, latencyMs: endpoint.latencyMs, host: profile.id === "custom" ? "" : hostFor(endpoint.url) })
      } catch (error) {
        endpoint.state = "backoff"
        endpoint.lastError = String(error?.message || error)
        reports.push({ ok: false, reportedChainId: endpoint.reportedChainId, latencyMs: Math.round(performance.now() - endpointStarted), host: profile.id === "custom" ? "" : hostFor(endpoint.url), error: redactMessage(endpoint.lastError) })
      }
    }
    const healthy = reports.filter((report) => report.ok)
    const result = {
      profileId: profile.id,
      label: profile.label,
      chainId: profile.chainId,
      chainName: profile.chain.name,
      ok: healthy.length > 0,
      reportedChainId: healthy[0]?.reportedChainId ?? reports[0]?.reportedChainId ?? null,
      blockNumber: healthy[0]?.blockNumber || "",
      latencyMs: Math.round(performance.now() - started),
      endpointCount: reports.length,
      healthyEndpointCount: healthy.length,
      endpoints: reports.map(({ host, ok, reportedChainId, blockNumber, latencyMs, error }) => ({ host, ok, reportedChainId, blockNumber, latencyMs, ...(error ? { error } : {}) })),
      testedAt: new Date(now()).toISOString(),
    }
    if (profile.id === "custom" && healthy.length && createRef) result.profileRef = createProfileRef(profile.chainId, profile.urls)
    lastTests.set(`${profile.chainId}:${profile.id}`, result)
    if (!result.ok) throw Object.assign(profileError("所有 RPC endpoint 测试失败", 502, "rpc_profile_test_failed"), { profileTest: result })
    return result
  }

  async function testCustomWithoutChain(options = {}) {
    const urls = customUrls(options, null)
    if (!urls.length) throw profileError("自定义 RPC 需要输入至少一个 endpoint", 400, "custom_profile_required")
    const started = performance.now()
    const reports = []
    let inferredChainId = null
    for (const url of urls) {
      const endpointStarted = performance.now()
      let reportedChainId = null
      try {
        reportedChainId = Number(BigInt(await rpcCall(url, "eth_chainId")))
        if (inferredChainId === null) inferredChainId = reportedChainId
        if (reportedChainId !== inferredChainId) throw profileError(`RPC 返回链 ID ${reportedChainId}，预期 ${inferredChainId}`, 502, "rpc_chain_mismatch")
        const blockNumber = BigInt(await rpcCall(url, "eth_blockNumber")).toString()
        reports.push({ ok: true, reportedChainId, blockNumber, latencyMs: Math.round(performance.now() - endpointStarted), host: "" })
      } catch (error) {
        reports.push({ ok: false, reportedChainId, latencyMs: Math.round(performance.now() - endpointStarted), host: "", error: redactMessage(error?.message || error) })
      }
    }
    const healthy = reports.filter((report) => report.ok)
    const result = {
      profileId: "custom",
      label: "自定义",
      chainId: inferredChainId,
      chainName: inferredChainId === null ? "自定义" : chains[inferredChainId]?.name || "Custom Chain",
      ok: healthy.length > 0,
      reportedChainId: healthy[0]?.reportedChainId ?? reports[0]?.reportedChainId ?? null,
      blockNumber: healthy[0]?.blockNumber || "",
      latencyMs: Math.round(performance.now() - started),
      endpointCount: reports.length,
      healthyEndpointCount: healthy.length,
      endpoints: reports,
      testedAt: new Date(now()).toISOString(),
    }
    if (result.ok) result.profileRef = createProfileRef(inferredChainId, urls)
    if (inferredChainId !== null) lastTests.set(`${inferredChainId}:custom`, result)
    if (!result.ok || inferredChainId === null) {
      throw Object.assign(profileError("所有 RPC endpoint 测试失败", 502, "rpc_profile_test_failed"), { profileTest: result })
    }
    return result
  }

  async function test(profileId, chainId, options = {}) {
    const requested = normalizeProfileId(profileId || "main")
    if (requested === "custom" && numericChainId(chainId) === null && !options.profileRef && configuredCustomChainId() === null) {
      return testCustomWithoutChain(options)
    }
    const profile = context(requested, chainId, options)
    return runTest(profile, { createRef: profile.id === "custom" && !options.profileRef && customInput(options) !== undefined })
  }

  function createProfileRef(chainId, urls) {
    cleanupRefs()
    const normalized = uniqueUrls(urls)
    const profileRef = `custom_${randomBytes(12).toString("hex")}`
    customRefs.set(profileRef, { chainId: Number(chainId), urls: normalized, expiresAt: now() + profileTtlMs })
    return profileRef
  }

  async function select(profileId, chainId, options = {}) {
    const requested = normalizeProfileId(profileId || "main")
    if (requested === "custom") {
      if (options.profileRef) {
        const profile = context(requested, chainId, options)
        await verifyChain(requested, profile.chainId, options.profileRef)
        return { ...metadata(requested, profile.chainId, options.profileRef), profileRef: options.profileRef }
      }
      const result = await test(requested, chainId, options)
      if (!result.profileRef) throw profileError("自定义 RPC 测试未生成 profileRef", 502, "profile_ref_missing")
      return { ...metadata(requested, result.chainId, result.profileRef), profileRef: result.profileRef }
    }
    await verifyChain(requested, chainId)
    return metadata(requested, chainId)
  }

  return {
    list,
    resolve,
    select,
    test,
    verifyChain,
    metadata,
    listAll,
    createProfileRef,
    normalizeProfileId,
    isRetired: (profileId) => RETIRED_PROFILE_IDS.has(String(profileId || "").trim().toLowerCase()),
    defaultProfileId: () => "ethereum",
  }
}
