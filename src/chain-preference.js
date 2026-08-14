export const chainStorageKey = "evm-board-selected-chain"
export const defaultChainId = 1

export function parseStoredChainId(value, fallback = defaultChainId) {
  const chainId = Number(value)
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : fallback
}

export function resolveSupportedChainId(chainId, chains, fallback = defaultChainId) {
  const supported = (chains || []).map((chain) => Number(chain.id)).filter(Number.isSafeInteger)
  if (supported.includes(Number(chainId))) return Number(chainId)
  if (supported.includes(Number(fallback))) return Number(fallback)
  return supported[0] || fallback
}

export function readStoredChainId(storage = globalThis.localStorage, fallback = defaultChainId) {
  try {
    return parseStoredChainId(storage?.getItem(chainStorageKey), fallback)
  } catch {
    return fallback
  }
}

export function saveStoredChainId(chainId, storage = globalThis.localStorage) {
  try {
    storage?.setItem(chainStorageKey, String(parseStoredChainId(chainId)))
  } catch {
    // Storage can be unavailable in strict privacy modes.
  }
}
