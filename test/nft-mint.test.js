import assert from "node:assert/strict"
import test from "node:test"
import {
  buildNftMintPreview,
  normalizeMintSubmission,
  parseMintPreviewInput,
  refreshNftMintPlan,
  requoteSeaDropPlan,
} from "../server/nft-mint.js"

const contractAddress = "0x1111111111111111111111111111111111111111"
const mintTarget = "0x2222222222222222222222222222222222222222"

function word(value) {
  const raw = String(value).startsWith("0x") ? String(value).slice(2) : BigInt(value).toString(16)
  return raw.padStart(64, "0")
}

function seaDropData(quantity) {
  return `0x161ac21f${word(contractAddress)}${word(mintTarget)}${word(mintTarget)}${word(quantity)}`
}

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
  assert.throws(() => parseMintPreviewInput({ contractAddress, quantity: "0" }), /正整数/)
  assert.throws(() => parseMintPreviewInput({ contractAddress, quantity: "1001" }), /不得超过 1000/)
  assert.throws(() => parseMintPreviewInput({ contractAddress, concurrency: "33" }), /不得超过 32/)
  assert.throws(() => parseMintPreviewInput({ contractAddress, maxMintCostEth: "-1" }), /非负小数/)
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
  }, { chainId: 1, chainIdentifier: "ethereum" }), /返回链 base，当前预期为 ethereum/)
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
    chain: { id: 1, key: "ethereum", nativeSymbol: "ETH" },
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
  assert.match(preview.wallets[1].reason, /超过.*ETH 上限/)
  assert.match(preview.wallets[2].reason, /RPC balance unavailable/)
  assert.equal(preview.wallets[0].estimatedGas, "21000")
  assert.equal(preview.wallets[0].gasLimit, "25200")
})

test("buildNftMintPreview prices EIP-1559 chains from the live fee quote", async () => {
  const wallet = { id: "eip1559", address: "0x0000000000000000000000000000000000000004" }
  const client = {
    async getCode() { return "0x6000" },
    async getGasPrice() { throw new Error("legacy gasPrice should not be used") },
    async estimateFeesPerGas() { return { maxFeePerGas: 7n, maxPriorityFeePerGas: 2n } },
    async getBalance() { return 1_000_000n },
    async estimateGas() { return 21_000n },
  }
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ data: { swap: { errors: [], actions: [{
        __typename: "MintAction",
        transactionSubmissionData: { to: mintTarget, data: "0x12345678", value: "100", chain: { identifier: "ethereum", networkId: 1 } },
      }] } } })
    },
  })
  const preview = await buildNftMintPreview({
    client,
    chain: { id: 1, key: "ethereum", nativeSymbol: "ETH" },
    wallets: [wallet],
    contractAddress,
    quantity: 1n,
    tokenId: "0",
    concurrency: 1,
    maxMintCostWei: null,
    gasBufferBps: 10000n,
    fetchImpl,
  })
  const row = preview.wallets[0]
  assert.equal(row.feeModel, "eip1559")
  assert.equal(row.maxFeePerGasWei, "7")
  assert.equal(row.maxPriorityFeePerGasWei, "2")
  assert.equal(row.estimatedFeeWei, "147000")
})

test("SeaDrop requote validates the requested quantity and remaining wallet limit", async () => {
  const walletAddress = "0x0000000000000000000000000000000000000001"
  const reads = []
  const client = {
    async readContract(input) {
      reads.push(input)
      const { functionName } = input
      if (functionName === "getPublicDrop") return { mintPrice: 4n, maxTotalMintableByWallet: 5n }
      if (functionName === "getMintStats") return { minterNumMinted: 2n, currentTotalSupply: 20n, maxSupply: 100n }
      throw new Error("unexpected call")
    },
  }
  const quote = await requoteSeaDropPlan({
    client,
    plan: { transaction: { to: mintTarget, data: seaDropData(2), value: 10n } },
    expectedContractAddress: contractAddress,
    expectedQuantity: 2n,
    walletAddress,
  })
  assert.equal(quote.newValue, 8n)
  assert.equal(quote.maxPerWallet, 5n)
  assert.equal(quote.mintedByWallet, 2n)
  assert.equal(reads[0].address, mintTarget)
  assert.deepEqual(reads[0].args, [contractAddress])
  assert.equal(reads[1].address, contractAddress)
  assert.deepEqual(reads[1].args, [walletAddress])

  await assert.rejects(() => requoteSeaDropPlan({
    client,
    plan: { transaction: { to: mintTarget, data: seaDropData(4), value: 16n } },
    expectedContractAddress: contractAddress,
    expectedQuantity: 4n,
    walletAddress,
  }), /每钱包上限为 5 个，当前钱包已铸造 2 个/)
})

test("send-time refresh requests a new quote and recomputes gas and balance", async () => {
  const wallet = { id: "ready", address: "0x0000000000000000000000000000000000000001" }
  const plan = { wallet, transaction: { to: mintTarget, data: "0x12345678", value: 100n } }
  const client = {
    async getCode() { return "0x6000" },
    async getGasPrice() { return 3n },
    async getBalance() { return 1_000_000n },
    async estimateGas() { return 25_000n },
  }
  let quoteValue = "90"
  let requestCount = 0
  const fetchImpl = async () => {
    requestCount += 1
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: { swap: { errors: [], actions: [{
          __typename: "MintAction",
          transactionSubmissionData: {
            to: mintTarget,
            data: "0x12345678",
            value: quoteValue,
            chain: { identifier: "ethereum", networkId: 1 },
          },
        }] } } })
      },
    }
  }
  const args = {
    client,
    chain: { id: 1, key: "ethereum", nativeSymbol: "ETH" },
    plan,
    contractAddress,
    quantity: 2n,
    tokenId: "0",
    maxMintCostWei: null,
    fetchImpl,
  }
  const refreshed = await refreshNftMintPlan(args)
  assert.equal(requestCount, 1)
  assert.equal(refreshed.transaction.value, 90n)
  assert.equal(refreshed.estimatedGas, 25_000n)
  assert.equal(refreshed.gasLimit, 30_000n)
  assert.equal(refreshed.estimatedTotal, 90_090n)

  quoteValue = "110"
  await assert.rejects(() => refreshNftMintPlan(args), /价格已从 0\.0000000000000001 上涨/)
})
