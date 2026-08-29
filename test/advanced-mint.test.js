import assert from "node:assert/strict"
import test from "node:test"
import { buildAdvancedMintTransactions, normalizeAdvancedMintInput } from "../server/advanced-mint.js"

const WALLET = { id: "alpha", address: `0x${"12".repeat(20)}` }
const CONTRACT = `0x${"34".repeat(20)}`

test("advanced method mode encodes dynamic wallet and integer parameters", () => {
  const input = normalizeAdvancedMintInput({
    chainId: 1,
    walletIds: ["alpha"],
    contractAddress: CONTRACT,
    mode: "method",
    methodSignature: "mint(address,uint256)",
    parameters: ["&", "4"],
    valueEth: "0.01",
    autoGas: true,
  })
  const [transaction] = buildAdvancedMintTransactions(input, [WALLET])
  assert.match(transaction.data, /^0x[0-9a-f]+$/)
  assert.equal(transaction.data.slice(34, 74).toLowerCase(), WALLET.address.slice(2).toLowerCase())
  assert.equal(transaction.valueWei, "10000000000000000")
  assert.equal(transaction.method, "mint")
})

test("advanced hex mode replaces wallet placeholders with a padded address", () => {
  const input = normalizeAdvancedMintInput({
    walletIds: ["alpha"],
    contractAddress: CONTRACT,
    mode: "hex",
    calldata: `0x12345678&`,
    replaceWallet: true,
    valueEth: "0",
    rounds: 2,
    frequencyMs: 100,
  })
  const [transaction] = buildAdvancedMintTransactions(input, [WALLET])
  assert.equal(transaction.data, `0x12345678${WALLET.address.slice(2).toLowerCase().padStart(64, "0")}`)
  assert.equal(input.rounds, 2)
})

test("advanced plan rejects malformed methods, parameters and schedules", () => {
  const base = { walletIds: ["alpha"], contractAddress: CONTRACT, valueEth: "0" }
  assert.throws(() => normalizeAdvancedMintInput({ ...base, scheduleAt: "not-a-date" }), /定时执行时间无效/)
  const input = normalizeAdvancedMintInput({ ...base, mode: "method", methodSignature: "mint(uint256)", parameters: [] })
  assert.throws(() => buildAdvancedMintTransactions(input, [WALLET]), /需要 1 个参数/)
})
