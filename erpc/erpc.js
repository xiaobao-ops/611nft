const splitUrls = (value) => String(value || '')
  .split(/[\s,]+/)
  .map((item) => item.trim())
  .filter(Boolean);

const erpcHost = process.env.ERPC_HOST || '127.0.0.1';
const erpcPort = Number(process.env.ERPC_PORT || 4000);
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalLoop(endpoint) {
  try {
    const url = new URL(endpoint);
    return localHosts.has(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === erpcPort;
  } catch {
    return false;
  }
}

function upstreamUrls(listKey, legacyKey, defaults) {
  const configured = splitUrls(process.env[listKey]);
  const legacy = splitUrls(process.env[legacyKey]);
  const selected = configured.length ? configured : [...legacy, ...defaults];
  return [...new Set(selected)].filter((endpoint) => !isLocalLoop(endpoint));
}

const ethereumUrls = upstreamUrls('ETHEREUM_RPC_UPSTREAMS', 'ETHEREUM_RPC_URL', [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
]);
const robinhoodUrls = upstreamUrls('ROBINHOOD_RPC_UPSTREAMS', 'ROBINHOOD_RPC_URL', [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://rpc.arrowrpc.com',
]);

if (!ethereumUrls.length || !robinhoodUrls.length) {
  throw new Error('Each configured chain needs at least one non-local RPC upstream.');
}

const readMethods = 'eth_blockNumber|eth_gasPrice|eth_maxPriorityFeePerGas|eth_feeHistory|eth_getBalance|eth_getCode|eth_getTransactionCount|eth_call|eth_estimateGas|eth_getBlockByNumber|eth_getBlockByHash|eth_getTransactionByHash|eth_getTransactionReceipt|eth_getBlockReceipts|eth_getLogs|eth_getStorageAt';
const writeMethods = 'eth_sendRawTransaction|eth_sendTransaction|eth_submitTransaction|eth_submitWork|eth_submitHashrate';

function network(chainId) {
  return {
    architecture: 'evm',
    evm: {chainId},
    failsafe: [
      {
        matchMethod: writeMethods,
        timeout: {duration: '20s'},
        retry: {maxAttempts: 1},
      },
      {
        matchMethod: '*',
        timeout: {duration: '12s'},
        retry: {
          maxAttempts: 3,
          delay: '100ms',
          jitter: '100ms',
          backoffFactor: 1.5,
          backoffMaxDelay: '2s',
          emptyResultAccept: ['eth_call', 'eth_getLogs'],
        },
        hedge: {delay: '900ms', maxCount: 1},
      },
    ],
  };
}

function upstreams(chainId, prefix, urls) {
  return urls.map((endpoint, index) => ({
    id: `${prefix}-${index + 1}`,
    endpoint,
    type: 'evm',
    evm: {chainId},
    failsafe: [{
      matchMethod: '*',
      timeout: {duration: '8s'},
      retry: {maxAttempts: 1},
      circuitBreaker: {
        failureThresholdCount: 3,
        failureThresholdCapacity: 8,
        halfOpenAfter: '15s',
        successThresholdCount: 2,
        successThresholdCapacity: 3,
      },
    }],
  }));
}

export default {
  logLevel: process.env.ERPC_LOG_LEVEL || 'warn',
  server: {
    listenV4: true,
    httpHostV4: erpcHost,
    httpPortV4: erpcPort,
    maxTimeout: '25s',
    executionHeaders: 'summary',
  },
  metrics: {
    enabled: true,
    hostV4: erpcHost,
    port: Number(process.env.ERPC_METRICS_PORT || 4001),
  },
  database: {
    evmJsonRpcCache: {
      connectors: [{
        id: 'memory-cache',
        driver: 'memory',
        memory: {maxItems: 50000, maxTotalSize: '256MB'},
      }],
      policies: [
        {connector: 'memory-cache', network: '*', method: readMethods, finality: 'realtime', empty: 'ignore', ttl: '2s'},
        {connector: 'memory-cache', network: '*', method: readMethods, finality: 'unfinalized', empty: 'ignore', ttl: '12s'},
        {connector: 'memory-cache', network: '*', method: readMethods, finality: 'finalized', empty: 'ignore', ttl: '0s'},
      ],
    },
  },
  projects: [{
    id: 'main',
    scoreMetricsWindowSize: '10s',
    upstreamDefaults: {evm: {statePollerInterval: '3s'}},
    networks: [network(1), network(4663)],
    upstreams: [
      ...upstreams(1, 'ethereum', ethereumUrls),
      ...upstreams(4663, 'robinhood', robinhoodUrls),
    ],
  }],
};
