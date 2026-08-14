const WEI_PER_NATIVE = 10n ** 18n

export function weiToNativeDecimal(value) {
  if (value === null || value === undefined || value === "") return ""
  const wei = BigInt(String(value))
  if (wei < 0n) throw new Error("Mint value cannot be negative")
  const whole = wei / WEI_PER_NATIVE
  const fraction = (wei % WEI_PER_NATIVE).toString().padStart(18, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function positiveInteger(value, fallback = "1") {
  const normalized = String(value ?? "").trim()
  return /^[1-9]\d*$/.test(normalized) ? normalized : fallback
}

function tokenId(value, fallback = "0") {
  const normalized = String(value ?? "").trim()
  return /^(0|[1-9]\d*)$/.test(normalized) ? normalized : fallback
}

export function mintSetupFromCollection(current, collection) {
  return {
    ...current,
    contractAddress: String(collection?.address || current.contractAddress || ""),
    quantity: "1",
    tokenId: "0",
    maxMintCostEth: collection?.mint_price_raw == null
      ? ""
      : weiToNativeDecimal(collection.mint_price_raw),
  }
}

export function mintSetupFromRecentMint(current, collection, mint) {
  const quantity = positiveInteger(mint?.quantity)
  const totalValueWei = mint?.mint_value_raw ?? (
    mint?.unit_price_raw == null ? null : BigInt(String(mint.unit_price_raw)) * BigInt(quantity)
  )
  return {
    ...current,
    contractAddress: String(collection?.address || current.contractAddress || ""),
    quantity,
    tokenId: collection?.token_standard === "ERC1155" ? tokenId(mint?.token_id) : "0",
    maxMintCostEth: totalValueWei == null
      ? ""
      : weiToNativeDecimal(totalValueWei),
  }
}
