import assert from "node:assert/strict"
import test from "node:test"
import { resolveListenHosts } from "../server/listen-hosts.js"

test("configured production listener also exposes a local-only entry point", () => {
  assert.deepEqual(resolveListenHosts("203.0.113.10"), ["203.0.113.10", "127.0.0.1"])
})

test("default local listener is not duplicated", () => {
  assert.deepEqual(resolveListenHosts("127.0.0.1"), ["127.0.0.1"])
})

test("explicit host list is respected and deduplicated", () => {
  assert.deepEqual(
    resolveListenHosts("ignored", "127.0.0.1,203.0.113.10,127.0.0.1"),
    ["127.0.0.1", "203.0.113.10"],
  )
})

test("explicit LAN, remote and loopback hosts are all preserved", () => {
  assert.deepEqual(
    resolveListenHosts("203.0.113.10", "203.0.113.10,127.0.0.1,192.0.2.10"),
    ["203.0.113.10", "127.0.0.1", "192.0.2.10"],
  )
})
