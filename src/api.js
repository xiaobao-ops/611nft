export async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await fetch(path, { ...options, headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败：${path}`)
  }
  return data
}
