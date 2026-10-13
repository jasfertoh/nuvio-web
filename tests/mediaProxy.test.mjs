import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  MEDIA_PROXY_OFF,
  mediaProxyBase,
  proxiedPlaybackUrl,
  setMediaProxyBase,
} from "../src/lib/mediaProxy.ts";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
// canPlayType is what decides whether AC-3 is named as a capability. No
// browser answers "probably" for it today, which is the case worth pinning.
globalThis.document = {
  createElement: () => ({ canPlayType: () => "" }),
};

const SOURCE = "https://cdn.example.com/film.mkv?token=abc";

beforeEach(() => store.clear());

// A build carries its own backend as the default, which Vite substitutes and
// Node has no equivalent of - so here "nothing stored" means nothing at all.
test("nothing stored and no build default leaves the source untouched", () => {
  assert.equal(proxiedPlaybackUrl(SOURCE), SOURCE);
});

test("a configured proxy wraps the source, url-encoded", () => {
  setMediaProxyBase("https://backend.example.com");
  const out = proxiedPlaybackUrl(SOURCE);
  assert.match(out, /^https:\/\/backend\.example\.com\/media-transcode\/play\?/);
  // The source carries its own query string, so it has to survive as one
  // parameter rather than leaking into the proxy's.
  assert.equal(new URL(out).searchParams.get("url"), SOURCE);
});

test("a trailing slash on the base does not double up", () => {
  setMediaProxyBase("https://backend.example.com/");
  assert.equal(mediaProxyBase(), "https://backend.example.com");
  assert.ok(!proxiedPlaybackUrl(SOURCE).includes("//media-transcode"));
});

// Naming a codec the element cannot decode would have the proxy pass the audio
// through, and it would then play silently - the exact failure it exists to fix.
test("codecs the element cannot decode are not claimed", () => {
  setMediaProxyBase("https://backend.example.com");
  const caps = new URL(proxiedPlaybackUrl(SOURCE)).searchParams.get("caps");
  assert.match(caps, /aac/);
  assert.doesNotMatch(caps, /ac3/);
  assert.doesNotMatch(caps, /eac3/);
});

test("HLS is left alone, being already segmented and seekable", () => {
  setMediaProxyBase("https://backend.example.com");
  const hls = "https://cdn.example.com/stream.m3u8";
  assert.equal(proxiedPlaybackUrl(hls), hls);
});

test("non-http sources are left alone", () => {
  setMediaProxyBase("https://backend.example.com");
  const magnet = "magnet:?xt=urn:btih:abc";
  assert.equal(proxiedPlaybackUrl(magnet), magnet);
});

// The URL is derived inside a render path, so it can be recomputed on the same
// source; wrapping an already-wrapped URL would break playback outright.
test("an already proxied url is returned unchanged", () => {
  setMediaProxyBase("https://backend.example.com");
  const once = proxiedPlaybackUrl(SOURCE);
  assert.equal(proxiedPlaybackUrl(once), once);
});

// Clearing is not the same as switching off: it returns to whatever the build
// defaults to, which is the point of having a separate "off" value at all.
test("clearing the base falls back to the build default", () => {
  setMediaProxyBase("https://backend.example.com");
  setMediaProxyBase("");
  assert.equal(mediaProxyBase(), "");
  assert.equal(proxiedPlaybackUrl(SOURCE), SOURCE);
});

test("the off sentinel disables proxying outright", () => {
  setMediaProxyBase(MEDIA_PROXY_OFF);
  assert.equal(mediaProxyBase(), "");
  assert.equal(proxiedPlaybackUrl(SOURCE), SOURCE);
});

test("a stored base overrides the build default", () => {
  setMediaProxyBase("https://other.example.com");
  assert.equal(mediaProxyBase(), "https://other.example.com");
  assert.match(proxiedPlaybackUrl(SOURCE), /^https:\/\/other\.example\.com\//);
});
