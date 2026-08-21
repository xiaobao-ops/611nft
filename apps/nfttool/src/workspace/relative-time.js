export function formatRelativeTime(timestamp, language = "en", nowMs = Date.now()) {
  const seconds = Math.floor(Math.max(0, nowMs / 1000 - Number(timestamp || 0)))
  if (seconds < 60) return language === "zh" ? `${seconds} 秒前` : `${seconds}s ago`
  if (seconds < 3600) return language === "zh" ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 60)}m ago`
  return language === "zh" ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 3600)}h ago`
}
