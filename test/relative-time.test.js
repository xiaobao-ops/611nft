import assert from "node:assert/strict"
import test from "node:test"
import { formatRelativeTime } from "../src/relative-time.js"

test("relative seconds never expose timestamp fractional precision", () => {
  assert.equal(formatRelativeTime(99.123, "en", 100_900), "1s ago")
  assert.equal(formatRelativeTime(99.123, "zh", 100_900), "1 秒前")
})

test("relative time clamps future timestamps and keeps minute/hour labels compact", () => {
  assert.equal(formatRelativeTime(101.5, "en", 100_900), "0s ago")
  assert.equal(formatRelativeTime(39.5, "en", 100_900), "1m ago")
  assert.equal(formatRelativeTime(-3_500.5, "zh", 100_900), "1 小时前")
})
