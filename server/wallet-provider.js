import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

export const BARE_PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/
const PROFILE_MARKER_PATTERN = /^#\s*(?:nfttool|611nft)-profile:\s*([A-Za-z0-9_-]{1,48})\s*$/i
const GROUP_MARKER_PATTERN = /^#\s*(?:nfttool|611nft)-group:\s*(.*?)\s*$/i

export function normalizeWalletGroup(value) {
  let output = ""
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0)
    output += code < 32 || code === 127 ? " " : character
  }
  return output.trim().slice(0, 80)
}

function normalizePrivateKey(value) {
  const key = String(value || "").trim()
  if (!BARE_PRIVATE_KEY_PATTERN.test(key)) throw new Error("本地钱包私钥必须正好包含 64 个十六进制字符")
  return key.startsWith("0x") ? key : `0x${key}`
}

function automaticProfileId(index) {
  return index === 0 ? "default" : `wallet-${String(index + 1).padStart(3, "0")}`
}

function writeWalletFile(envPath, text) {
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 })
  writeFileSync(envPath, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 })
  chmodSync(envPath, 0o600)
}

function nonWalletLines(text) {
  const output = []
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (PROFILE_MARKER_PATTERN.test(line) || GROUP_MARKER_PATTERN.test(line) || BARE_PRIVATE_KEY_PATTERN.test(line)) continue
    output.push(sourceLine)
  }
  while (output.length && !output[0].trim()) output.shift()
  while (output.length && !output.at(-1).trim()) output.pop()
  return output
}

function profileBlock(profiles) {
  return profiles.flatMap((profile) => {
    const group = normalizeWalletGroup(profile.group)
    return [
      `# nfttool-profile: ${profile.id}`,
      ...(group ? [`# nfttool-group: ${group}`] : []),
      normalizePrivateKey(profile.privateKey).slice(2),
    ]
  })
}

export function sanitizeProfileId(value, fallback = "wallet") {
  return String(value || fallback).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || fallback
}

export function parseLocalWalletProfiles(text) {
  const profiles = []
  const invalidLines = []
  let pendingId = ""
  let pendingGroup = ""
  let keyIndex = 0

  for (const [offset, sourceLine] of String(text || "").split(/\r?\n/).entries()) {
    const line = sourceLine.trim()
    if (!line) continue
    const marker = PROFILE_MARKER_PATTERN.exec(line)
    if (marker) {
      pendingId = sanitizeProfileId(marker[1])
      pendingGroup = ""
      continue
    }
    const groupMarker = GROUP_MARKER_PATTERN.exec(line)
    if (groupMarker) {
      if (pendingId) pendingGroup = normalizeWalletGroup(groupMarker[1])
      continue
    }
    if (line.startsWith("#") || /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue
    if (!BARE_PRIVATE_KEY_PATTERN.test(line)) {
      invalidLines.push(offset + 1)
      pendingId = ""
      pendingGroup = ""
      continue
    }

    const privateKey = normalizePrivateKey(line)
    const account = privateKeyToAccount(privateKey)
    profiles.push({
      id: pendingId || automaticProfileId(keyIndex),
      address: account.address,
      account,
      privateKey,
      source: "root-env",
      group: pendingGroup,
    })
    pendingId = ""
    pendingGroup = ""
    keyIndex += 1
  }

  const ids = new Set()
  const addresses = new Set()
  for (const profile of profiles) {
    const addressKey = profile.address.toLowerCase()
    if (ids.has(profile.id)) throw new Error(`本地钱包编号重复：${profile.id}`)
    if (addresses.has(addressKey)) throw new Error(`本地钱包地址重复：${profile.address}`)
    ids.add(profile.id)
    addresses.add(addressKey)
  }

  return { profiles, invalidLines }
}

export function readLocalWalletProfiles(envPath) {
  if (!existsSync(envPath)) return { profiles: [], invalidLines: [] }
  const parsed = parseLocalWalletProfiles(readFileSync(envPath, "utf8"))
  if (parsed.invalidLines.length) {
    throw new Error(`本地钱包配置行无效：${parsed.invalidLines.join(", ")}`)
  }
  return parsed
}

export function localWalletRegistry(envPath) {
  return Object.fromEntries(readLocalWalletProfiles(envPath).profiles.map((profile) => [profile.id, {
    address: profile.address,
    source: profile.source,
  }]))
}

export function mergeWalletRegistries(externalRegistry = {}, localRegistry = {}) {
  return {
    ...externalRegistry,
    ...localRegistry,
  }
}

export function localWalletAccount(envPath, profileId) {
  return readLocalWalletProfiles(envPath).profiles.find((profile) => profile.id === profileId)?.account || null
}

export function createLocalWalletProfiles({ envPath, prefix = "wallet", start = 1, count = 1, reservedIds = [] }) {
  const existing = readLocalWalletProfiles(envPath).profiles
  const ids = new Set([...existing.map((profile) => profile.id), ...reservedIds.map(String)])
  const created = []
  const skipped = []
  const lines = []
  const safePrefix = sanitizeProfileId(prefix)

  for (let index = 0; index < count; index += 1) {
    const id = sanitizeProfileId(`${safePrefix}-${String(start + index).padStart(3, "0")}`)
    if (ids.has(id)) {
      skipped.push({ id, address: existing.find((profile) => profile.id === id)?.address || "" })
      continue
    }
    const privateKey = generatePrivateKey()
    const account = privateKeyToAccount(privateKey)
    lines.push(`# nfttool-profile: ${id}`, privateKey.slice(2))
    created.push({ id, address: account.address, source: "root-env" })
    ids.add(id)
  }

  if (lines.length) {
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 })
    const needsLeadingNewline = existsSync(envPath) && readFileSync(envPath, "utf8").length > 0
    appendFileSync(envPath, `${needsLeadingNewline ? "\n" : ""}${lines.join("\n")}\n`, { mode: 0o600 })
    chmodSync(envPath, 0o600)
  }

  return { created, skipped }
}

export function parseWalletImportText(text, { prefix = "imported" } = {}) {
  const source = String(text || "")
  const profileFormat = source.split(/\r?\n/).some((line) => PROFILE_MARKER_PATTERN.test(line.trim()))
  if (profileFormat) {
    const parsed = parseLocalWalletProfiles(source)
    if (parsed.invalidLines.length) throw new Error(`导入配置行无效：${parsed.invalidLines.join(", ")}`)
    if (!parsed.profiles.length) throw new Error("请至少粘贴一个私钥")
    if (parsed.profiles.length > 500) throw new Error("每次最多导入 500 个钱包")
    return parsed.profiles.map((profile) => ({
      id: profile.id,
      label: profile.id.slice(0, 80),
      group: normalizeWalletGroup(profile.group),
      privateKey: profile.privateKey,
    }))
  }

  const rows = []
  let index = 1
  for (const [offset, sourceLine] of source.split(/\r?\n/).entries()) {
    const line = sourceLine.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split(",").map((value) => value.trim())
    if (parts.length !== 2 && parts.length !== 3) {
      throw new Error(`导入第 ${offset + 1} 行必须使用“名称,私钥”或“名称,分组,私钥”格式`)
    }
    const [label, group = "", key] = parts.length === 2
      ? [parts[0], "", parts[1]]
      : parts
    if (!label) throw new Error(`导入第 ${offset + 1} 行缺少钱包名称`)
    if (!BARE_PRIVATE_KEY_PATTERN.test(key || "")) throw new Error(`导入第 ${offset + 1} 行的私钥无效`)
    const fallbackId = `${prefix}-${String(index).padStart(3, "0")}`
    rows.push({
      id: sanitizeProfileId(label, fallbackId),
      label: label.slice(0, 80),
      group: normalizeWalletGroup(group),
      privateKey: normalizePrivateKey(key),
    })
    index += 1
  }
  if (!rows.length) throw new Error("请至少粘贴一个私钥")
  if (rows.length > 500) throw new Error("每次最多导入 500 个钱包")
  return rows
}

export function importLocalWalletProfiles({ envPath, text, prefix = "imported", reservedIds = [] }) {
  const existing = readLocalWalletProfiles(envPath).profiles
  const imported = parseWalletImportText(text, { prefix: sanitizeProfileId(prefix, "imported") })
  const ids = new Set([...existing.map((profile) => profile.id), ...reservedIds.map(String)])
  const addresses = new Set(existing.map((profile) => profile.address.toLowerCase()))
  const created = []

  for (const row of imported) {
    if (ids.has(row.id)) throw new Error(`本地钱包编号重复：${row.id}`)
    const account = privateKeyToAccount(row.privateKey)
    if (addresses.has(account.address.toLowerCase())) throw new Error(`本地钱包地址重复：${account.address}`)
    ids.add(row.id)
    addresses.add(account.address.toLowerCase())
    created.push({
      id: row.id,
      address: account.address,
      source: "root-env",
      label: row.label,
      group: row.group,
      privateKey: row.privateKey,
    })
  }

  const currentText = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const lines = profileBlock(created)
  const needsLeadingNewline = currentText.length > 0 && !currentText.endsWith("\n\n")
  appendFileSync(envPath, `${needsLeadingNewline ? "\n" : ""}${lines.join("\n")}\n`, { mode: 0o600 })
  chmodSync(envPath, 0o600)
  return created.map(({ privateKey, ...profile }) => profile)
}

export function exportLocalWalletProfiles({ envPath, profileIds, groupsById = {} }) {
  const selected = new Set((profileIds || []).map(String))
  const profiles = readLocalWalletProfiles(envPath).profiles
    .filter((profile) => selected.has(profile.id))
    .map((profile) => ({
      ...profile,
      group: Object.prototype.hasOwnProperty.call(groupsById, profile.id)
        ? normalizeWalletGroup(groupsById[profile.id])
        : profile.group,
    }))
  if (!profiles.length) throw new Error("请至少选择一个本地钱包")
  if (profiles.length !== selected.size) throw new Error("一个或多个所选钱包不属于本地钱包")
  return `${profileBlock(profiles).join("\n")}\n`
}

export function removeLocalWalletProfiles({ envPath, profileIds }) {
  const selected = new Set((profileIds || []).map(String))
  if (!selected.size) throw new Error("请至少选择一个本地钱包")
  const source = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const parsed = readLocalWalletProfiles(envPath)
  const existingIds = new Set(parsed.profiles.map((profile) => profile.id))
  for (const id of selected) {
    if (!existingIds.has(id)) throw new Error(`未找到本地钱包：${id}`)
  }
  const kept = parsed.profiles.filter((profile) => !selected.has(profile.id))
  const config = nonWalletLines(source)
  const output = [...profileBlock(kept), ...(kept.length && config.length ? [""] : []), ...config].join("\n")
  writeWalletFile(envPath, output)
  return { removed: [...selected], remaining: kept.map(({ privateKey, account, ...profile }) => profile) }
}
