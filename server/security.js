import { timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"

export function isLoopbackAddress(value) {
  let address = String(value || "").trim().toLowerCase()
  if (address.startsWith("[")) address = address.slice(1, address.indexOf("]"))
  const zone = address.indexOf("%")
  if (zone >= 0) address = address.slice(0, zone)
  if (address === "localhost" || address.endsWith(".localhost") || address === "::1") return true
  if (address.startsWith("::ffff:")) address = address.slice(7)
  if (isIP(address) === 4) return address.split(".").map(Number)[0] === 127
  return false
}

export function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || "").trim())
  return match?.[1]?.trim() || ""
}

export function tokenMatches(expected, provided) {
  if (!expected || !provided) return false
  const left = Buffer.from(String(expected))
  const right = Buffer.from(String(provided))
  return left.length === right.length && timingSafeEqual(left, right)
}

export function assertSecureRemoteConfiguration(hosts, token) {
  const remoteHosts = (hosts || []).filter((host) => !isLoopbackAddress(host))
  const tokenBytes = Buffer.byteLength(String(token || "").trim())
  if (remoteHosts.length && tokenBytes < 32) {
    throw new Error(`WALLET_BOARD_API_TOKEN must contain at least 32 bytes for non-loopback listeners: ${remoteHosts.join(", ")}`)
  }
  return remoteHosts
}

export function requireRemoteApiAuth({ localAddress, authorization, expectedToken }) {
  if (isLoopbackAddress(localAddress)) return true
  return tokenMatches(expectedToken, bearerToken(authorization))
}
