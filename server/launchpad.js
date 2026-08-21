const PROVIDERS = {
  "opensea.io": "OpenSea",
  "www.opensea.io": "OpenSea",
  "magiceden.io": "Magic Eden",
  "www.magiceden.io": "Magic Eden",
}

const CHAIN_SLUGS = {
  eth: 1,
  ethereum: 1,
  polygon: 137,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
}

function validateUrl(value) {
  let url
  try {
    url = new URL(String(value || "").trim())
  } catch {
    throw new Error("合集 URL 无效")
  }
  if (url.protocol !== "https:" || !PROVIDERS[url.hostname.toLowerCase()]) {
    throw new Error("合集 URL 必须来自 OpenSea 或 Magic Eden")
  }
  return url
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
}

function pageTitle(html) {
  const title = decodeHtml(/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] || "").trim()
  return title.replace(/\s*[|\-]\s*(?:OpenSea|Magic Eden).*$/i, "").slice(0, 160)
}

function inferredChain(url) {
  const values = [...url.pathname.split("/"), url.searchParams.get("chain") || ""]
  return values.map((value) => CHAIN_SLUGS[String(value).toLowerCase()]).find(Boolean) || null
}

function addressCandidates(url, html) {
  const values = new Map()
  const add = (value, score, evidence) => {
    const normalized = String(value || "").toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) return
    const current = values.get(normalized) || { address: normalized, score: 0, evidence: [] }
    current.score += score
    current.evidence.push(evidence)
    values.set(normalized, current)
  }
  for (const [, value] of url.searchParams) add(value, 100, "url_query")
  for (const value of url.pathname.match(/0x[a-fA-F0-9]{40}/g) || []) add(value, 100, "url_path")
  const patterns = [
    [/"(?:contractAddress|contract_address|tokenAddress|token_address)"\s*:\s*"(0x[a-fA-F0-9]{40})"/g, 50, "contract_field"],
    [/(?:contractAddress|contract_address|tokenAddress|token_address)\\?"?\s*[:=]\s*\\?"(0x[a-fA-F0-9]{40})/g, 35, "embedded_contract_field"],
    [/0x[a-fA-F0-9]{40}/g, 1, "page_address"],
  ]
  for (const [pattern, score, evidence] of patterns) {
    for (const match of html.matchAll(pattern)) add(match[1] || match[0], score, evidence)
  }
  return [...values.values()].sort((a, b) => b.score - a.score)
}

function methodSignature(html) {
  const match = /"methodSignature"\s*:\s*"([A-Za-z_$][\w$]*\((?:[A-Za-z0-9_$,[\]()]+)\))"/.exec(html)
  return match?.[1] || ""
}

async function fetchPage(startUrl, fetchImpl) {
  let url = startUrl
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetchImpl(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "NFT-TOOL/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 2) throw new Error("合集页面重定向次数过多")
      const redirected = validateUrl(new URL(response.headers.get("location"), url).toString())
      url = redirected
      continue
    }
    if (!response.ok) throw new Error(`合集页面请求失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length") || 0)
    if (declared > 3 * 1024 * 1024) throw new Error("合集页面内容过大")
    const html = await response.text()
    if (Buffer.byteLength(html) > 3 * 1024 * 1024) throw new Error("合集页面内容过大")
    return { url, html }
  }
  throw new Error("合集页面请求失败")
}

export async function resolveLaunchpad({ url: value, chainId, fetchImpl = fetch, hasContractCode }) {
  if (typeof hasContractCode !== "function") throw new TypeError("hasContractCode is required")
  const requestedUrl = validateUrl(value)
  const { url, html } = await fetchPage(requestedUrl, fetchImpl)
  const requestedChainId = Number(chainId)
  const pageChainId = inferredChain(url)
  if (pageChainId && pageChainId !== requestedChainId) {
    throw new Error(`合集页面属于链 ${pageChainId}，当前选择链为 ${requestedChainId}`)
  }
  const candidates = addressCandidates(url, html)
  let selected = null
  for (const candidate of candidates.slice(0, 20)) {
    if (await hasContractCode(candidate.address)) {
      selected = candidate
      break
    }
  }
  if (!selected) throw new Error("合集页面未暴露可验证的铸造合约地址，请检查链接或手动填写合约")
  return {
    provider: PROVIDERS[url.hostname.toLowerCase()],
    name: pageTitle(html),
    url: url.toString(),
    chainId: requestedChainId,
    contractAddress: selected.address,
    methodSignature: methodSignature(html),
    evidence: [...new Set(selected.evidence)],
  }
}

