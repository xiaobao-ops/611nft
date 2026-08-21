const defaultLimit = 50

export function liveFeedSnapshot(events, chainId, limit = defaultLimit) {
  return (events || [])
    .filter((event) => Number(event.chainId) === Number(chainId))
    .slice(0, limit)
}

export function liveFeedOrderSnapshot(events, chainId, limit = defaultLimit) {
  return liveFeedSnapshot(events, chainId, limit).map((event) => event.id)
}

export function visibleLiveFeedEvents(events, chainId, pausedSnapshot = null, limit = defaultLimit) {
  const current = liveFeedSnapshot(events, chainId, limit)
  if (!Array.isArray(pausedSnapshot)) return current
  const byId = new Map(current.map((event) => [event.id, event]))
  return pausedSnapshot.map((item) => byId.get(typeof item === "string" ? item : item?.id) || (typeof item === "object" ? item : null)).filter(Boolean)
}
