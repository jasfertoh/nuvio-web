import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetHashes,
  partitionHashes,
  rememberHashes,
} from "../src/lib/cachedHashes.ts";

test("an unasked hash has to be asked about", () => {
  forgetHashes();
  const { known, missing } = partitionHashes(["aaa", "bbb"]);
  assert.deepEqual(known, {});
  assert.deepEqual(missing, ["aaa", "bbb"]);
});

test("an answer is remembered, including a no", () => {
  forgetHashes();
  rememberHashes({ aaa: true, bbb: false });
  const { known, missing } = partitionHashes(["aaa", "bbb", "ccc"]);
  assert.deepEqual(known, { aaa: true, bbb: false });
  assert.deepEqual(missing, ["ccc"], "only the unknown one is asked about");
});

// This is a claim about somebody else's cache: a torrent can be added or
// expire while the app is open, and a stale "no" hides a playable source.
test("what was learned ten minutes ago is asked again", () => {
  forgetHashes();
  const now = 1_000_000;
  rememberHashes({ aaa: true }, now);
  assert.deepEqual(partitionHashes(["aaa"], now + 9 * 60_000).missing, []);
  assert.deepEqual(partitionHashes(["aaa"], now + 11 * 60_000).missing, ["aaa"]);
});

test("the oldest are dropped once it is full", () => {
  forgetHashes();
  const now = 5;
  for (let index = 0; index < 4_100; index += 1)
    rememberHashes({ [`h${index}`]: true }, now + index);
  const { missing } = partitionHashes(["h0", "h4099"], now + 4_200);
  assert.deepEqual(missing, ["h0"], "the first seen went, the last stayed");
});

// Asking again refreshes a hash's place in the queue, or a torrent looked at
// on every title would still be evicted before one seen once.
test("a hash asked about again is not the oldest any more", () => {
  forgetHashes();
  rememberHashes({ old: true }, 1);
  rememberHashes({ newer: true }, 2);
  rememberHashes({ old: true }, 3);
  // Exactly enough to push one entry out: "newer", which has not been asked
  // about since, rather than "old", which has.
  for (let index = 0; index < 3_999; index += 1)
    rememberHashes({ [`h${index}`]: true }, 4 + index);
  assert.deepEqual(partitionHashes(["newer"], 10).missing, ["newer"]);
  assert.deepEqual(partitionHashes(["old"], 10).missing, []);
});
