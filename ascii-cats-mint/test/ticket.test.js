import assert from 'node:assert/strict';
import test from 'node:test';

import { Wallet, getBytes, solidityPackedKeccak256 } from 'ethers';

import { validateTicket, verifyTicketAuthorization } from '../src/ticket.js';

const VALID_SALT = `0x${'11'.repeat(32)}`;
const VALID_SIGNATURE = `0x${'22'.repeat(65)}`;

test('rejects a ticket response that is not ok', () => {
  assert.throws(
    () => validateTicket({ ok: false, error: 'wallet not eligible' }),
    /wallet not eligible/,
  );
});

test('rejects a demo ticket', () => {
  assert.throws(
    () =>
      validateTicket({
        ok: true,
        live: false,
        salt: VALID_SALT,
        signature: VALID_SIGNATURE,
      }),
    /demo ticket refused/,
  );
});

test('rejects an invalid 32-byte salt', () => {
  assert.throws(
    () =>
      validateTicket({
        ok: true,
        live: true,
        salt: `0x${'11'.repeat(31)}`,
        signature: VALID_SIGNATURE,
      }),
    /invalid ticket salt/,
  );
});

test('rejects an invalid 65-byte signature', () => {
  assert.throws(
    () =>
      validateTicket({
        ok: true,
        live: true,
        salt: VALID_SALT,
        signature: `0x${'22'.repeat(64)}`,
      }),
    /invalid ticket signature/,
  );
});

test('accepts a valid live ticket payload', () => {
  const ticket = validateTicket({
    ok: true,
    live: true,
    salt: VALID_SALT,
    signature: VALID_SIGNATURE,
  });

  assert.deepEqual(ticket, {
    salt: VALID_SALT,
    signature: VALID_SIGNATURE,
  });
});

test('recovers a ticket signed for the exact chain, contract, wallet, and salt', async () => {
  const signer = new Wallet(`0x${'01'.repeat(32)}`);
  const walletAddress = '0x1111111111111111111111111111111111111111';
  const contractAddress = '0xa3F56AdB32D3A8F3b41462e3fBF17f36829325bE';
  const digest = solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'bytes32'],
    ['ASCIICATS_MINT', 4663, contractAddress, walletAddress, VALID_SALT],
  );
  const signature = await signer.signMessage(getBytes(digest));

  assert.equal(
    verifyTicketAuthorization({
      ticket: { salt: VALID_SALT, signature },
      chainId: 4663,
      contractAddress,
      walletAddress,
      mintSigner: signer.address,
    }),
    signer.address,
  );
});

test('rejects a structurally valid ticket signed for a different wallet', async () => {
  const signer = new Wallet(`0x${'01'.repeat(32)}`);
  const signedWallet = '0x1111111111111111111111111111111111111111';
  const requestedWallet = '0x2222222222222222222222222222222222222222';
  const contractAddress = '0xa3F56AdB32D3A8F3b41462e3fBF17f36829325bE';
  const digest = solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'bytes32'],
    ['ASCIICATS_MINT', 4663, contractAddress, signedWallet, VALID_SALT],
  );
  const signature = await signer.signMessage(getBytes(digest));

  assert.throws(
    () =>
      verifyTicketAuthorization({
        ticket: { salt: VALID_SALT, signature },
        chainId: 4663,
        contractAddress,
        walletAddress: requestedWallet,
        mintSigner: signer.address,
      }),
    /ticket signer does not match on-chain mintSigner/,
  );
});
