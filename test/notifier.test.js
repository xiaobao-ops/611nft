import assert from "node:assert/strict"
import test from "node:test"
import { createTelegramNotifier } from "../server/notifier.js"

function response({ ok = true, status = 200, body = { ok: true }, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] || null } },
    async json() { return body },
  }
}

test("Telegram notifier is a no-op without complete configuration", async () => {
  let calls = 0
  const notifier = createTelegramNotifier({ fetchImpl: async () => { calls += 1 } })
  assert.equal(notifier.status().enabled, false)
  assert.deepEqual(await notifier.send({ title: "测试", message: "不会发送" }), { ok: true, skipped: true })
  assert.equal(calls, 0)
})

test("Telegram notifier sends escaped alert text without exposing its token in status", async () => {
  const calls = []
  const notifier = createTelegramNotifier({
    token: "secret-token",
    chatId: "611",
    minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return response()
    },
  })
  const result = await notifier.send({ title: "热度 <警报>", message: "A&B", chainId: 1 })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /secret-token\/sendMessage$/)
  assert.equal(calls[0].body.chat_id, "611")
  assert.match(calls[0].body.text, /热度 &lt;警报&gt;/)
  assert.match(calls[0].body.text, /A&amp;B/)
  assert.deepEqual(notifier.status(), { enabled: true, pending: 0, sent: 1, failed: 0, lastError: "" })
  assert.doesNotMatch(JSON.stringify(notifier.status()), /secret-token/)
})

test("Telegram notifier retries 429 using Retry-After and preserves queue order", async () => {
  const bodies = []
  const sleeps = []
  let attempts = 0
  const notifier = createTelegramNotifier({
    token: "token",
    chatId: "chat",
    minIntervalMs: 0,
    maxRetries: 2,
    sleep: async (ms) => { sleeps.push(ms) },
    fetchImpl: async (_url, options) => {
      attempts += 1
      bodies.push(JSON.parse(options.body).text)
      if (attempts === 1) return response({ ok: false, status: 429, body: { ok: false, parameters: { retry_after: 2 } } })
      return response()
    },
  })

  const first = notifier.send({ title: "first", message: "one" })
  const second = notifier.send({ title: "second", message: "two" })
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.deepEqual(sleeps, [2000])
  assert.deepEqual(bodies, ["<b>first</b>\none", "<b>first</b>\none", "<b>second</b>\ntwo"])
})

test("Telegram notifier retries transport failures and reports sanitized terminal errors", async () => {
  const sleeps = []
  let attempts = 0
  const notifier = createTelegramNotifier({
    token: "never-log-this",
    chatId: "private-chat-id",
    minIntervalMs: 0,
    maxRetries: 1,
    sleep: async (ms) => { sleeps.push(ms) },
    fetchImpl: async () => {
      attempts += 1
      throw new Error(`network down never-log-this private-chat-id attempt ${attempts}`)
    },
  })

  await assert.rejects(() => notifier.send({ title: "failed", message: "event" }), /network down \[redacted\]/)
  assert.deepEqual(sleeps, [500])
  assert.equal(notifier.status().failed, 1)
  assert.doesNotMatch(notifier.status().lastError, /never-log-this/)
  assert.doesNotMatch(notifier.status().lastError, /private-chat-id/)
})
