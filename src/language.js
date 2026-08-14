export const monitorLanguageStorageKey = "611nft_lang"

export function normalizeMonitorLanguage(value, fallback = "zh") {
  const language = String(value || "").trim().toLowerCase()
  if (language === "zh" || language.startsWith("zh-")) return "zh"
  if (language === "en" || language.startsWith("en-")) return "en"
  return fallback
}

export function readMonitorLanguage(
  storage = globalThis.localStorage,
  browserLanguage,
) {
  const preferredLanguage = arguments.length >= 2 ? browserLanguage : globalThis.navigator?.language
  try {
    const saved = storage?.getItem(monitorLanguageStorageKey)
    if (saved) return normalizeMonitorLanguage(saved)
  } catch {
    // Fall through to the browser preference when storage is unavailable.
  }
  return normalizeMonitorLanguage(preferredLanguage)
}

export function saveMonitorLanguage(language, storage = globalThis.localStorage) {
  try {
    storage?.setItem(monitorLanguageStorageKey, normalizeMonitorLanguage(language))
  } catch {
    // Storage can be unavailable in strict privacy modes.
  }
}

export function documentLanguage(language) {
  return normalizeMonitorLanguage(language) === "zh" ? "zh-CN" : "en"
}
