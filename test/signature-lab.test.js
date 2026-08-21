import assert from "node:assert/strict"
import test from "node:test"
import { encodeFunctionData } from "viem"
import {
  analyzeMintCalldata,
  normalizeSignatureLabInput,
  preflightSignatureTransaction,
  SEA_DROP_ABI,
} from "../server/signature-lab.js"

const addresses = {
  nft: "0x1111111111111111111111111111111111111111",
  fee: "0x2222222222222222222222222222222222222222",
  drop: "0x3333333333333333333333333333333333333333",
  wallet: "0x4444444444444444444444444444444444444444",
}

test("signature lab decodes real SeaDrop public mint calldata", () => {
  const data = encodeFunctionData({
    abi: SEA_DROP_ABI,
    functionName: "mintPublic",
    args: [addresses.nft, addresses.fee, "0x0000000000000000000000000000000000000000", 2n],
  })
  const result = analyzeMintCalldata({ chainId: 1, to: addresses.drop, data, valueWei: "100" })

  assert.equal(result.selector, "0x161ac21f")
  assert.equal(result.provider, "SeaDrop")
  assert.equal(result.signatureMode, "public")
  assert.equal(result.nftContract, addresses.nft)
  assert.equal(result.quantity, "2")
})

test("signature lab exposes signed mint signature and stage fields", () => {
  const signature = `0x${"11".repeat(64)}1b`
  const data = encodeFunctionData({
    abi: SEA_DROP_ABI,
    functionName: "mintSigned",
    args: [
      addresses.nft,
      addresses.fee,
      addresses.wallet,
      1n,
      {
        mintPrice: 10n,
        maxTotalMintableByWallet: 2n,
        startTime: 1n,
        endTime: 4_102_444_800n,
        dropStageIndex: 3n,
        maxTokenSupplyForStage: 1000n,
        feeBps: 250n,
        restrictFeeRecipients: false,
      },
      99n,
      signature,
    ],
  })
  const result = analyzeMintCalldata({ chainId: 1, to: addresses.drop, data, valueWei: "10" })

  assert.equal(result.selector, "0x4b61cd6f")
  assert.equal(result.signatureMode, "signed")
  assert.equal(result.signature.bytes, 65)
  assert.equal(result.signature.v, 27)
  assert.equal(result.salt, "99")
  assert.equal(result.mintParams.maxTotalMintableByWallet, "2")
})

test("signature lab input and wallet preflight reject invalid data and preserve per-wallet results", async () => {
  assert.throws(() => normalizeSignatureLabInput({ chainId: 1, txHash: "0x12" }), /32 字节/)
  const input = normalizeSignatureLabInput({ chainId: 1, to: addresses.drop, data: "0x161ac21f", valueWei: "0" })
  assert.equal(input.to, addresses.drop)

  const result = await preflightSignatureTransaction({
    client: {
      call: async ({ account }) => {
        if (account === addresses.wallet) return { data: "0x" }
        throw new Error("execution reverted")
      },
    },
    transaction: { to: addresses.drop, data: "0x161ac21f", valueWei: "0" },
    wallets: [
      { id: "ready", address: addresses.wallet },
      { id: "failed", address: "0x5555555555555555555555555555555555555555" },
    ],
  })

  assert.equal(result.ready, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.wallets[1].reason, "execution reverted")
})
