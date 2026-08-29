import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

test("trusted NFT gateways accept the sandbox public-DNS proxy range", async () => {
  const requested = []
  const resolver = createNftMediaResolver({
    lookupImpl: async () => [{ address: "198.18.0.48" }],
    fetchImpl: async (url) => {
      requested.push(url)
      if (url.includes("/metadata/7")) {
        return new Response(JSON.stringify({ name: "Real Project #7", image: "ipfs://project-logo/7.png" }), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(Buffer.from([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
    },
  })
  const result = await resolver.resolveToken({
    chainId: 4663,
    address,
    tokenStandard: "ERC721",
    tokenId: "7",
    client: { async readContract() { return "ipfs://metadata/7" } },
  })
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\//)
  assert.equal(result.tokenName, "Real Project #7")
  assert.equal(requested.some((url) => url.includes("project-logo/7.png")), true)
  const payload = await resolver.loadMedia(result.imageUrl.split("/").at(-1))
  assert.equal(payload.contentType, "image/png")
})

test("an isolated synthetic-range answer is still rejected outside proxy DNS mode", async () => {
  let fetched = false
  const resolver = createNftMediaResolver({
    lookupImpl: async (hostname) => [{ address: hostname === "example.com" ? "93.184.216.34" : "198.18.0.48" }],
    fetchImpl: async () => {
      fetched = true
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  })
  const result = await resolver.resolveToken({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "1",
    client: { async readContract() { return "https://metadata.example/token.json" } },
  })
  assert.equal(fetched, false)
  assert.match(result.error, /Private NFT media hosts/)
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

test("project media prefers collection metadata over a market image and token artwork", async () => {
  const collectionImage = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`
  const marketImage = `data:image/gif;base64,${Buffer.from([71, 73, 70, 56, 57, 97]).toString("base64")}`
  const calls = []
  const resolver = createNftMediaResolver()
  const result = await resolver.resolveProject({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "9",
    marketImageUrl: marketImage,
    client: {
      async readContract({ functionName }) {
        calls.push(functionName)
        if (functionName === "contractURI") return jsonData({ name: "Collection", image: collectionImage, external_url: "https://collection.example" })
        if (functionName === "tokenURI") return jsonData({ name: "Token", image: marketImage })
        throw new Error("unsupported")
      },
    },
  })
  assert.equal(result.imageSource, "contract_uri")
  assert.equal(result.name, "Collection")
  assert.equal(result.website, "https://collection.example")
  assert.equal(calls.includes("tokenURI"), false)
})

test("project media falls back from missing collection metadata to verified market artwork", async () => {
  const marketImage = `data:image/gif;base64,${Buffer.from([71, 73, 70, 56, 57, 97]).toString("base64")}`
  const resolver = createNftMediaResolver()
  const result = await resolver.resolveProject({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "9",
    marketImageUrl: marketImage,
    client: { async readContract() { throw new Error("unsupported") } },
  })
  assert.equal(result.imageSource, "opensea")
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\//)
})

test("project media uses token artwork only after collection and market artwork are absent", async () => {
  const tokenImage = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`
  const resolver = createNftMediaResolver()
  const result = await resolver.resolveProject({
    chainId: 1,
    address,
    tokenStandard: "ERC721",
    tokenId: "9",
    marketImageUrl: "",
    client: {
      async readContract({ functionName }) {
        if (functionName === "tokenURI") return jsonData({ name: "Token #9", image: tokenImage })
        throw new Error("unsupported")
      },
    },
  })
  assert.equal(result.imageSource, "token_uri")
  assert.equal(result.tokenName, "Token #9")
  assert.match(result.imageUrl, /^\/api\/mint-monitor\/media\//)
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

test("NFT media disk cache survives resolver restarts and verifies cached bytes", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "611nft-media-"))
  let fetches = 0
  const options = {
    cacheDir,
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async () => {
      fetches += 1
      return new Response(Buffer.from([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
    },
  }
  try {
    const first = createNftMediaResolver(options)
    const firstUrl = first.registerMedia("https://media.example/project.png", "0")
    const firstPayload = await first.loadMedia(firstUrl.split("/").at(-1))
    assert.equal(firstPayload.contentType, "image/png")
    assert.equal(fetches, 1)

    const second = createNftMediaResolver({
      ...options,
      fetchImpl: async () => { throw new Error("disk cache miss") },
    })
    const secondUrl = second.registerMedia("https://media.example/project.png", "0")
    assert.equal(secondUrl, firstUrl)
    const secondPayload = await second.loadMedia(secondUrl.split("/").at(-1))
    assert.deepEqual(secondPayload.bytes, firstPayload.bytes)
    assert.equal(fetches, 1)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})
