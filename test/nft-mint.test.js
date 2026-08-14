import assert from "node:assert/strict"
import test from "node:test"
import {
  buildNftMintPreview,
  normalizeMintSubmission,
  parseMintPreviewInput,
} from "../server/nft-mint.js"

const contractAddress = "0x1111111111111111111111111111111111111111"
const mintTarget = "0x2222222222222222222222222222222222222222"

test("parseMintPreviewInput normalizes safe mint values", () => {
  const value = parseMintPreviewInput({
    contractAddress: contractAddress.toLowerCase(),
    quantity: "2",
    tokenId: "0",
    concurrency: "5",
    maxMintCostEth: "0.05",
  })

  assert.equal(value.contractAddress, contractAddress)
  assert.equal(value.quantity, 2n)
  assert.equal(value.tokenId, "0")
  assert.equal(value.concurrency, 5)
  assert.equal(value.maxMintCostWei, 50_000_000_000_000_000n)
})

test("parseMintPreviewInput rejects unsafe bounds", () => {
  assert.throws(() => parseMintPreviewInput({ contractAddress, quantity: "0" }), /positive integer/)
  assert.throws(() => parseMintPreviewInput({ contractAddress, quantity: "1001" }), /cannot exceed 1000/)
  assert.throws(() => parseMintPreviewInput({ contractAddress, concurrency: "33" }), /cannot exceed 32/)
  assert.throws(() => parseMintPreviewInput({ contractAddress, maxMintCostEth: "-1" }), /native-token amount/)
})

test("normalizeMintSubmission rejects a provider chain mismatch", () => {
  assert.throws(() => normalizeMintSubmission({
    __typename: "MintAction",
    transactionSubmissionData: {
      to: mintTarget,
      data: "0x12345678",
      value: "0",
      chain: { identifier: "base", networkId: 8453 },
    },
  }, { chainId: 1, chainIdentifier: "ethereum" }), /returned base, expected ethereum/)
})

test("buildNftMintPreview isolates ready, skipped, and failed wallets", async () => {
  const wallets = [
    { id: "ready", address: "0x0000000000000000000000000000000000000001" },
    { id: "capped", address: "0x0000000000000000000000000000000000000002" },
    { id: "failed", address: "0x0000000000000000000000000000000000000003" },
  ]
  const balances = new Map([
    [wallets[0].address, 1_000_000n],
    [wallets[1].address, 1_000_000n],
  ])
  const client = {
    async getCode() { return "0x6000" },
    async getGasPrice() { return 2n },
    async getBalance({ address }) {
      if (address === wallets[2].address) throw new Error("RPC balance unavailable")
      return balances.get(address)
    },
    async estimateGas() { return 21_000n },
  }
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body)
    const address = body.variables.address
    const value = address === wallets[1].address ? "500000" : "100000"
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: {
            swap: {
              errors: [],
              actions: [{
                __typename: "MintAction",
                transactionSubmissionData: {
                  to: mintTarget,
                  data: "0x12345678",
                  value,
                  chain: { identifier: "ethereum", networkId: 1 },
                },
              }],
            },
          },
        })
      },
    }
  }

  const preview = await buildNftMintPreview({
    client,
    chain: { id: 1, key: "ethereum" },
    wallets,
    contractAddress,
    quantity: 1n,
    tokenId: "0",
    concurrency: 2,
    maxMintCostWei: 200_000n,
    gasBufferBps: 12000n,
    fetchImpl,
  })

  assert.deepEqual(preview.wallets.map((wallet) => wallet.status), ["ready", "skipped", "failed"])
  assert.deepEqual(preview.wallets.map((wallet) => wallet.preflightStatus), ["ready", "skipped", "failed"])
  assert.equal(preview.readyPlans.length, 1)
  assert.match(preview.wallets[1].reason, /exceeds/)
  assert.match(preview.wallets[2].reason, /RPC balance unavailable/)
  assert.equal(preview.wallets[0].estimatedGas, "21000")
  assert.equal(preview.wallets[0].gasLimit, "25200")
})
