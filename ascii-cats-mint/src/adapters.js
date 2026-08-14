import { getAddress } from 'ethers';

import { verifyTicketAuthorization } from './ticket.js';

function receiptStatus(receipt) {
  if (receipt?.status === 1 || receipt?.status === 1n || receipt?.status === true) {
    return 'confirmed';
  }
  if (receipt?.status === 0 || receipt?.status === 0n || receipt?.status === false) {
    return 'failed';
  }
  throw new Error('unknown transaction receipt status');
}

function requestAbortSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Ticket API request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export function createTicketClient({
  url,
  fetchFn,
  dispatcher,
  getDispatcher,
  requireDispatcher = false,
  timeoutMs = 10_000,
  signal,
}) {
  if (dispatcher !== undefined && getDispatcher !== undefined) {
    throw new Error('dispatcher and getDispatcher cannot both be provided');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Ticket API timeout must be a positive integer');
  }
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function')) {
    throw new Error('Ticket API signal must be an AbortSignal');
  }

  return Object.freeze({
    async request(address) {
      const requestDispatcher = getDispatcher ? getDispatcher() : dispatcher;
      if (requireDispatcher && !requestDispatcher) {
        throw new Error('Ticket dispatcher is required');
      }
      const requestAbort = requestAbortSignal(signal, timeoutMs);
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
        signal: requestAbort.signal,
      };
      // Route this wallet's ticket request through its bound proxy so the
      // backend sees a distinct egress IP (1 IP = 1 mint). Omit the key
      // entirely when unset so direct requests behave exactly as before.
      if (requestDispatcher) options.dispatcher = requestDispatcher;

      try {
        let response;
        try {
          response = await fetchFn(url, options);
        } catch (error) {
          const message = signal?.aborted
            ? 'Ticket API request aborted'
            : 'Ticket API request failed or timed out';
          throw new Error(message, { cause: error });
        }

        if (!response.ok) {
          throw new Error(`Ticket API HTTP ${response.status}`);
        }

        try {
          return await response.json();
        } catch (error) {
          if (requestAbort.signal.aborted) {
            const message = signal?.aborted
              ? 'Ticket API request aborted'
              : 'Ticket API request failed or timed out';
            throw new Error(message, { cause: error });
          }
          throw new Error('Ticket API returned invalid JSON', { cause: error });
        }
      } catch (error) {
        throw error;
      } finally {
        requestAbort.cleanup();
      }
    },
  });
}

// Read-only chain view for the single shared monitor loop. No wallet is bound,
// so it can never send — only poll chain id, mint status, and supply.
export function createMonitorChain({ provider, contract }) {
  return Object.freeze({
    async getChainId() {
      return (await provider.getNetwork()).chainId;
    },
    async isMintOpen() {
      return contract.mintOpen();
    },
    async totalMinted() {
      return contract.totalMinted();
    },
  });
}

export function createEthersChain({ provider, wallet, contract }) {
  if (!wallet) throw new Error('wallet is required');

  return Object.freeze({
    async getChainId() {
      return (await provider.getNetwork()).chainId;
    },

    async isMintOpen() {
      return contract.mintOpen();
    },

    async totalMinted() {
      return contract.totalMinted();
    },

    async hasMinted(address) {
      return contract.hasMinted(address);
    },

    async getMintSigner() {
      return contract.mintSigner();
    },

    async isSaltUsed(salt) {
      return contract.saltUsed(salt);
    },

    async verifyTicket(ticket, walletAddress) {
      const [network, mintSigner, saltAlreadyUsed] = await Promise.all([
        provider.getNetwork(),
        contract.mintSigner(),
        contract.saltUsed(ticket.salt),
      ]);
      if (saltAlreadyUsed) throw new Error('ticket salt already used');
      return verifyTicketAuthorization({
        ticket,
        chainId: network.chainId,
        contractAddress: contract.target,
        walletAddress,
        mintSigner,
      });
    },

    async getFeeData() {
      return provider.getFeeData();
    },

    async estimateMint({ salt, signature }) {
      return contract.mint.estimateGas(salt, signature);
    },

    async simulateMint({ salt, signature }, transactionOverrides) {
      return contract.mint.staticCall(salt, signature, transactionOverrides);
    },

    async sendMint({ salt, signature }, transactionOverrides) {
      return contract.mint(salt, signature, transactionOverrides);
    },

    async waitForTransaction(txHash, confirmations) {
      const receipt = await provider.waitForTransaction(txHash, confirmations);
      if (!receipt) throw new Error('transaction receipt unavailable');
      receiptStatus(receipt);
      return receipt;
    },

    async verifyMintReceipt(receipt, walletAddress) {
      const contractAddress = getAddress(
        typeof contract.getAddress === 'function'
          ? await contract.getAddress()
          : contract.target,
      );
      const tokenIds = [];
      for (const log of receipt.logs || []) {
        if (!log.address || getAddress(log.address) !== contractAddress) continue;
        let parsed;
        try {
          parsed = contract.interface.parseLog(log);
        } catch {
          continue;
        }
        if (
          parsed?.name === 'Minted' &&
          getAddress(parsed.args.to) === getAddress(walletAddress)
        ) {
          tokenIds.push(parsed.args.id);
        }
      }
      if (tokenIds.length === 0) {
        throw new Error('Minted event for wallet not found');
      }
      if (tokenIds.length !== 1) {
        throw new Error('multiple Minted events for wallet in one transaction');
      }
      const [tokenId] = tokenIds;
      const owner = await contract.ownerOf(tokenId, {
        blockTag: receipt.blockNumber,
      });
      if (getAddress(owner) !== getAddress(walletAddress)) {
        throw new Error('minted token owner mismatch');
      }
      return tokenId;
    },

    async transactionStatus(txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      return receipt ? receiptStatus(receipt) : 'pending';
    },
  });
}
