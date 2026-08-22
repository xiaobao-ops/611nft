import assert from "node:assert/strict"
import test from "node:test"

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) || null },
  setItem(key, value) { this.values.set(key, String(value)) },
  removeItem(key) { this.values.delete(key) },
}

const { api, requestDeadline } = await import("../apps/nfttool/runtime/core.js")

const originalFetch = globalThis.fetch

test.afterEach(() => { globalThis.fetch = originalFetch })

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

// AbortSignal.timeout() uses an unref'd timer, so nothing would keep the Node event
// loop alive while a stubbed request hangs. Browsers never exit; tests have to say so.
function keepAlive() {
  const timer = setInterval(() => {}, 1000)
  return () => clearInterval(timer)
}

// A server that accepted the connection and never answers: the promise only settles
// when someone aborts the request.
function neverAnswers(seen = []) {
  return (path, init) => {
    seen.push({ path, init })
    const stop = keepAlive()
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        stop()
        reject(init.signal.reason ?? new Error("aborted"))
      }, { once: true })
    })
  }
}

test("a request that never answers rejects on its own deadline instead of hanging", async () => {
  const seen = []
  globalThis.fetch = neverAnswers(seen)
  const started = Date.now()
  const error = await api("/api/nft-listings/preview", { method: "POST", timeoutMs: 80 }).then(
    () => null,
    (reason) => reason,
  )
  assert.ok(error, "the request must reject rather than stay pending forever")
  assert.equal(error.name, "TimeoutError")
  assert.equal(error.timeoutMs, 80)
  assert.match(error.message, /请求超时/)
  assert.match(error.message, /\/api\/nft-listings\/preview/)
  assert.ok(Date.now() - started < 3000, "the deadline must fire promptly")
  assert.equal(seen[0].init.signal.aborted, true, "the underlying fetch is aborted, not left running")
})

test("a caller supplied abort still surfaces as AbortError", async () => {
  // mint-monitor.js branches on error.name === 'AbortError' for its own 8s cancel,
  // so the deadline wrapper must not rewrite caller aborts into timeouts.
  globalThis.fetch = neverAnswers()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25)
  try {
    const error = await api("/api/mint-monitor/collection/0xabc", { signal: controller.signal, timeoutMs: 60_000 }).then(
      () => null,
      (reason) => reason,
    )
    assert.ok(error)
    assert.equal(error.name, "AbortError")
    assert.doesNotMatch(String(error.message), /请求超时/)
  } finally {
    clearTimeout(timer)
  }
})

test("reads and writes get different default budgets and explicit overrides win", () => {
  assert.equal(requestDeadline({ method: "GET" }).budget, 30_000)
  assert.equal(requestDeadline({ method: "POST" }).budget, 300_000)
  assert.equal(requestDeadline().budget, 30_000)
  assert.equal(requestDeadline({ method: "POST", timeoutMs: 5_000 }).budget, 5_000)
  assert.equal(requestDeadline({ method: "POST", timeoutMs: 0 }).budget, 300_000)
  assert.equal(requestDeadline({ method: "POST", timeoutMs: Number.NaN }).budget, 300_000)
})

test("normal responses and server errors keep their existing shape", async () => {
  globalThis.fetch = async () => jsonResponse({ ok: true, wallets: [{ id: "a" }] })
  assert.deepEqual(await api("/api/wallets"), { ok: true, wallets: [{ id: "a" }] })

  globalThis.fetch = async () => jsonResponse({ ok: false, error: "未找到钱包：a" }, 404)
  const error = await api("/api/wallets").then(() => null, (reason) => reason)
  assert.equal(error.status, 404)
  assert.equal(error.message, "未找到钱包：a")
  assert.equal(error.name, "Error")
})

test("a body that stops mid stream reports a timeout instead of an empty payload", async () => {
  globalThis.fetch = async (path, init) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: () => {
      const stop = keepAlive()
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          stop()
          reject(init.signal.reason ?? new Error("aborted"))
        }, { once: true })
      })
    },
  })
  const error = await api("/api/token-holdings/query", { method: "POST", timeoutMs: 80 }).then(
    () => null,
    (reason) => reason,
  )
  assert.ok(error, "a truncated body must not silently resolve to {}")
  assert.equal(error.name, "TimeoutError")
})

test("malformed JSON on a successful response still degrades to an empty object", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => { throw new SyntaxError("Unexpected token <") },
  })
  assert.deepEqual(await api("/api/chains"), {})
})

test("planning and holdings POSTs get the read budget, task POSTs keep the write one", async () => {
  const { isReadOnlyRequest } = await import("../apps/nfttool/runtime/core.js")
  // These build a preview from chain reads and broadcast nothing, so a short deadline is
  // free. Under the write budget a slow one held the global busy lock for five minutes.
  for (const path of ["/api/plan/one-to-many", "/api/plan/token-collect", "/api/plan/nft-approval", "/api/token-holdings/query", "/api/nft-listings/preview"]) {
    assert.equal(isReadOnlyRequest(path, "POST"), true, path)
    assert.equal(requestDeadline({ path, method: "POST" }).budget, 60_000, path)
  }
  // Anything that actually sends transactions must keep the long budget: aborting a live
  // broadcast invites a retry that double-sends.
  for (const path of ["/api/tasks/one-to-many", "/api/tasks/token-collect", "/api/nft-listings/submit", "/api/wallets/export"]) {
    assert.equal(isReadOnlyRequest(path, "POST"), false, path)
    assert.equal(requestDeadline({ path, method: "POST" }).budget, 300_000, path)
  }
  // A query string must not defeat the match.
  assert.equal(isReadOnlyRequest("/api/plan/one-to-many?x=1", "POST"), true)
  // An explicit override still wins.
  assert.equal(requestDeadline({ path: "/api/tasks/one-to-many", method: "POST", timeoutMs: 5_000 }).budget, 5_000)
})
