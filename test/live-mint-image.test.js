import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("all Live Mint project images load eagerly and only advance after a real loading error", async () => {
  const source = await readFile(new URL("../src/LiveMintView.jsx", import.meta.url), "utf8")
  const loader = source.slice(source.indexOf("function MintImageLoader"), source.indexOf("function MintImage("))

  assert.match(loader, /loading="eager"/)
  assert.match(loader, /fetchPriority="high"/)
  assert.match(loader, /imageRef\.current\?\.complete && imageRef\.current\.naturalWidth > 0/)
  assert.match(loader, /\}, \[source, sourceKey\]\)/)
  assert.match(loader, /onError=\{advance\}/)
  assert.doesNotMatch(loader, /setTimeout/)
  assert.doesNotMatch(source, /FIRST_PAINT_IMAGE_COUNT/)
})
