import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

function unquote(value) {
  const trimmed = String(value || "").trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return trimmed
  const body = trimmed.slice(1, -1)
  return quote === '"'
    ? body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    : body
}

export function parseDotEnv(text) {
  const values = {}
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (!value.startsWith('"') && !value.startsWith("'")) value = value.replace(/\s+#.*$/, "").trim()
    values[match[1]] = unquote(value)
  }
  return values
}

export function loadRootEnv({ env = process.env, envPath } = {}) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const path = envPath || join(root, ".env")
  if (!existsSync(path)) return { path, loaded: [] }
  const values = parseDotEnv(readFileSync(path, "utf8"))
  const loaded = []
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined) continue
    env[key] = value
    loaded.push(key)
  }
  return { path, loaded }
}

loadRootEnv()
