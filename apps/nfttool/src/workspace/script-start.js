export function mintScriptStartPayload(mode, preview = null) {
  if (mode === "dry-run") return { mode }
  if (mode !== "armed") throw new Error("运行器模式无效")

  const previewId = preview?.confirmation?.previewId
  const confirmationToken = preview?.confirmation?.confirmationToken
  if (!previewId || !confirmationToken) throw new Error("实盘运行器预览缺少确认凭据")

  return { mode, previewId, confirmationToken }
}
