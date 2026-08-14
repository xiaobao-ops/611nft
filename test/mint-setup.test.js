import assert from "node:assert/strict"
import test from "node:test"
import {
  mintSetupFromCollection,
  mintSetupFromRecentMint,
  weiToNativeDecimal,
} from "../src/mint-setup.js"

const current = {
  contractAddress: "",
  quantity: "7",
  tokenId: "12",
  concurrency: "5",
  maxMintCostEth: "0.9",
}

test("collection mint value is copied into Mint Setup exactly", () => {
  const result = mintSetupFromCollection(current, {
    address: "0x1111111111111111111111111111111111111111",
    mint_price_raw: "125000000000000000",
  })
  assert.equal(result.contractAddress, "0x1111111111111111111111111111111111111111")
  assert.equal(result.quantity, "1")
  assert.equal(result.tokenId, "0")
  assert.equal(result.maxMintCostEth, "0.125")
  assert.equal(result.concurrency, "5")
})

test("recent Mint reuses contract, quantity, token ID and total mint value", () => {
  const result = mintSetupFromRecentMint(current, {
    address: "0x2222222222222222222222222222222222222222",
    token_standard: "ERC1155",
  }, {
    quantity: "3",
    token_id: "611",
    mint_value_raw: "15000000000000000",
  })
  assert.equal(result.contractAddress, "0x2222222222222222222222222222222222222222")
  assert.equal(result.quantity, "3")
  assert.equal(result.tokenId, "611")
  assert.equal(result.maxMintCostEth, "0.015")
})

test("ERC721 recent Mint keeps collection mint token ID at zero", () => {
  const result = mintSetupFromRecentMint(current, {
    address: "0x3333333333333333333333333333333333333333",
    token_standard: "ERC721",
  }, {
    quantity: "4",
    token_id: "1777",
    mint_value_raw: "500000000000000000",
  })
  assert.equal(result.quantity, "4")
  assert.equal(result.tokenId, "0")
  assert.equal(result.maxMintCostEth, "0.5")
})

test("unknown source price clears a stale value cap", () => {
  assert.equal(mintSetupFromCollection(current, { address: "0xabc" }).maxMintCostEth, "")
  assert.equal(mintSetupFromRecentMint(current, { address: "0xabc" }, { quantity: "1" }).maxMintCostEth, "")
})

test("recent Mint can derive total value from unit price", () => {
  const result = mintSetupFromRecentMint(current, { address: "0xabc" }, {
    quantity: "2",
    token_id: "0",
    unit_price_raw: "2500000000000000",
  })
  assert.equal(result.maxMintCostEth, "0.005")
  assert.equal(weiToNativeDecimal("42"), "0.000000000000000042")
})
