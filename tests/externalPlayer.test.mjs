import assert from "node:assert/strict";
import test from "node:test";
import { infusePlaybackUrl, lennaPlaybackUrl, shortcutReturnUrl } from "../src/lib/externalPlayer.ts";

test("Infuse handoff encodes signed stream URLs and a useful filename", () => {
  const result = infusePlaybackUrl(
    "https://media.example/movie.mkv?token=a+b&part=1",
    "House / Dragon: S1E1",
  );
  const parsed = new URL(result);

  assert.equal(parsed.protocol, "infuse:");
  assert.equal(parsed.pathname, "/play");
  assert.equal(
    parsed.searchParams.get("url"),
    "https://media.example/movie.mkv?token=a+b&part=1",
  );
  assert.equal(parsed.searchParams.get("filename"), "House _ Dragon_ S1E1.mkv");
});

test("the Shortcut return address keeps the trailing slash and a literal space", () => {
  const url = shortcutReturnUrl(
    "https://nuvio.example/",
    "?nuvio-external=stopped",
  );
  assert.ok(url.startsWith("shortcuts://run-shortcut?"));
  // "+" would be read as a plus by anything not decoding a form, and the name
  // has to match the installed Shortcut exactly.
  assert.ok(!url.includes("+"));
  assert.ok(url.includes("name=Open%20Nuvio"));
  const params = new URLSearchParams(url.split("?").slice(1).join("?"));
  assert.equal(params.get("name"), "Open Nuvio");
  assert.equal(
    params.get("text"),
    "webapp://nuvio.example/?nuvio-external=stopped",
  );
});

test("the Shortcut return address follows wherever the app is served from", () => {
  const pages = new URLSearchParams(
    shortcutReturnUrl("https://lucaboox.github.io/nuvio-web/", "?nuvio-external=finished")
      .split("?").slice(1).join("?"),
  );
  assert.equal(
    pages.get("text"),
    "webapp://lucaboox.github.io/nuvio-web/?nuvio-external=finished",
  );
  // A missing trailing slash is added: without it iOS does not find the app.
  const bare = new URLSearchParams(
    shortcutReturnUrl("https://example.com", "?nuvio-external=stopped")
      .split("?").slice(1).join("?"),
  );
  assert.equal(bare.get("text"), "webapp://example.com/?nuvio-external=stopped");
});

test("Lenna starts where you left off and reports back through the relay", () => {
  const href = lennaPlaybackUrl("https://cdn.example/film.mkv?sig=a&b=c", {
    positionSeconds: 754.9,
    subtitleUrl: "https://subs.example/en.srt",
    returnUrlFor: (query) => `https://relay.example/r/token${query}`,
  });
  assert.ok(href.startsWith("lenna://x-callback-url/play?"));
  const params = new URL(href.replace("lenna://", "https://")).searchParams;
  assert.equal(params.get("url"), "https://cdn.example/film.mkv?sig=a&b=c");
  assert.equal(params.get("sub"), "https://subs.example/en.srt");
  assert.equal(params.get("position"), "754");
  assert.equal(params.get("x-success"), "https://relay.example/r/token?nuvio-external=stopped");
  assert.equal(params.get("x-error"), params.get("x-success"));
  // Without a relay there is nothing to report to, and nothing is promised.
  const bare = new URL(lennaPlaybackUrl("https://cdn.example/a.mp4").replace("lenna://", "https://")).searchParams;
  assert.equal(bare.get("x-success"), null);
  assert.equal(bare.get("position"), "0");
});
