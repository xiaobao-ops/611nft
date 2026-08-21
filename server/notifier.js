function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function alertText(alert = {}) {
  const lines = [
    `<b>${escapeHtml(alert.title || "611nft 报警")}</b>`,
    escapeHtml(alert.message || "检测到新的监控事件"),
  ]
  if (alert.subject?.address) lines.push(`<code>${escapeHtml(alert.subject.address)}</code>`)
  if (alert.chainId) lines.push(`Chain ${escapeHtml(alert.chainId)}`)
  return lines.join("\n")
}

function retrySeconds(response, payload) {
  const headerValue = response?.headers?.get?.("retry-after")
  const bodyValue = payload?.parameters?.retry_after
  const header = headerValue === null || headerValue === undefined || headerValue === "" ? null : Number(headerValue)
  const body = bodyValue === null || bodyValue === undefined || bodyValue === "" ? null : Number(bodyValue)
  if (header !== null && Number.isFinite(header) && header >= 0) return header
  if (body !== null && Number.isFinite(body) && body >= 0) return body
  return null
}

export function createTelegramNotifier({
  token = process.env.TELEGRAM_BOT_TOKEN || "",
  chatId = process.env.TELEGRAM_CHAT_ID || "",
  fetchImpl = fetch,
  minIntervalMs = 1100,
  maxRetries = 3,
  timeoutMs = 10_000,
  sleep = wait,
  now = Date.now,
} = {}) {
  const secret = String(token || "").trim()
  const destination = String(chatId || "").trim()
  const enabled = Boolean(secret && destination)
  let tail = Promise.resolve()
  let pending = 0
  let lastSentAt = 0
  let sent = 0
  let failed = 0
  let lastError = ""

  function sanitize(value) {
    let message = value instanceof Error ? value.message : String(value)
    for (const sensitive of [secret, destination]) {
      if (sensitive) message = message.split(sensitive).join("[redacted]")
    }
    return message
  }

  async function request(alert) {
    const elapsed = Number(now()) - lastSentAt
    if (lastSentAt && elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed)
    const url = `https://api.telegram.org/bot${secret}/sendMessage`
    let terminalError
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response
      let payload
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: destination,
            text: alertText(alert),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        payload = await response.json().catch(() => null)
        if (response.ok && payload?.ok !== false) {
          lastSentAt = Number(now())
          sent += 1
          lastError = ""
          return { ok: true, messageId: payload?.result?.message_id ?? null }
        }
        const error = new Error(`Telegram HTTP ${response.status}${payload?.description ? `: ${payload.description}` : ""}`)
        error.status = response.status
        error.retryAfterSeconds = retrySeconds(response, payload)
        throw error
      } catch (error) {
        terminalError = error
        if (attempt >= maxRetries) break
        const delay = error?.status === 429 && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1000
          : 500 * (2 ** attempt)
        await sleep(delay)
      }
    }
    failed += 1
    lastError = sanitize(terminalError)
    throw new Error(lastError)
  }

  function send(alert) {
    if (!enabled) return Promise.resolve({ ok: true, skipped: true })
    pending += 1
    const task = tail.then(() => request(alert)).finally(() => {
      pending -= 1
    })
    tail = task.catch(() => {})
    return task
  }

  function status() {
    return { enabled, pending, sent, failed, lastError }
  }

  async function flush() {
    await tail
    return status()
  }

  return { send, flush, status }
}
