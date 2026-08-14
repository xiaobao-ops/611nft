import assert from "node:assert/strict"
import test from "node:test"
import { createNftMediaResolver, normalizeNftUri } from "../server/nft-media.js"

const address = "0x1111111111111111111111111111111111111111"

function jsonData(value) {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString("base64")}`
}

test("NFT URI normalization supports IPFS, Arweave and ERC1155 id templates", () => {
  assert.equal(normalizeNftUri("ipfs://ipfs/bafy/test.json", "1"), "https://ipfs.io/ipfs/bafy/test.json")
  assert.equal(normalizeNftUri("ar://transaction", "1"), "https://arweave.net/transaction")
  assert.equal(normalizeNftUri("ipfs://bafy/{id}.json", "15"), `https://ipfs.io/ipfs/bafy/${"f".padStart(64, "0")}.json`)
})

test("ERC721 on-chain JSON metadata becomes a same-origin image endpoint", async () => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='10' height='10'/></svg>"
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  const resolver = createNftMediaResolver()
  const result = await resolver.resolveToken({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "7",
    client: { async readContract({ functionName }) { assert.equal(functionName, "tokenURI"); return jsonData({ name: "Live Cat #7", image }) } },
  })
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\/[a-f0-9]{32}$/)
  assert.equal(result.tokenName, "Live Cat #7")
  const payload = await resolver.loadMedia(result.imageUrl.split("/").at(-1))
  assert.equal(payload.contentType, "image/svg+xml")
  assert.equal(payload.bytes.toString(), svg)
})

test("ERC1155 metadata replaces the padded id before retrieval", async () => {
  const requested = []
  const resolver = createNftMediaResolver({
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (url) => {
      requested.push(url)
      if (url.includes("/image.png")) {
        return new Response(Buffer.from([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
      }
      return new Response(JSON.stringify({ image: "ipfs://bafy/image.png" }), { headers: { "content-type": "application/json" } })
    },
  })
  const result = await resolver.resolveToken({
    chainId: 1,
    address,
    tokenStandard: "ERC1155",
    tokenId: "15",
    client: { async readContract({ functionName }) { assert.equal(functionName, "uri"); return "https://metadata.example/{id}.json" } },
  })
  assert.equal(requested[0], `https://metadata.example/${"f".padStart(64, "0")}.json`)
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\//)
})

test("broken IPFS image gateways fall through before publishing a preview URL", async () => {
  const requested = []
  const resolver = createNftMediaResolver({
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (url) => {
      requested.push(url)
      if (url.includes("ipfs.io")) return new Response("gateway timeout", { status: 504 })
      return new Response(Buffer.from([71, 73, 70, 56, 57, 97]), { headers: { "content-type": "image/gif" } })
    },
  })
  const result = await resolver.resolveToken({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "7",
    client: { async readContract() { return jsonData({ image: "ipfs://bafy-image" }) } },
  })
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\//)
  assert.equal(requested.some((url) => url.includes("dweb.link")), true)
  const payload = await resolver.loadMedia(result.imageUrl.split("/").at(-1))
  assert.equal(payload.contentType, "image/gif")
})

test("empty tokenURI falls back to contractURI metadata", async () => {
  const image = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`
  const resolver = createNftMediaResolver()
  const result = await resolver.resolveToken({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "9",
    client: {
      async readContract({ functionName }) {
        if (functionName === "tokenURI") return ""
        if (functionName === "contractURI") return jsonData({ name: "Collection", image })
        throw new Error("unsupported")
      },
    },
  })
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\//)
  assert.equal(result.tokenName, "Collection")
})

test("metadata fetch rejects local and private hosts", async () => {
  const resolver = createNftMediaResolver({
    lookupImpl: async () => [{ address: "127.0.0.1" }],
    fetchImpl: async () => { throw new Error("fetch must not run") },
  })
  const result = await resolver.resolveToken({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "1",
    client: { async readContract() { return "http://metadata.example/token.json" } },
  })
  assert.equal(result.imageUrl, null)
  assert.match(result.error, /Private NFT media hosts/)
})

test("metadata fetch rejects IPv4-mapped IPv6 private and link-local hosts", async () => {
  for (const address of ["::ffff:172.16.0.1", "::ffff:169.254.169.254", "::ffff:ac10:1", "::ffff:a9fe:a9fe"]) {
    let fetched = false
    const resolver = createNftMediaResolver({
      lookupImpl: async () => [{ address }],
      fetchImpl: async () => {
        fetched = true
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    const result = await resolver.resolveToken({
      client: { readContract: async () => "https://metadata.example/token.json" },
      chainId: 1,
      address: "0x1111111111111111111111111111111111111111",
      tokenStandard: "ERC721",
      tokenId: "1",
    })
    assert.equal(fetched, false, address)
    assert.match(result.error, /Private NFT media hosts/, address)
  }
})
