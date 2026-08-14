import test from "node:test"
import assert from "node:assert/strict"
import {
  assertSecureRemoteConfiguration,
  isLoopbackAddress,
  requireRemoteApiAuth,
} from "../server/security.js"

test("loopback detection accepts IPv4 and IPv4-mapped loopback only", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true)
  assert.equal(isLoopbackAddress("::1"), true)
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
  assert.equal(isLoopbackAddress("0.0.0.0"), false)
  assert.equal(isLoopbackAddress("192.168.1.10"), false)
})

test("non-loopback listeners fail closed without an API token", () => {
  assert.throws(() => assertSecureRemoteConfiguration(["127.0.0.1", "0.0.0.0"], ""), /API_TOKEN/)
  assert.throws(() => assertSecureRemoteConfiguration(["127.0.0.1", "0.0.0.0"], "short-token"), /32 bytes/)
  assert.deepEqual(assertSecureRemoteConfiguration(["127.0.0.1", "0.0.0.0"], "a".repeat(32)), ["0.0.0.0"])
})

test("remote API requests require the exact bearer token", () => {
  assert.equal(requireRemoteApiAuth({ localAddress: "127.0.0.1", expectedToken: "secret" }), true)
  assert.equal(requireRemoteApiAuth({ localAddress: "192.168.1.10", authorization: "Bearer secret", expectedToken: "secret" }), true)
  assert.equal(requireRemoteApiAuth({ localAddress: "192.168.1.10", authorization: "Bearer wrong", expectedToken: "secret" }), false)
})
