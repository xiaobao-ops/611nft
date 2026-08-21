import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")

test("Live Mint search keeps its control active when runtime filtering rerenders", () => {
  const core = source("apps/nfttool/runtime/core.js")
  const monitor = source("apps/nfttool/runtime/mint-monitor.js")

  assert.match(monitor, /input name="keyword"[^>]*placeholder="名称、合约或方法"/)
  assert.match(monitor, /form\.filters\.keyword = event\.target\.value; persistFilters\(form\); render\(\)/)
  assert.match(core, /function focusedControlSnapshot\(root\)/)
  assert.match(core, /function restoreFocusedControl\(root, snapshot\)/)
  assert.match(core, /control\.focus\(\{ preventScroll: true \}\)/)
  assert.match(core, /control\.setSelectionRange\(start, end, snapshot\.selectionDirection\)/)
  assert.match(core, /view\.bind\?\.\(app, context\);\s*restoreFocusedControl\(app, focused\)/)
})
