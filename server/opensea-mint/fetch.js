// osmint routed OpenSea traffic through an undici ProxyAgent. This port drops
// that dependency: native fetch reaches OpenSea directly here, and an explicit
// proxy is a follow-up item rather than a silent no-op — see fetchOpenSea.

function failureDetail(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND") return "DNS lookup failed";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "connection timed out";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request timed out";
  return cause?.message || error?.message || "unknown network error";
}

export async function fetchOpenSea(opensea, input, init = {}, fetchImpl = fetch) {
  // An injected fetch is the test seam: pass it through untouched so stubs see
  // exactly the init the caller built.
  if (fetchImpl !== fetch) return fetchImpl(input, init);
  if (opensea?.proxyUrl) {
    // Failing loudly beats quietly bypassing a proxy the operator configured:
    // a direct request would leak the server's own IP to OpenSea.
    throw new Error("OPENSEA_PROXY_URL is set but this build has no proxy transport. Unset it or add an explicit proxy agent.");
  }
  // Callers normally supply their own AbortSignal built from
  // opensea.requestTimeoutMs; this covers the ones that do not, so no OpenSea
  // request can hang a mint task indefinitely.
  const request = init.signal || !opensea?.requestTimeoutMs
    ? init
    : {...init, signal: AbortSignal.timeout(opensea.requestTimeoutMs)};
  try {
    return await fetchImpl(input, request);
  } catch (error) {
    throw new Error(
      `OpenSea request failed by direct connection: ${failureDetail(error)}. Configure a proxy when OpenSea is only reachable through one.`,
      {cause: error},
    );
  }
}

// Kept so callers written against osmint keep working. Without undici there is
// no global dispatcher to swap, so the OpenSea SDK always connects directly.
export function configureOpenSeaSdkProxy() {
  return false;
}
