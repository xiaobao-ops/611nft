import { getAddress } from "viem"

const DEFAULT_API_BASE_URL = "https://api.opensea.io"
const DEFAULT_TOKEN_TTL_SECONDS = 3600
const REFRESH_BUFFER_MS = 60_000
const SESSION_COOKIE_NAMES = new Set(["access_token", "refresh_token"])
const SIWE_STATEMENT = "Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy)."

function responseBody(response) {
  return response.text().then((body) => body.slice(0, 1_000)).catch(() => "")
}

async function requireOk(response, operation) {
  if (response.ok) return response
  const body = await responseBody(response)
  throw new Error(`${operation} failed (${response.status}): ${body}`)
}

function splitSetCookieHeader(header) {
  const segments = String(header || "").split(", ")
  const cookies = []
  let current = ""
  for (const segment of segments) {
    const trimmed = segment.trim()
    const equals = trimmed.indexOf("=")
    const name = equals > 0 ? trimmed.slice(0, equals).trim() : ""
    if (SESSION_COOKIE_NAMES.has(name) && current) {
      cookies.push(current)
      current = trimmed
    } else {
      current = current ? `${current}, ${trimmed}` : trimmed
    }
  }
  if (current) cookies.push(current)
  return cookies
}

function extractSessionCookies(headers) {
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookieHeader(headers.get("set-cookie"))
  const cookies = new Map()
  for (const cookie of raw) {
    const pair = cookie.split(";", 1)[0]
    const equals = pair.indexOf("=")
    if (equals < 0) continue
    const name = pair.slice(0, equals).trim()
    if (SESSION_COOKIE_NAMES.has(name)) cookies.set(name, pair.slice(equals + 1).trim())
  }
  if (![...SESSION_COOKIE_NAMES].every((name) => cookies.has(name))) {
    throw new Error("SIWE verification did not create a session")
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
}

function tokenFromExchange(exchange, scopedToken, now) {
  return {
    accessToken: String(exchange.accessToken || ""),
    refreshToken: String(scopedToken.token || ""),
    expiresAt: new Date(now() + Number(exchange.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS) * 1_000),
    scopes: Array.isArray(exchange.tokenScopes) ? exchange.tokenScopes : scopedToken.scopes,
  }
}

export function buildOpenSeaSiweProof({ address, nonce, issuedAt = new Date() }) {
  const wallet = getAddress(String(address || ""))
  const normalizedNonce = String(nonce || "")
  if (!/^[A-Za-z0-9]{8,}$/.test(normalizedNonce)) throw new Error("OpenSea returned an invalid SIWE nonce")
  const timestamp = issuedAt instanceof Date ? issuedAt : new Date(issuedAt)
  if (!Number.isFinite(timestamp.getTime())) throw new Error("OpenSea SIWE timestamp is invalid")
  const issuedAtIso = timestamp.toISOString()
  const payload = {
    domain: "opensea.io",
    address: wallet,
    statement: SIWE_STATEMENT,
    uri: "https://opensea.io",
    version: "1",
    chainId: "1",
    nonce: normalizedNonce,
    issuedAt: issuedAtIso,
    accountType: "Ethereum",
  }
  const message = [
    "opensea.io wants you to sign in with your Ethereum account:",
    wallet,
    "",
    SIWE_STATEMENT,
    "",
    `URI: ${payload.uri}`,
    `Version: ${payload.version}`,
    `Chain ID: ${payload.chainId}`,
    `Nonce: ${payload.nonce}`,
    `Issued At: ${payload.issuedAt}`,
  ].join("\n")
  return { message, payload }
}

export class OpenSeaAuthClient {
  constructor({
    apiBaseUrl = DEFAULT_API_BASE_URL,
    authBaseUrl = null,
    fetchImpl = fetch,
    requestTimeoutMs = 20_000,
    now = Date.now,
  } = {}) {
    this.apiBaseUrl = String(authBaseUrl || apiBaseUrl).replace(/\/$/, "")
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.now = now
    this.cachedToken = null
    this.scopedTokenId = ""
    this.sessionCookies = ""
  }

  async request(path, init = {}) {
    return this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      signal: init.signal || AbortSignal.timeout(this.requestTimeoutMs),
    })
  }

  async authenticate(signer, { scopes = [] } = {}) {
    const address = await signer.getAddress()
    const nonceResponse = await this.request("/api/v2/auth/siwe/nonce", {
      method: "POST",
      headers: { Accept: "application/json" },
    })
    await requireOk(nonceResponse, "Nonce request")
    const nonceBody = await nonceResponse.json()
    const proof = buildOpenSeaSiweProof({ address, nonce: nonceBody?.nonce, issuedAt: new Date(this.now()) })
    const signature = await signer.signMessage(proof.message)
    const cookie = await this.verifySignature(proof.payload, signature)
    const scopedToken = await this.createScopedToken(cookie, scopes)
    let exchange
    try {
      exchange = await this.exchangeScopedToken(scopedToken.token)
    } catch (error) {
      await this.cleanupScopedToken(cookie, scopedToken.id)
      throw error
    }
    const token = tokenFromExchange(exchange, scopedToken, this.now)
    if (!token.accessToken || !token.refreshToken) throw new Error("Token exchange returned an incomplete token")
    this.cachedToken = token
    this.scopedTokenId = String(scopedToken.id || "")
    this.sessionCookies = cookie
    return token
  }

  async getValidToken() {
    if (!this.cachedToken) throw new Error("No auth token available. Call authenticate() first.")
    if (this.cachedToken.expiresAt.getTime() - this.now() < REFRESH_BUFFER_MS) {
      const exchange = await this.exchangeScopedToken(this.cachedToken.refreshToken)
      this.cachedToken = tokenFromExchange(exchange, {
        id: this.scopedTokenId,
        token: this.cachedToken.refreshToken,
        scopes: this.cachedToken.scopes,
      }, this.now)
    }
    return this.cachedToken
  }

  async revoke(accessToken) {
    if (!this.cachedToken || !this.scopedTokenId || !this.sessionCookies || this.cachedToken.accessToken !== accessToken) {
      throw new Error("The access token is not managed by this OpenSea session")
    }
    this.sessionCookies = await this.refreshSession(this.sessionCookies)
    const response = await this.request(`/api/v2/auth/tokens/${encodeURIComponent(this.scopedTokenId)}`, {
      method: "DELETE",
      headers: { Cookie: this.sessionCookies },
    })
    await requireOk(response, "Scoped token revocation")
    this.cachedToken = null
    this.scopedTokenId = ""
    this.sessionCookies = ""
  }

  async verifySignature(message, signature) {
    const response = await this.request("/api/v2/auth/siwe/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature, chainArch: "EVM" }),
    })
    await requireOk(response, "SIWE verification")
    return extractSessionCookies(response.headers)
  }

  async createScopedToken(cookie, scopes) {
    const response = await this.request("/api/v2/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ label: `nfttool-${this.now()}`, scopes, expiresInDays: 1 }),
    })
    await requireOk(response, "Scoped token creation")
    return response.json()
  }

  async exchangeScopedToken(scopedToken) {
    const response = await this.request("/api/v2/auth/tokens/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectToken: scopedToken, subjectTokenType: "ACCESS_TOKEN" }),
    })
    await requireOk(response, "Token exchange")
    return response.json()
  }

  async cleanupScopedToken(cookie, id) {
    if (!id) return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.request(`/api/v2/auth/tokens/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Cookie: cookie },
        })
        if (response.ok || response.status === 404) return
      } catch {
        // Preserve the original exchange error after one cleanup retry.
      }
    }
  }

  async refreshSession(cookie) {
    const response = await this.request("/api/v2/auth/session/refresh", {
      method: "POST",
      headers: { Cookie: cookie },
    })
    await requireOk(response, "Session refresh")
    return extractSessionCookies(response.headers)
  }
}
