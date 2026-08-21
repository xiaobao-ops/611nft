import assert from "node:assert/strict"
import test from "node:test"
import { cliUsage, parseCliArgs, runCli } from "../server/nft-mint-cli.js"

const contractAddress = "0x1111111111111111111111111111111111111111"

test("CLI parses repeatable local wallet profiles and safe mint options", () => {
  const args = parseCliArgs([
    contractAddress,
    "--chain", "8453",
    "--wallet", "default",
    "--wallets", "bt-001,bt-002",
    "--quantity", "2",
    "--max-cost", "0.05",
  ])
  assert.equal(args.chainId, 8453)
  assert.equal(args.quantity, "2")
  assert.equal(args.maxMintCostEth, "0.05")
  assert.deepEqual(args.walletIds, ["default", "bt-001", "bt-002"])
})

test("CLI help documents preview-first and server-side key isolation", () => {
  const usage = cliUsage()
  assert.match(usage, /Preview only \(default\)/)
  assert.match(usage, /Private keys remain in the server-side root \.env/)
})

test("CLI help performs no network or broadcast action", async () => {
  const lines = []
  const result = await runCli(["--help"], { output: { log: (line) => lines.push(line) } })
  assert.equal(result.status, "help")
  assert.match(lines.join("\n"), /--send/)
})

test("CLI rejects a send run without an explicit wallet selection", async () => {
  await assert.rejects(() => runCli([contractAddress, "--send", "--yes"]), /Select at least one local wallet/)
})
