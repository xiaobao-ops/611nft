import assert from "node:assert/strict"
import test from "node:test"

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const { previewOffers, submitOffers } = await import("../public/nfttool-runtime/nft-management.js")

function form() {
  const offer = { priceValue: "1000000", unitPriceValue: "1000000", priceDecimals: 6, priceCurrency: "USDG", quantity: "2", scope: "collection" }
  return {
    holdingIds: new Set(["w:1", "w:2"]),
    snapshot: { snapshotId: "snap", holdings: { rows: [
      { id: "w:1", tokenId: "1", bestOffer: offer, offers: [offer] },
      { id: "w:2", tokenId: "2", offers: [] },
    ] } },
  }
}

test("offer preview only submits selected holdings that have offers", async () => {
  const calls = []
  const request = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) })
    return { entries: [{ walletId: "w", tokenId: "1" }], confirmation: { previewId: "p", confirmationToken: "t" } }
  }
  const result = await previewOffers(form(), request)
  assert.equal(result.entries.length, 1)
  assert.deepEqual(calls[0].body.holdingIds, ["w:1"])
})

test("submitOffers consumes the server preview confirmation", async () => {
  const calls = []
  const request = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) })
    if (path.endsWith("/preview")) return { entries: [{ walletId: "w", tokenId: "1" }], confirmation: { previewId: "p", confirmationToken: "t" } }
    return { ok: true, taskId: "task" }
  }
  const result = await submitOffers(form(), request)
  assert.equal(result.taskId, "task")
  assert.deepEqual(calls.map((call) => call.path), ["/api/nft-offers/preview", "/api/tasks/nft-offers/accept"])
  assert.deepEqual(calls[1].body, { previewId: "p", confirmationToken: "t" })
})
