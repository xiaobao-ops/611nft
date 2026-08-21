import assert from "node:assert/strict"
import test from "node:test"
import {
  documentLanguage,
  monitorLanguageStorageKey,
  readMonitorLanguage,
  saveMonitorLanguage,
} from "../src/language.js"

test("the retained interface stays Chinese for every browser preference", () => {
  const emptyStorage = { getItem: () => null }
  assert.equal(readMonitorLanguage(emptyStorage, undefined), "zh")
  assert.equal(readMonitorLanguage(emptyStorage, "zh-Hans-CN"), "zh")
  assert.equal(readMonitorLanguage(emptyStorage, "en-US"), "zh")
  assert.equal(readMonitorLanguage(emptyStorage, "fr-FR"), "zh")
})

test("saved legacy language values are normalized to Chinese", () => {
  const values = new Map([[monitorLanguageStorageKey, "en"]])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.equal(readMonitorLanguage(storage, "zh-CN"), "zh")
  saveMonitorLanguage("zh-CN", storage)
  assert.equal(values.get(monitorLanguageStorageKey), "zh")
  assert.equal(documentLanguage("zh"), "zh-CN")
  assert.equal(documentLanguage("en"), "zh-CN")
})
