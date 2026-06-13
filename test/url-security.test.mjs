import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  fetchPublicWebsite,
  isPublicIpAddress,
  normalizeHttpUrl,
  resolvePublicAddresses
} from "../scripts/url-security.mjs";

test("normalizes only credential-free HTTP(S) URLs", () => {
  assert.equal(
    normalizeHttpUrl("/initiative", { baseUrl: "https://example.org/base/" }),
    "https://example.org/initiative"
  );
  assert.throws(() => normalizeHttpUrl("javascript:alert(1)"), /only http\/https/);
  assert.throws(() => normalizeHttpUrl("ftp://example.org/file"), /only http\/https/);
  assert.throws(() => normalizeHttpUrl("https://user:secret@example.org/"), /credentials/);
});

test("blocks private, local, reserved and mapped IP addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::127.0.0.1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1"
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress("93.184.216.34"), true);
  assert.equal(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
});

test("rejects DNS responses containing any non-public address", async () => {
  await assert.rejects(
    resolvePublicAddresses("example.org", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]),
    /private or reserved/
  );
});

test("pins the approved DNS address into the HTTP request", async () => {
  let selectedAddress;
  const response = await fetchPublicWebsite("https://example.org/start", {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl(url, options, callback) {
      options.lookup(url.hostname, {}, (error, address, family) => {
        assert.ifError(error);
        selectedAddress = { address, family };
      });
      queueMicrotask(() => callback(fakeResponse(200)));
      return fakeRequest();
    }
  });

  assert.deepEqual(selectedAddress, { address: "93.184.216.34", family: 4 });
  assert.equal(response.ok, true);
  assert.equal(response.url, "https://example.org/start");
});

test("revalidates redirect targets before following them", async () => {
  let requests = 0;
  await assert.rejects(
    fetchPublicWebsite("https://example.org/start", {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl(url, options, callback) {
        requests += 1;
        queueMicrotask(() => callback(fakeResponse(302, { location: "http://127.0.0.1/admin" })));
        return fakeRequest();
      }
    }),
    /private or reserved/
  );
  assert.equal(requests, 1);
});

function fakeRequest() {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = (error) => {
    if (error) request.emit("error", error);
  };
  request.end = () => {};
  return request;
}

function fakeResponse(statusCode, headers = {}) {
  return {
    statusCode,
    headers,
    destroy() {}
  };
}
