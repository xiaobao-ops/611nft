export const monitorLanguageStorageKey = "611nft_lang"

export function normalizeMonitorLanguage() {
  return "zh"
}

export function readMonitorLanguage() {
  return "zh"
}

export function saveMonitorLanguage(_language, storage = globalThis.localStorage) {
  try {
    storage?.setItem(monitorLanguageStorageKey, "zh")
  } catch {
    // 严格隐私模式下可能不开放本地存储。
  }
}

export function documentLanguage() {
  return "zh-CN"
}
