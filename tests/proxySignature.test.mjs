import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureProxySignature,
  forgetProxySignatures,
  proxySignatureQuery,
  registerProxySigner,
} from "../src/lib/proxySignature.ts";

const future = () => Math.floor(Date.now() / 1000) + 3600;

test("a source is signed once, however many times it is asked about", async () => {
  forgetProxySignatures();
  let calls = 0;
  registerProxySigner(async () => {
    calls += 1;
    return { exp: future(), sig: "abc" };
  });
  await Promise.all([
    ensureProxySignature("https://host/a.mkv"),
    ensureProxySignature("https://host/a.mkv"),
  ]);
  await ensureProxySignature("https://host/a.mkv");
  assert.equal(calls, 1, "the second and third asks use the first answer");
  assert.match(proxySignatureQuery("https://host/a.mkv"), /^&exp=\d+&sig=abc$/);
});

test("a signature is per source, not shared", async () => {
  forgetProxySignatures();
  registerProxySigner(async (url) => ({ exp: future(), sig: url.endsWith("b.mkv") ? "bee" : "aye" }));
  await ensureProxySignature("https://host/a.mkv");
  assert.match(proxySignatureQuery("https://host/a.mkv"), /sig=aye$/);
  assert.equal(proxySignatureQuery("https://host/b.mkv"), "", "unasked is unsigned");
});

// The proxy serves unsigned requests until it is switched to refusing them, so
// a minting failure must not be the thing that stops a film playing.
test("a failure to mint is not thrown at the caller", async () => {
  forgetProxySignatures();
  registerProxySigner(async () => {
    throw new Error("no session");
  });
  await ensureProxySignature("https://host/a.mkv");
  assert.equal(proxySignatureQuery("https://host/a.mkv"), "");
});

test("an expired signature is not used", async () => {
  forgetProxySignatures();
  registerProxySigner(async () => ({ exp: Math.floor(Date.now() / 1000) - 5, sig: "old" }));
  await ensureProxySignature("https://host/a.mkv");
  assert.equal(proxySignatureQuery("https://host/a.mkv"), "");
});

// Signed a minute before it expires, because a request made now can still be
// in flight when the clock passes it.
test("one about to expire is treated as expired", async () => {
  forgetProxySignatures();
  registerProxySigner(async () => ({ exp: Math.floor(Date.now() / 1000) + 30, sig: "soon" }));
  await ensureProxySignature("https://host/a.mkv");
  assert.equal(proxySignatureQuery("https://host/a.mkv"), "");
});

test("the signature is escaped into the query", async () => {
  forgetProxySignatures();
  registerProxySigner(async () => ({ exp: future(), sig: "a+b/c=" }));
  await ensureProxySignature("https://host/a.mkv");
  assert.match(proxySignatureQuery("https://host/a.mkv"), /sig=a%2Bb%2Fc%3D$/);
});
