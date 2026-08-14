import assert from "node:assert/strict"
import test from "node:test"
import {
  documentLanguage,
  monitorLanguageStorageKey,
  readMonitorLanguage,
  saveMonitorLanguage,
} from "../src/language.js"

test("Chinese is the safe default while supported browser preferences are respected", () => {
  const emptyStorage = { getItem: () => null }
  assert.equal(readMonitorLanguage(emptyStorage, undefined), "zh")
  assert.equal(readMonitorLanguage(emptyStorage, "zh-Hans-CN"), "zh")
  assert.equal(readMonitorLanguage(emptyStorage, "en-US"), "en")
  assert.equal(readMonitorLanguage(emptyStorage, "fr-FR"), "zh")
})

test("the saved 611nft language wins and maps to a valid document language", () => {
  const values = new Map([[monitorLanguageStorageKey, "en"]])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.equal(readMonitorLanguage(storage, "zh-CN"), "en")
  saveMonitorLanguage("zh-CN", storage)
  assert.equal(values.get(monitorLanguageStorageKey), "zh")
  assert.equal(documentLanguage("zh"), "zh-CN")
  assert.equal(documentLanguage("en"), "en")
})
