import assert from "node:assert/strict";
import test from "node:test";
import { COOLDOWN_BASE_MS, createHostCooldown } from "../src/lib/requestPolicy.ts";
import { posterCandidates } from "../src/lib/posterFallback.ts";

const A = "https://aiometadata.elfhosted.com/stremio/x/meta/movie/tt1.json";
const A2 = "https://aiometadata.elfhosted.com/stremio/x/meta/movie/tt2.json";
const B = "https://v3-cinemeta.strem.io/meta/movie/tt1.json";

test("a refusal pauses the whole host, and only that host", () => {
  let clock = 1_000;
  const cooldown = createHostCooldown(() => clock);
  assert.equal(cooldown.delayFor(A), 0);
  cooldown.strike(A);
  assert.equal(cooldown.delayFor(A2), COOLDOWN_BASE_MS, "another title on the same host waits too");
  assert.equal(cooldown.delayFor(B), 0, "another addon is not held up");
});

test("refusals arriving together count once; later ones double the wait", () => {
  let clock = 0;
  const cooldown = createHostCooldown(() => clock);
  // Four requests in flight, all refused at once.
  for (let i = 0; i < 4; i += 1) cooldown.strike(A);
  assert.equal(cooldown.delayFor(A), COOLDOWN_BASE_MS);
  clock += COOLDOWN_BASE_MS;
  cooldown.strike(A);
  assert.equal(cooldown.delayFor(A), COOLDOWN_BASE_MS * 2);
  // Answers bring it back down.
  clock += COOLDOWN_BASE_MS * 2;
  cooldown.success(A);
  cooldown.success(A);
  cooldown.strike(A);
  assert.equal(cooldown.delayFor(A), COOLDOWN_BASE_MS);
});

test("a host's Retry-After wins when it asks for longer", () => {
  const cooldown = createHostCooldown(() => 0);
  cooldown.strike(A, "10");
  assert.equal(cooldown.delayFor(A), 10_000);
});

test("an AIOMetadata poster falls back to the plain image it names, then Metahub", () => {
  const proxied =
    "https://aiometadata.elfhosted.com/poster-cache/proxy/poster/movie/tt10403420?fallback=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw600_and_h900_bestv2%2Fq.jpg&url=https%3A%2F%2Fbtttr.cc%2Fposter.jpg&sig=z";
  assert.deepEqual(posterCandidates(proxied, "tt10403420"), [
    proxied,
    "https://image.tmdb.org/t/p/w600_and_h900_bestv2/q.jpg",
    "https://images.metahub.space/poster/medium/tt10403420/img",
  ]);
  // No poster, no IMDb id: nothing to try, and the initial is drawn.
  assert.deepEqual(posterCandidates(undefined, "tmdb:603"), []);
  // Only https is ever tried.
  assert.deepEqual(posterCandidates("http://x.example/p.jpg", "kitsu:1"), []);
});
