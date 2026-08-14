const LOOPBACK_HOST = "127.0.0.1"

export function resolveListenHosts(configuredHost = LOOPBACK_HOST, configuredHosts = "") {
  const explicit = String(configuredHosts || "").split(",").map((host) => host.trim()).filter(Boolean)
  const hosts = explicit.length ? explicit : [String(configuredHost || LOOPBACK_HOST).trim(), LOOPBACK_HOST]
  return [...new Set(hosts.filter(Boolean))]
}
