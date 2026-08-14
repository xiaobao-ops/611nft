const defaultLimit = 50

export function liveFeedSnapshot(events, chainId, limit = defaultLimit) {
  return (events || [])
    .filter((event) => Number(event.chainId) === Number(chainId))
    .slice(0, limit)
}

export function visibleLiveFeedEvents(events, chainId, pausedSnapshot = null, limit = defaultLimit) {
  return Array.isArray(pausedSnapshot)
    ? pausedSnapshot
    : liveFeedSnapshot(events, chainId, limit)
}
