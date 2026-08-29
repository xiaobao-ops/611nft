export async function broadcastWithFailover({
  endpoints,
  send,
  isUncertain = () => false,
  isConnectionFailure = () => false,
} = {}) {
  const candidates = Array.isArray(endpoints) ? endpoints.filter(Boolean) : []
  if (!candidates.length) throw new Error("没有可用的写入 RPC endpoint")
  for (let index = 0; index < candidates.length; index += 1) {
    const endpoint = candidates[index]
    try {
      return await send(endpoint)
    } catch (error) {
      if (isUncertain(error) || !isConnectionFailure(error) || index === candidates.length - 1) throw error
    }
  }
  throw new Error("没有可用的写入 RPC endpoint")
}
