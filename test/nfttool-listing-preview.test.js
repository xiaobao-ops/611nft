import assert from "node:assert/strict"
import test from "node:test"

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) || null },
  setItem(key, value) { this.values.set(key, String(value)) },
  removeItem(key) { this.values.delete(key) },
}

const { previewListings, readyListingJobs, submitListings } = await import("../apps/nfttool/runtime/nft-management.js")

const MARKETS = [
  { id: "opensea", label: "OpenSea" },
  { id: "x2y2", label: "X2Y2" },
  { id: "blur", label: "Blur" },
]

function sellForm() {
  return {
    snapshot: { snapshotId: "snap-1" },
    holdingIds: new Set(["a:7", "a:8"]),
    prices: { opensea: { "a:7": "0.2" }, x2y2: { "a:7": "0.3" }, blur: { "a:7": "0.4" } },
    amounts: {},
    durationValue: "15",
    durationUnit: "minutes",
  }
}

// Records how many previews are in flight at once so a serial `for await` loop is
// distinguishable from a parallel fan-out.
function trackingRequest(handler) {
  const state = { inFlight: 0, peak: 0, calls: [] }
  const request = async (path, options) => {
    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    state.calls.push({ path, body: JSON.parse(options.body), timeoutMs: options.timeoutMs })
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return await handler(JSON.parse(options.body))
    } finally {
      state.inFlight -= 1
    }
  }
  return { request, state }
}

test("marketplace previews run together instead of one platform at a time", async () => {
  const { request, state } = trackingRequest(async (body) => ({ job: { id: `${body.marketplace}-job`, status: "previewed", marketplace: { id: body.marketplace }, rows: [], summary: { ready: true } } }))
  const started = Date.now()
  const { jobs, failures } = await previewListings(sellForm(), MARKETS, request)
  const elapsed = Date.now() - started

  assert.equal(state.peak, MARKETS.length, "all three platform previews must be in flight at once")
  assert.ok(elapsed < 60, `three 20ms previews took ${elapsed}ms, which looks serial`)
  assert.equal(failures.length, 0)
  assert.deepEqual(jobs.map((job) => job.id), ["opensea-job", "x2y2-job", "blur-job"])
  assert.deepEqual(state.calls.map((call) => call.body.marketplace).sort(), ["blur", "opensea", "x2y2"])
  assert.ok(state.calls.every((call) => call.body.durationSeconds === 900), "duration is resolved once for the batch")
  assert.ok(state.calls.every((call) => call.timeoutMs === undefined), "the deadline comes from the path rule, not per call site")
  assert.deepEqual(state.calls[0].body.holdingIds, ["a:7", "a:8"])
})

test("one failing platform keeps the others and reports its own reason", async () => {
  const { request } = trackingRequest(async (body) => {
    if (body.marketplace === "x2y2") throw new Error("X2Y2 路由返回 503")
    return { job: { id: `${body.marketplace}-job`, status: "previewed", marketplace: { id: body.marketplace }, rows: [], summary: { ready: true } } }
  })
  const { jobs, failures } = await previewListings(sellForm(), MARKETS, request)

  assert.equal(jobs.length, 3)
  assert.equal(failures.length, 1)
  assert.deepEqual(jobs.map((job) => job.status), ["previewed", "failed", "previewed"])
  assert.equal(jobs[1].error, "X2Y2 路由返回 503")
  assert.equal(jobs[1].marketplace.label, "X2Y2", "the failed row still names its platform")
  assert.equal(jobs[1].summary, null, "a failed preview is never submittable")
  assert.equal(jobs.filter((job) => job.status === "previewed" && job.summary?.ready).length, 2)
})

test("every platform failing yields failed jobs rather than a lost batch", async () => {
  const { request } = trackingRequest(async () => { throw new Error("请求超时：/api/nft-listings/preview 在 120 秒内没有响应") })
  const { jobs, failures } = await previewListings(sellForm(), MARKETS, request)

  assert.equal(failures.length, MARKETS.length)
  assert.equal(jobs.length, MARKETS.length)
  assert.ok(jobs.every((job) => job.status === "failed"))
  assert.match(jobs[0].error, /请求超时/)
})

test("an invalid duration rejects before any platform is contacted", async () => {
  const { request, state } = trackingRequest(async () => ({ job: {} }))
  const form = { ...sellForm(), durationValue: "0" }
  await assert.rejects(() => previewListings(form, MARKETS, request), /挂单有效期无效/)
  assert.equal(state.calls.length, 0)
})

function readyJob(id, rows = 1) {
  return {
    id,
    status: "previewed",
    marketplace: { id, label: id },
    rows: Array.from({ length: rows }, (_, index) => ({ holdingId: `a:${index}` })),
    summary: { ready: true, requiresApproval: false },
    confirmation: { previewId: `${id}-preview`, confirmationToken: `${id}-token` },
  }
}

function submitStub(handler) {
  const calls = []
  const request = async (path, options) => {
    const body = JSON.parse(options.body)
    calls.push({ path, body })
    if (path.endsWith("/preview")) return handler.preview(body)
    return handler.submit ? handler.submit(body) : { job: { ...readyJob(body.previewId), status: "submitted" } }
  }
  return { request, calls }
}

test("listing directly generates the preview itself instead of demanding a click", async () => {
  const { request, calls } = submitStub({
    preview: (body) => ({ job: readyJob(body.marketplace) }),
  })
  const form = { ...sellForm(), jobs: [] }
  const submitted = await submitListings(form, [MARKETS[0]], request)

  assert.deepEqual(calls.map((call) => call.path), [
    "/api/nft-listings/preview",
    "/api/nft-listings/submit",
  ], "preview then submit, in one action")
  assert.equal(calls[1].body.previewId, "opensea-preview", "the generated preview credentials are what gets submitted")
  assert.equal(calls[1].body.confirmationToken, "opensea-token")
  assert.equal(submitted.length, 1)
  assert.equal(form.jobs[0].status, "submitted", "the row reflects the submitted job")
})

test("an existing preview is reused rather than regenerated", async () => {
  const { request, calls } = submitStub({
    preview: () => { throw new Error("must not re-preview") },
  })
  const form = { ...sellForm(), jobs: [readyJob("opensea"), readyJob("blur")] }
  await submitListings(form, MARKETS, request)
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/nft-listings/submit",
    "/api/nft-listings/submit",
  ])
})

test("an unapproved wallet stops the direct path with an actionable message", async () => {
  const { request, calls } = submitStub({
    preview: (body) => ({
      job: {
        id: body.marketplace,
        status: "previewed",
        marketplace: { id: body.marketplace, label: "OpenSea" },
        rows: [],
        summary: { ready: false, requiresApproval: true, transactionCount: 1 },
        confirmation: { previewId: "p", confirmationToken: "t" },
      },
    }),
  })
  const form = { ...sellForm(), jobs: [] }
  await assert.rejects(() => submitListings(form, [MARKETS[0]], request), /未授权的钱包/)
  assert.equal(calls.filter((call) => call.path.endsWith("/submit")).length, 0, "nothing is signed while approval is missing")
})

test("a failed preview surfaces its own reason instead of a generic one", async () => {
  const { request } = submitStub({
    preview: () => { throw new Error("OpenSea 拒单：invalid conduit key") },
  })
  const form = { ...sellForm(), jobs: [] }
  await assert.rejects(() => submitListings(form, [MARKETS[0]], request), /invalid conduit key/)
})

test("readyListingJobs only accepts previews that are actually submittable", () => {
  assert.equal(readyListingJobs(null).length, 0)
  assert.equal(readyListingJobs([{ status: "failed", summary: { ready: true }, confirmation: {} }]).length, 0)
  assert.equal(readyListingJobs([{ status: "previewed", summary: { ready: false }, confirmation: {} }]).length, 0)
  assert.equal(readyListingJobs([{ status: "previewed", summary: { ready: true } }]).length, 0, "no credentials, not submittable")
  assert.equal(readyListingJobs([readyJob("opensea")]).length, 1)
})

const { renderTaskResult } = await import("../apps/nfttool/runtime/core.js")

test("an execution result names every entry's fate, not just the successes", () => {
  // An 11-wallet disperse that broadcasts 7 must say what became of the other 4; the old
  // code threw the whole response away and toasted "任务已提交".
  const html = renderTaskResult({
    taskId: "task-1",
    results: [
      ...Array.from({ length: 7 }, (_, i) => ({ toWalletId: `w${i + 1}`, ok: true, status: "confirmation_pending", txHash: `0x${i}` })),
      { toWalletId: "w8", ok: false, status: "failed", error: "insufficient funds for gas" },
      { toWalletId: "w9", ok: false, status: "skipped", error: "前一笔广播结果待确认" },
      { toWalletId: "w10", ok: false, status: "skipped", error: "前一笔广播结果待确认" },
      { toWalletId: "w11", ok: false, status: "skipped", error: "前一笔广播结果待确认" },
    ],
  })
  assert.match(html, /11 笔/)
  assert.match(html, /7 成功/)
  assert.match(html, /1 失败/)
  assert.match(html, /3 未执行/)
  assert.match(html, /insufficient funds for gas/, "the reason travels to the operator verbatim")
  for (const wallet of ["w1", "w8", "w9", "w11"]) assert.match(html, new RegExp(wallet), `${wallet} must appear`)
})

test("a fully successful run reads as successful", () => {
  const html = renderTaskResult({ taskId: "t", results: [{ walletId: "a", ok: true, txHash: "0x1" }] })
  assert.match(html, /success-text/)
  assert.doesNotMatch(html, /失败|未执行/)
})

test("no result means no panel at all", () => {
  assert.equal(renderTaskResult(null), "")
  assert.equal(renderTaskResult({ results: [] }), "")
})
