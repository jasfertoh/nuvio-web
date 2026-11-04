import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  canResolveDebrid,
  magnetFromStream,
  needsDebridResolve,
  torboxApiKey,
} from "../src/lib/debridResolve.ts";
import { setMediaProxyBase } from "../src/lib/mediaProxy.ts";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const HASH = "0123456789abcdef0123456789abcdef01234567";
const KEYED = [
  { provider: "debrid:torbox", credentialJson: { api_key: "tb-key" } },
];

beforeEach(() => store.clear());

test("an info hash becomes a magnet carrying trackers", () => {
  const magnet = magnetFromStream({ infoHash: HASH });
  assert.ok(magnet.startsWith(`magnet:?xt=urn:btih:${HASH}`));
  assert.ok(magnet.includes("&tr="));
});

// Anything that is not a 40-character hex hash would be rejected downstream
// anyway, and a malformed magnet is worse than an unplayable row.
test("a malformed info hash yields no magnet", () => {
  assert.equal(magnetFromStream({ infoHash: "nope" }), "");
  assert.equal(magnetFromStream({ infoHash: "" }), "");
  assert.equal(magnetFromStream({}), "");
});

test("the hash is lowercased, as the trackers and API expect", () => {
  assert.ok(magnetFromStream({ infoHash: HASH.toUpperCase() }).includes(HASH));
});

// A stream that already has a URL is playable as it stands; resolving it would
// spend a Torbox call to arrive back where it started.
test("a stream with a url needs no resolving", () => {
  assert.equal(
    needsDebridResolve({ infoHash: HASH, url: "https://cdn.example.com/f.mkv" }),
    false,
  );
});

test("a torrent-only stream needs resolving", () => {
  assert.equal(needsDebridResolve({ infoHash: HASH }), true);
});

test("a stream with neither url nor hash needs no resolving", () => {
  assert.equal(needsDebridResolve({ externalUrl: "magnet:?xt=y" }), false);
});

test("the key is read from the row the other clients sync into", () => {
  assert.equal(torboxApiKey(KEYED), "tb-key");
  assert.equal(torboxApiKey([]), "");
});

// Both halves are needed: a key with nowhere to send it, or a proxy with no
// key, would each fail at the point of use rather than at the point of offer.
test("resolving needs both a proxy and a key", () => {
  setMediaProxyBase("https://backend.example.com");
  assert.equal(canResolveDebrid(KEYED), true);
  assert.equal(canResolveDebrid([]), false);

  store.clear();
  assert.equal(canResolveDebrid(KEYED), false);
});
