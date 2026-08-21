import assert from "node:assert/strict"
import test from "node:test"
import { mintQuantityFromEvent, validateQuickMintQuantity } from "../src/live-mint-quantity.js"

test("quick Mint inherits the selected transaction quantity instead of forcing one", () => {
  assert.equal(mintQuantityFromEvent({ quantity: "5" }), "5")
  assert.equal(mintQuantityFromEvent({ quantity: null }), "1")
})

test("quick Mint preserves an oversized source quantity and requires an explicit edit", () => {
  assert.equal(mintQuantityFromEvent({ quantity: "1200" }), "1200")
  assert.deepEqual(validateQuickMintQuantity("1200"), {
    valid: false,
    issue: "每钱包数量上限为 1000；链上原始数量已保留，请编辑后预览",
  })
  assert.equal(validateQuickMintQuantity("5", "3").valid, false)
  assert.equal(validateQuickMintQuantity("3", "3").valid, true)
})
