import assert from "node:assert/strict"
import test from "node:test"
import {
  buildTokenCollectPlan,
  queryContractHoldings,
  reduceNftTransferLogs,
} from "../server/token-collect.js"

const CONTRACT = `0x${"11".repeat(20)}`
const DESTINATION = `0x${"22".repeat(20)}`
const WALLETS = [
  { id: "alpha", address: `0x${"aa".repeat(20)}` },
  { id: "beta", address: `0x${"bb".repeat(20)}` },
]

test("ERC20 holdings query returns every selected wallet and the exact total", async () => {
  const balances = new Map([[WALLETS[0].address.toLowerCase(), 1250000n], [WALLETS[1].address.toLowerCase(), 750000n]])
  const client = {
    async readContract({ functionName, args }) {
      if (functionName === "supportsInterface") return false
      if (functionName === "decimals") return 6
      if (functionName === "symbol") return "TOK"
      if (functionName === "balanceOf") return balances.get(args[0].toLowerCase()) || 0n
      throw new Error(`unexpected ${functionName}`)
    },
  }

  const result = await queryContractHoldings({ client, contractAddress: CONTRACT, wallets: WALLETS })
  assert.equal(result.standard, "ERC20")
  assert.equal(result.totalCount, "2000000")
  assert.equal(result.totalFormatted, "2")
  assert.deepEqual(result.rows.map((row) => [row.walletId, row.count]), [["alpha", "1250000"], ["beta", "750000"]])
})

test("ERC721 enumerable holdings expose exact token ids and total count", async () => {
  const tokens = new Map([[WALLETS[0].address.toLowerCase(), [7n, 9n]], [WALLETS[1].address.toLowerCase(), [15n]]])
  const client = {
    async readContract({ functionName, args }) {
      if (functionName === "supportsInterface") return args[0] === "0x80ac58cd"
      if (functionName === "balanceOf") return BigInt(tokens.get(args[0].toLowerCase())?.length || 0)
      if (functionName === "tokenOfOwnerByIndex") return tokens.get(args[0].toLowerCase())[Number(args[1])]
      throw new Error(`unexpected ${functionName}`)
    },
  }

  const result = await queryContractHoldings({ client, contractAddress: CONTRACT, wallets: WALLETS })
  assert.equal(result.standard, "ERC721")
  assert.equal(result.totalCount, "3")
  assert.equal(result.coverageComplete, true)
  assert.deepEqual(result.rows.map((row) => [row.walletId, row.tokenId, row.count]), [
    ["alpha", "7", "1"],
    ["alpha", "9", "1"],
    ["beta", "15", "1"],
  ])
})

test("ERC1155 transfer reduction preserves current candidate ids per selected wallet", () => {
  const rows = reduceNftTransferLogs({
    standard: "ERC1155",
    walletAddresses: WALLETS.map((wallet) => wallet.address),
    logs: [
      { blockNumber: 1n, logIndex: 0, transactionHash: `0x${"01".repeat(32)}`, args: { from: DESTINATION, to: WALLETS[0].address, id: 5n, value: 3n } },
      { blockNumber: 2n, logIndex: 0, transactionHash: `0x${"02".repeat(32)}`, args: { from: WALLETS[0].address, to: WALLETS[1].address, id: 5n, value: 1n } },
      { blockNumber: 3n, logIndex: 0, transactionHash: `0x${"03".repeat(32)}`, args: { from: DESTINATION, to: WALLETS[1].address, ids: [8n, 9n], values: [2n, 4n] } },
    ],
  })
  assert.deepEqual(rows, {
    [WALLETS[0].address.toLowerCase()]: ["5"],
    [WALLETS[1].address.toLowerCase()]: ["5", "8", "9"],
  })
})

test("collect plan encodes the complete selected balance for each token standard", () => {
  const fixtures = [
    { standard: "ERC20", tokenId: null, count: "1250000", selector: "a9059cbb" },
    { standard: "ERC721", tokenId: "7", count: "1", selector: "42842e0e" },
    { standard: "ERC1155", tokenId: "5", count: "3", selector: "f242432a" },
  ]
  for (const fixture of fixtures) {
    const row = { id: `alpha:${fixture.tokenId || "erc20"}`, walletId: "alpha", address: WALLETS[0].address, ...fixture }
    const plan = buildTokenCollectPlan({ contractAddress: CONTRACT, destination: DESTINATION, rows: [row] })
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.entries[0].walletId, "alpha")
    assert.equal(plan.entries[0].to.toLowerCase(), CONTRACT.toLowerCase())
    assert.equal(plan.entries[0].data.slice(2, 10), fixture.selector)
  }
})

test("rows that cannot be collected are reported instead of silently dropped", () => {
  // Counting selected rows against planned entries is how an operator checks a batch.
  // Dropping a row without a word is what made a 3-wallet transfer look like a 2.
  const DEST = "0x00000000000000000000000000000000000000C1"
  const plan = buildTokenCollectPlan({
    contractAddress: CONTRACT,
    destination: DEST,
    rows: [
      { id: "a", walletId: "a", address: WALLETS[0].address, tokenId: "1", count: "1", standard: "ERC721" },
      { id: "b", walletId: "b", address: WALLETS[1].address, tokenId: "2", count: "0", standard: "ERC721" },
      { id: "c", walletId: "c", address: DEST, tokenId: "3", count: "1", standard: "ERC721" },
    ],
  })
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.rowCount, 3, "the caller can compare what it selected against what will send")
  assert.equal(plan.excluded.length, 2)
  assert.deepEqual(plan.excluded.map((row) => row.walletId), ["b", "c"])
  assert.match(plan.excluded[0].reason, /数量为 0/)
  assert.match(plan.excluded[1].reason, /接收地址/)
})

test("a plan with nothing excluded still reports an empty exclusion list", () => {
  const plan = buildTokenCollectPlan({
    contractAddress: CONTRACT,
    destination: "0x00000000000000000000000000000000000000C1",
    rows: [{ id: "a", walletId: "a", address: WALLETS[0].address, tokenId: "1", count: "1", standard: "ERC721" }],
  })
  assert.deepEqual(plan.excluded, [])
  assert.equal(plan.rowCount, 1)
})
