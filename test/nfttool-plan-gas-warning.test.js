import assert from "node:assert/strict"
import test from "node:test"

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) || null },
  setItem(key, value) { this.values.set(key, String(value)) },
  removeItem(key) { this.values.delete(key) },
}

const { renderPlan } = await import("../public/nfttool-runtime/core.js")

const RECIPIENT = `0x${"52".repeat(20)}`

// Gas limits are measured per entry now, because the old hardcoded 21000 sat below the
// intrinsic minimum on Nitro chains and got all 40 transfers of a disperse rejected. An
// entry whose estimate failed is still sendable — the signer estimates at broadcast — but
// silence would leave the operator unable to tell a measured plan from an unmeasured one.
test("a plan with unestimable entries surfaces them instead of hiding them", () => {
  const html = renderPlan({
    entries: [{ walletId: "w1", summary: "w1 -> w2 0.0001 ETH" }],
    gasWarnings: [{ walletId: "w2", to: RECIPIENT, error: "intrinsic gas too low" }],
  })
  assert.match(html, /Gas 估算失败/)
  assert.match(html, /w2/)
  assert.match(html, /intrinsic gas too low/)
})

test("a fully estimated plan shows no gas warning at all", () => {
  const html = renderPlan({ entries: [{ walletId: "w1", summary: "s" }], gasWarnings: [] })
  assert.doesNotMatch(html, /估算失败/)
})

test("a plan from a server that reports no gasWarnings field renders unchanged", () => {
  // Plans that never estimate — ERC20 transfers, many-to-many — omit the field entirely.
  const html = renderPlan({ entries: [{ walletId: "w1", summary: "s" }] })
  assert.doesNotMatch(html, /估算失败/)
  assert.match(html, /交易数/)
})

test("the warning count matches the number of unmeasured entries", () => {
  const html = renderPlan({
    entries: [{ walletId: "w1", summary: "s" }],
    gasWarnings: [
      { walletId: "w2", to: RECIPIENT, error: "boom" },
      { walletId: "w3", to: RECIPIENT, error: "boom" },
    ],
  })
  assert.match(html, /2 笔的 Gas 估算失败/)
})

test("an estimate error carrying markup is escaped, not injected into the preview", () => {
  const html = renderPlan({
    entries: [{ walletId: "w1", summary: "s" }],
    gasWarnings: [{ walletId: "w2", to: RECIPIENT, error: "<img src=x onerror=alert(1)>" }],
  })
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test("a warning without a walletId falls back to the shortened recipient address", () => {
  const html = renderPlan({
    entries: [{ walletId: "w1", summary: "s" }],
    gasWarnings: [{ to: RECIPIENT, error: "boom" }],
  })
  assert.match(html, /Gas 估算失败/)
  assert.match(html, /0x5252/)
})

test("excluded entries and gas warnings are both shown, not one replacing the other", () => {
  // They report different things: excluded entries will not be sent at all, unmeasured ones
  // will be sent with a signer-side estimate.
  const html = renderPlan({
    entries: [{ walletId: "w1", summary: "s" }],
    targetCount: 2,
    excluded: [{ walletId: "w9", reason: "发送金额为 0" }],
    gasWarnings: [{ walletId: "w2", to: RECIPIENT, error: "boom" }],
  })
  assert.match(html, /不会发送/)
  assert.match(html, /发送金额为 0/)
  assert.match(html, /Gas 估算失败/)
})

// OpenSea quotes USDG to the cent while the token carries 6 decimals, so a ladder price can
// be adjusted before it is postable. The seller must see that the number they typed is not
// the number being listed.
const { listingJobs } = await import("../public/nfttool-runtime/nft-management.js")

function usdgJob(rows) {
  return [{
    status: "previewed",
    marketplace: { label: "OpenSea" },
    currency: { symbol: "USDG", decimals: 6, quotedDecimals: 2 },
    rows,
    summary: { signatureCount: rows.length },
  }]
}

test("a rounded USDG price is reported with both the typed and the listed value", () => {
  const html = listingJobs(usdgJob([{ tokenId: "155", weiPrice: "2550000", requestedWeiPrice: "2545400" }]))
  assert.match(html, /1 笔价格已取整/)
  assert.match(html, /2\.5454/)
  assert.match(html, /2\.55/)
})

test("prices that needed no rounding produce no notice", () => {
  const html = listingJobs(usdgJob([{ tokenId: "155", weiPrice: "2550000" }]))
  assert.doesNotMatch(html, /取整/)
})

test("the notice counts every adjusted row, listing only the first few", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    tokenId: String(index),
    weiPrice: "2550000",
    requestedWeiPrice: "2545400",
  }))
  const html = listingJobs(usdgJob(rows))
  assert.match(html, /5 笔价格已取整/)
  assert.match(html, /等 5 笔/)
})

test("the listing currency is named so the seller knows what the price means", () => {
  const html = listingJobs(usdgJob([{ tokenId: "155", weiPrice: "2550000" }]))
  assert.match(html, /计价 USDG/)
})

// An order that expires sooner than the seller expects is indistinguishable from one that
// never posted. 55 listings were made with the old 15-minute default and had lapsed before
// anyone checked; the UI said only "已提交".
test("the listing duration is shown so a too-short order is visible before signing", () => {
  const html = listingJobs([{
    status: "previewed",
    marketplace: { label: "OpenSea" },
    durationSeconds: 604800,
    rows: [{ tokenId: "1", weiPrice: "2000000" }],
    summary: { signatureCount: 1 },
  }])
  assert.match(html, /有效期 7 天/)
})

test("a sub-hour duration is flagged, because it is almost certainly a mistake", () => {
  const html = listingJobs([{
    status: "previewed",
    marketplace: { label: "OpenSea" },
    durationSeconds: 900,
    rows: [{ tokenId: "1", weiPrice: "2000000" }],
    summary: { signatureCount: 1 },
  }])
  assert.match(html, /有效期 15 分钟/)
  assert.match(html, /warning-text/)
})

test("hours and days are labelled in their own units", () => {
  for (const [seconds, label] of [[7200, "2 小时"], [86400, "1 天"], [1296000, "15 天"]]) {
    const html = listingJobs([{
      status: "previewed",
      marketplace: { label: "OpenSea" },
      durationSeconds: seconds,
      rows: [{ tokenId: "1" }],
      summary: { signatureCount: 1 },
    }])
    assert.match(html, new RegExp(`有效期 ${label}`))
  }
})

test("a job with no duration renders without inventing one", () => {
  const html = listingJobs([{
    status: "previewed",
    marketplace: { label: "OpenSea" },
    rows: [{ tokenId: "1" }],
    summary: { signatureCount: 1 },
  }])
  assert.doesNotMatch(html, /有效期/)
})
