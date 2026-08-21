import { createHash } from "node:crypto"
import { lookup as dnsLookup } from "node:dns/promises"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { isIP } from "node:net"
import { join } from "node:path"

const TOKEN_URI_ABI = [{
  type: "function",
  name: "tokenURI",
  stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [{ name: "uri", type: "string" }],
}]

const ERC1155_URI_ABI = [{
  type: "function",
  name: "uri",
  stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [{ name: "uri", type: "string" }],
}]

const COLLECTION_URI_ABI = (name) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "uri", type: "string" }],
}]

const IMAGE_DATA_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
])

const IMAGE_EXTENSIONS = /\.(avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i

function text(error) {
  return error instanceof Error ? error.message : String(error)
}

function tokenHex(tokenId) {
  return BigInt(tokenId).toString(16).padStart(64, "0")
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

async function firstSuccessful(values, task, label) {
  try {
    return await Promise.any(values.map(task))
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error]
    throw new Error(`${label}: ${unique(errors.map(text)).join("; ")}`)
  }
}

function nftUriCandidates(value, tokenId = "0") {
  let uri = String(value || "").trim()
  if (!uri) return []
  const hex = tokenHex(tokenId)
  uri = uri.replace(/\{id\}/gi, hex).replace(/%7Bid%7D/gi, hex)
  if (uri.startsWith("ar://")) return [`https://arweave.net/${uri.slice(5)}`]

  let ipfsPath = ""
  if (uri.startsWith("ipfs://")) {
    ipfsPath = uri.slice(7).replace(/^ipfs\//i, "")
  } else if (/^https?:\/\//i.test(uri)) {
    try {
      const url = new URL(uri)
      const marker = url.pathname.toLowerCase().indexOf("/ipfs/")
      if (marker >= 0) ipfsPath = `${url.pathname.slice(marker + 6)}${url.search}`
    } catch {
      // The URL validator will report malformed HTTP URLs later.
    }
  }

  if (!ipfsPath) return [uri]
  return unique([
    `https://ipfs.io/ipfs/${ipfsPath}`,
    `https://dweb.link/ipfs/${ipfsPath}`,
    `https://gateway.pinata.cloud/ipfs/${ipfsPath}`,
  ])
}

export function normalizeNftUri(value, tokenId = "0") {
  return nftUriCandidates(value, tokenId)[0] || ""
}

function decodeDataUri(uri, maxBytes) {
  if (uri.length > maxBytes * 1.5 + 1024) throw new Error(`Data URI exceeds ${maxBytes} bytes`)
  const match = /^data:([^;,]+)?((?:;[^,]*)*?),(.*)$/s.exec(uri)
  if (!match) throw new Error("Invalid data URI")
  const contentType = String(match[1] || "text/plain").toLowerCase()
  const base64 = /;base64(?:;|$)/i.test(match[2])
  const bytes = base64 ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]))
  if (bytes.length > maxBytes) throw new Error(`Data URI exceeds ${maxBytes} bytes`)
  return { bytes, contentType }
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) ||
    parts[0] >= 224
}

function mappedIpv4(address) {
  const normalized = address.toLowerCase()
  if (!normalized.startsWith("::ffff:")) return null
  const suffix = normalized.slice(7)
  if (isIP(suffix) === 4) return suffix
  const groups = suffix.split(":")
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export function isPrivateIp(address) {
  if (isIP(address) === 4) return isPrivateIpv4(address)
  if (isIP(address) !== 6) return true
  const normalized = address.toLowerCase()
  const mapped = mappedIpv4(normalized)
  if (mapped) return isPrivateIpv4(mapped)
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")
}

function isSyntheticProxyIp(address) {
  const normalized = mappedIpv4(address) || address
  if (isIP(normalized) !== 4) return false
  const [first, second] = normalized.split(".").map(Number)
  return first === 198 && (second === 18 || second === 19)
}

async function assertPublicUrl(value, lookupImpl, proxyDnsActive) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) NFT media URLs are supported")
  if (url.username || url.password) throw new Error("NFT media URL credentials are not allowed")
  const hostname = url.hostname.toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local NFT media hosts are not allowed")
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookupImpl(hostname, { all: true })
  const syntheticProxyMapping = !isIP(hostname) && addresses.length > 0 &&
    addresses.every((entry) => isSyntheticProxyIp(entry.address)) && await proxyDnsActive()
  if (!addresses.length || (!syntheticProxyMapping && addresses.some((entry) => isPrivateIp(entry.address)))) {
    throw new Error("Private NFT media hosts are not allowed")
  }
  return url
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0)
  if (declared > maxBytes) throw new Error(`NFT media exceeds ${maxBytes} bytes`)
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) throw new Error(`NFT media exceeds ${maxBytes} bytes`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`NFT media exceeds ${maxBytes} bytes`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, size)
}

async function fetchPublicBytes(uri, {
  fetchImpl,
  lookupImpl,
  proxyDnsActive,
  maxBytes,
  timeoutMs,
  redirects = 3,
}) {
  let current = uri
  for (let redirect = 0; redirect <= redirects; redirect += 1) {
    await assertPublicUrl(current, lookupImpl, proxyDnsActive)
    const response = await fetchImpl(current, {
      headers: { accept: "application/json,image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/gif;q=0.9,*/*;q=0.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.("location")
      if (!location || redirect === redirects) throw new Error("NFT media redirect limit exceeded")
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) throw new Error(`NFT media HTTP ${response.status}`)
    return {
      bytes: await readLimited(response, maxBytes),
      contentType: String(response.headers?.get?.("content-type") || "application/octet-stream").split(";")[0].toLowerCase(),
      finalUrl: current,
    }
  }
  throw new Error("NFT media redirect limit exceeded")
}

export function createNftMediaResolver({
  fetchImpl = fetch,
  lookupImpl = dnsLookup,
  metadataTimeoutMs = 7000,
  mediaTimeoutMs = 7000,
  maxMetadataBytes = 768 * 1024,
  maxMediaBytes = 8 * 1024 * 1024,
  maxMemoryEntries = 512,
  cacheDir = "",
} = {}) {
  const tokenCache = new Map()
  const collectionCache = new Map()
  const media = new Map()
  let proxyDnsProbe
  let cacheDirectoryPromise

  function capCache(cache) {
    const limit = Math.max(1, Number(maxMemoryEntries) || 512)
    while (cache.size > limit) cache.delete(cache.keys().next().value)
  }

  function cachePaths(id) {
    return {
      bytes: join(cacheDir, `${id}.bin`),
      metadata: join(cacheDir, `${id}.json`),
    }
  }

  function ensureCacheDirectory() {
    if (!cacheDir) return null
    if (!cacheDirectoryPromise) cacheDirectoryPromise = mkdir(cacheDir, { recursive: true, mode: 0o700 })
    return cacheDirectoryPromise
  }

  async function readCachedMedia(id) {
    if (!cacheDir) return null
    const paths = cachePaths(id)
    try {
      const [metadataBytes, bytes] = await Promise.all([readFile(paths.metadata), readFile(paths.bytes)])
      const metadata = JSON.parse(metadataBytes.toString("utf8"))
      const digest = createHash("sha256").update(bytes).digest("hex")
      if (!IMAGE_DATA_TYPES.has(metadata.contentType) || metadata.byteLength !== bytes.length || metadata.sha256 !== digest) {
        throw new Error("Invalid NFT media cache entry")
      }
      return { bytes, contentType: metadata.contentType }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await Promise.allSettled([rm(paths.metadata, { force: true }), rm(paths.bytes, { force: true })])
      }
      return null
    }
  }

  async function writeCachedMedia(id, payload) {
    if (!cacheDir) return
    await ensureCacheDirectory()
    const paths = cachePaths(id)
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const temporaryBytes = `${paths.bytes}.${suffix}.tmp`
    const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`
    const metadata = {
      contentType: payload.contentType,
      byteLength: payload.bytes.length,
      sha256: createHash("sha256").update(payload.bytes).digest("hex"),
    }
    try {
      await Promise.all([
        writeFile(temporaryBytes, payload.bytes, { mode: 0o600 }),
        writeFile(temporaryMetadata, JSON.stringify(metadata), { mode: 0o600 }),
      ])
      await rename(temporaryBytes, paths.bytes)
      await rename(temporaryMetadata, paths.metadata)
    } finally {
      await Promise.allSettled([rm(temporaryBytes, { force: true }), rm(temporaryMetadata, { force: true })])
    }
  }

  function proxyDnsActive() {
    if (!proxyDnsProbe) {
      proxyDnsProbe = lookupImpl("example.com", { all: true })
        .then((addresses) => addresses.length > 0 && addresses.every((entry) => isSyntheticProxyIp(entry.address)))
        .catch(() => false)
    }
    return proxyDnsProbe
  }

  function registerMedia(source, tokenId) {
    const sources = nftUriCandidates(source, tokenId)
      .filter((uri) => uri.startsWith("data:") || /^https?:\/\//i.test(uri))
    if (!sources.length) return null
    const id = createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 32)
    if (!media.has(id)) {
      media.set(id, { sources, payload: null, promise: null, failedAt: 0, error: null })
      capCache(media)
    }
    return `/api/mint-monitor/media/${id}`
  }

  async function metadataFromUri(uri, tokenId) {
    const candidates = nftUriCandidates(uri, tokenId)
    if (!candidates.length) return null
    if (candidates[0].startsWith("data:")) {
      const decoded = decodeDataUri(candidates[0], maxMetadataBytes)
      if (IMAGE_DATA_TYPES.has(decoded.contentType)) return { image: candidates[0] }
      if (decoded.contentType !== "application/json" && !decoded.contentType.endsWith("+json")) return null
      return JSON.parse(decoded.bytes.toString("utf8"))
    }
    if (IMAGE_EXTENSIONS.test(candidates[0])) return { image: uri }
    return firstSuccessful(candidates, async (candidate) => {
      const result = await fetchPublicBytes(candidate, {
          fetchImpl,
          lookupImpl,
          proxyDnsActive,
          maxBytes: maxMetadataBytes,
          timeoutMs: metadataTimeoutMs,
      })
      if (IMAGE_DATA_TYPES.has(result.contentType)) return { image: candidate }
      return JSON.parse(result.bytes.toString("utf8"))
    }, "NFT metadata unavailable")
  }

  async function readCollectionMetadata(client, tokenId) {
    const errors = []
    for (const functionName of ["contractURI", "collectionURI"]) {
      try {
        const uri = await client.readContract({
          abi: COLLECTION_URI_ABI(functionName),
          functionName,
        })
        if (!uri) continue
        const metadata = await metadataFromUri(uri, tokenId)
        if (metadata) return { metadata, tokenUri: normalizeNftUri(uri, tokenId), source: functionName === "contractURI" ? "contract_uri" : "collection_uri" }
      } catch (error) {
        errors.push(text(error))
      }
    }
    if (errors.length) throw new Error(errors.at(-1))
    return null
  }

  function metadataFields(metadata, tokenId) {
    const imageData = typeof metadata?.image_data === "string" && /^\s*<svg[\s>]/i.test(metadata.image_data)
      ? `data:image/svg+xml,${encodeURIComponent(metadata.image_data)}`
      : ""
    const source = metadata?.logo || metadata?.logo_url || metadata?.logoUrl || metadata?.image || metadata?.image_url || metadata?.imageUrl || imageData
    return {
      imageUrl: registerMedia(source, tokenId),
      name: typeof metadata?.name === "string" ? metadata.name.slice(0, 200) : "",
      website: typeof (metadata?.external_url || metadata?.externalUrl || metadata?.website) === "string"
        ? String(metadata.external_url || metadata.externalUrl || metadata.website).slice(0, 1000)
        : "",
      twitter: typeof (metadata?.twitter || metadata?.twitter_url || metadata?.twitterUrl) === "string"
        ? String(metadata.twitter || metadata.twitter_url || metadata.twitterUrl).slice(0, 1000)
        : "",
      discordUrl: typeof (metadata?.discord || metadata?.discord_url || metadata?.discordUrl) === "string"
        ? String(metadata.discord || metadata.discord_url || metadata.discordUrl).slice(0, 1000)
        : "",
    }
  }

  async function resolveCollection({ client, chainId, address }) {
    const key = `${chainId}:${address.toLowerCase()}`
    if (collectionCache.has(key)) return collectionCache.get(key)
    const pending = (async () => {
      const collection = await readCollectionMetadata({
        readContract: (request) => client.readContract({ address, ...request }),
      }, "0")
      if (!collection) return { imageUrl: null, imageSource: null, name: "", website: "", twitter: "", discordUrl: "", metadataUri: "" }
      const fields = metadataFields(collection.metadata, "0")
      if (fields.imageUrl) await loadMedia(fields.imageUrl.split("/").at(-1))
      return {
        ...fields,
        imageSource: fields.imageUrl ? collection.source : null,
        metadataUri: collection.tokenUri,
      }
    })().catch((error) => ({ imageUrl: null, imageSource: null, name: "", website: "", twitter: "", discordUrl: "", metadataUri: "", error: text(error) }))
    collectionCache.set(key, pending)
    capCache(collectionCache)
    return pending
  }

  async function resolveToken({ client, chainId, address, tokenStandard, tokenId }) {
    if (tokenId === null || tokenId === undefined || tokenId === "") return null
    const key = `${chainId}:${address.toLowerCase()}:${tokenId}`
    if (tokenCache.has(key)) return tokenCache.get(key)
    const pending = (async () => {
      const is1155 = tokenStandard === "ERC1155"
      let tokenUri = ""
      let metadata = null
      let imageSource = is1155 ? "token_uri" : "token_uri"
      let tokenError = null
      try {
        tokenUri = await client.readContract({
          address,
          abi: is1155 ? ERC1155_URI_ABI : TOKEN_URI_ABI,
          functionName: is1155 ? "uri" : "tokenURI",
          args: [BigInt(tokenId)],
        })
        if (tokenUri) metadata = await metadataFromUri(tokenUri, tokenId)
      } catch (error) {
        tokenError = error
      }
      if (!metadata) {
        const collection = await readCollectionMetadata({
          readContract: (request) => client.readContract({ address, ...request }),
        }, tokenId).catch(() => null)
        if (collection) {
          metadata = collection.metadata
          tokenUri = collection.tokenUri
          imageSource = collection.source
        }
      }
      if (!metadata && tokenError) throw tokenError
      const fields = metadataFields(metadata, tokenId)
      const imageUrl = fields.imageUrl
      if (imageUrl) await loadMedia(imageUrl.split("/").at(-1))
      return {
        imageUrl,
        imageSource: imageUrl ? imageSource : null,
        tokenName: fields.name,
        tokenUri: normalizeNftUri(tokenUri, tokenId),
      }
    })().catch((error) => ({ imageUrl: null, imageSource: null, tokenName: "", tokenUri: "", error: text(error) }))
      .then((result) => {
        if (!result.imageUrl) tokenCache.delete(key)
        return result
      })
    tokenCache.set(key, pending)
    capCache(tokenCache)
    return pending
  }

  async function resolveProject({ marketImageUrl = "", tokenId = "", ...request }) {
    const collection = await resolveCollection(request)
    if (collection?.imageUrl) return collection

    if (marketImageUrl) {
      const imageUrl = registerMedia(marketImageUrl, "0")
      if (imageUrl) {
        try {
          await loadMedia(imageUrl.split("/").at(-1))
          return { ...collection, imageUrl, imageSource: "opensea" }
        } catch {
          // Continue to the token image fallback.
        }
      }
    }

    const token = tokenId === null || tokenId === undefined || tokenId === ""
      ? null
      : await resolveToken({ ...request, tokenId })
    return {
      ...collection,
      imageUrl: token?.imageUrl || null,
      imageSource: token?.imageUrl ? "token_uri" : null,
      tokenName: token?.tokenName || "",
      tokenUri: token?.tokenUri || "",
    }
  }

  async function loadMedia(id) {
    const entry = media.get(String(id))
    if (!entry) return null
    if (entry.payload) return entry.payload
    if (entry.promise) return entry.promise
    if (entry.error && Date.now() - entry.failedAt < 30_000) throw entry.error
    entry.promise = (async () => {
      const cached = await readCachedMedia(String(id))
      if (cached) {
        entry.payload = cached
        entry.error = null
        return cached
      }
      const payload = await firstSuccessful(entry.sources, async (source) => {
        const result = source.startsWith("data:")
          ? decodeDataUri(source, maxMediaBytes)
          : await fetchPublicBytes(source, {
              fetchImpl,
              lookupImpl,
              proxyDnsActive,
              maxBytes: maxMediaBytes,
              timeoutMs: mediaTimeoutMs,
          })
        if (!IMAGE_DATA_TYPES.has(result.contentType)) throw new Error(`Unsupported NFT image type: ${result.contentType}`)
        return { bytes: result.bytes, contentType: result.contentType }
      }, "NFT image unavailable")
      entry.payload = payload
      entry.error = null
      await writeCachedMedia(String(id), payload).catch(() => {})
      return payload
    })().catch((error) => {
      entry.error = error
      entry.failedAt = Date.now()
      throw error
    }).finally(() => { entry.promise = null })
    return entry.promise
  }

  return { loadMedia, normalizeNftUri, registerMedia, resolveCollection, resolveProject, resolveToken }
}
