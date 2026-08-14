import { parseUnits } from 'ethers';

const LONG_HEX_DATA = /0x[0-9a-fA-F]{64,}/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

function replaceExact(value, secret, replacement) {
  if (!secret) return value;
  return value.split(secret).join(replacement);
}

function redactKnownUrl(value, rawUrl, label) {
  if (!rawUrl) return value;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return replaceExact(value, rawUrl, `[${label} URL]`);
  }

  let redacted = replaceExact(value, rawUrl, `[${label} URL: ${parsed.hostname}]`);
  const components = [
    parsed.username,
    parsed.password,
    ...parsed.pathname.split('/').filter(Boolean),
    ...[...parsed.searchParams.entries()].flatMap(([key, item]) => [key, item]),
  ];
  for (const component of components.filter(Boolean)) {
    redacted = replaceExact(redacted, component, `[redacted ${label} URL component]`);
    try {
      redacted = replaceExact(
        redacted,
        decodeURIComponent(component),
        `[redacted ${label} URL component]`,
      );
    } catch {
      // The exact encoded component was already covered.
    }
  }
  return redacted;
}

function collectErrorText(error, seen = new Set()) {
  if (error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  if (seen.has(error)) return '';
  seen.add(error);

  const parts = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (error.source !== undefined) parts.push(collectErrorText(error.source, seen));
  if (error.cause !== undefined) parts.push(collectErrorText(error.cause, seen));
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) parts.push(collectErrorText(nested, seen));
  }
  return parts.filter(Boolean).join(' | ');
}

export function sanitizeRuntimeError(
  error,
  { rpcUrl, ticketUrl, proxyApiUrl, proxyUrls = [] } = {},
) {
  let message = collectErrorText(error) || String(error);
  message = redactKnownUrl(message, rpcUrl, 'RPC');
  message = redactKnownUrl(message, ticketUrl, 'Ticket');
  message = redactKnownUrl(message, proxyApiUrl, 'Proxy API');
  for (const proxyUrl of proxyUrls) {
    message = redactKnownUrl(message, proxyUrl, 'Proxy');
  }
  return message
    .replace(URL_CREDENTIALS, '$1[redacted credentials]@')
    .replace(LONG_HEX_DATA, '[redacted hex data]');
}

export function assertGasWithinLimits({ gasEstimate, feeData, config }) {
  if (gasEstimate > config.maxGasLimit) {
    throw new Error('gas estimate exceeds configured limit');
  }

  const maxFeePerGas = parseUnits(String(config.maxFeePerGasGwei), 'gwei');
  if (
    feeData?.maxFeePerGas !== null &&
    feeData?.maxFeePerGas !== undefined &&
    feeData?.maxPriorityFeePerGas !== null &&
    feeData?.maxPriorityFeePerGas !== undefined &&
    feeData.maxPriorityFeePerGas > feeData.maxFeePerGas
  ) {
    throw new Error('priority fee exceeds max fee');
  }

  const feeValues = [
    feeData?.maxFeePerGas,
    feeData?.maxPriorityFeePerGas,
    feeData?.gasPrice,
  ].filter(
    (value) => value !== null && value !== undefined,
  );
  if (feeValues.length === 0) {
    throw new Error('fee data unavailable');
  }
  const effectiveFeePerGas = feeValues.reduce(
    (largest, value) => (value > largest ? value : largest),
    0n,
  );

  if (effectiveFeePerGas > maxFeePerGas) {
    throw new Error('fee per gas exceeds configured limit');
  }

  if (
    feeData?.maxFeePerGas !== null &&
    feeData?.maxFeePerGas !== undefined &&
    feeData?.maxPriorityFeePerGas !== null &&
    feeData?.maxPriorityFeePerGas !== undefined
  ) {
    return Object.freeze({
      // On EIP-1559 chains maxFeePerGas is a ceiling, not the amount paid.
      // Signing the configured hard cap provides headroom for a short base-fee
      // rise between estimation and sequencer acceptance while preserving the
      // user's audited worst-case cost and the node's priority fee.
      maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    });
  }

  if (feeData?.gasPrice !== null && feeData?.gasPrice !== undefined) {
    return Object.freeze({ gasPrice: feeData.gasPrice });
  }

  throw new Error('explicit fee data unavailable');
}
