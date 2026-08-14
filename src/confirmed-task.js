const sensitiveResultKeys = new Set(["confirmationToken"])

export function confirmedTaskRequest(plan) {
  const previewId = String(plan?.confirmation?.previewId || "").trim()
  const confirmationToken = String(plan?.confirmation?.confirmationToken || "").trim()
  if (!previewId || !confirmationToken) throw new Error("Task preview did not return confirmation credentials")
  return { previewId, confirmationToken }
}

export function confirmedTaskPrompt(action, plan) {
  const count = Array.isArray(plan?.entries) ? plan.entries.length : 0
  return `${action}\n\n${count} transaction${count === 1 ? "" : "s"} will be submitted from local wallet profiles.`
}

export function redactSensitiveResult(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveResult)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveResultKeys.has(key) ? "[redacted]" : redactSensitiveResult(child),
  ]))
}
