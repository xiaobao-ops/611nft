import assert from "node:assert/strict"
import test from "node:test"
import { canChangeMintInputs, isMintJobSending } from "../src/mint-job-state.js"

test("Mint inputs remain locked for the complete sending phase", () => {
  assert.equal(isMintJobSending({ status: "sending" }), true)
  assert.equal(canChangeMintInputs({ status: "sending" }), false)
  assert.equal(canChangeMintInputs({ status: "completed" }), true)
  assert.equal(canChangeMintInputs(null), true)
})
