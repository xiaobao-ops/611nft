import assert from "node:assert/strict"
import test from "node:test"

globalThis.localStorage ||= {
  getItem() { return null },
  removeItem() {},
  setItem() {},
}

const { createMintActionState, prepareMintAction } = await import("../apps/nfttool/runtime/mint-action-panel.js")

function state(chainId) {
  return {
    chainId,
    chains: [
      { id: 1, name: "Ethereum", nativeSymbol: "ETH" },
      { id: 4663, name: "Robinhood Chain", nativeSymbol: "ETH" },
    ],
    wallets: [{ id: "wallet-1", address: "0x1111111111111111111111111111111111111111" }],
    selected: new Set(),
  }
}

test("Robinhood starts the Live Mint action panel in OpenSea quick mode", () => {
  assert.equal(createMintActionState(state(4663)).mode, "opensea")
  assert.equal(createMintActionState(state(1)).mode, "method")
})

test("changing chain restores its default mode without resetting manual mode on rerender", () => {
  const action = createMintActionState(state(1))
  action.mode = "hex"
  prepareMintAction(action, state(1), null)
  assert.equal(action.mode, "hex")
  prepareMintAction(action, state(4663), null)
  assert.equal(action.mode, "opensea")
  action.mode = "hex"
  prepareMintAction(action, state(4663), null)
  assert.equal(action.mode, "hex")
})

test("selected Live Mint event fills both NFT TOOL advanced and OpenSea forms", () => {
  const current = state(4663)
  const action = createMintActionState(current)
  const event = {
    id: "event-1",
    address: "0x2222222222222222222222222222222222222222",
    mintTarget: "0x3333333333333333333333333333333333333333",
    quantity: "5",
  }
  prepareMintAction(action, current, event)
  assert.equal(action.advanced.contractAddress, event.mintTarget)
  assert.equal(action.openSea.contractAddress, event.address)
  assert.equal(action.openSea.quantity, "5")
  assert.equal(action.advanced.walletIds, action.openSea.walletIds)
})
