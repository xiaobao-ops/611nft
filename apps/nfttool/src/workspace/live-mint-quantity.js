export function mintQuantityFromEvent(event) {
  const value = String(event?.quantity ?? "").trim()
  return /^[1-9]\d*$/.test(value) ? value : "1"
}

export function validateQuickMintQuantity(value, maxPerWallet = "") {
  const quantity = String(value ?? "").trim()
  if (!/^[1-9]\d*$/.test(quantity)) return { valid: false, issue: "每钱包数量必须是正整数" }
  if (BigInt(quantity) > 1000n) return { valid: false, issue: "每钱包数量上限为 1000；链上原始数量已保留，请编辑后预览" }
  const limit = String(maxPerWallet ?? "").trim()
  if (/^[1-9]\d*$/.test(limit) && BigInt(quantity) > BigInt(limit)) {
    return { valid: false, issue: `当前数量超过项目公布的每钱包上限 ${limit}` }
  }
  return { valid: true, issue: "" }
}
