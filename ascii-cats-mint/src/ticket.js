import {
  getAddress,
  getBytes,
  solidityPackedKeccak256,
  verifyMessage,
} from 'ethers';

export function validateTicket(payload) {
  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error || 'ticket refused');
  }
  if (payload.live === false) {
    throw new Error('demo ticket refused');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.salt || '')) {
    throw new Error('invalid ticket salt');
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(payload.signature || '')) {
    throw new Error('invalid ticket signature');
  }
  return { salt: payload.salt, signature: payload.signature };
}

export function verifyTicketAuthorization({
  ticket,
  chainId,
  contractAddress,
  walletAddress,
  mintSigner,
}) {
  const digest = solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'bytes32'],
    ['ASCIICATS_MINT', chainId, contractAddress, walletAddress, ticket.salt],
  );
  const recovered = verifyMessage(getBytes(digest), ticket.signature);
  if (getAddress(recovered) !== getAddress(mintSigner)) {
    throw new Error('ticket signer does not match on-chain mintSigner');
  }
  return recovered;
}
