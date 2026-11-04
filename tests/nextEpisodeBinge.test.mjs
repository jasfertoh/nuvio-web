import assert from "node:assert/strict";
import test from "node:test";
import { pickBingeCandidates, pickBingeStream } from "../src/lib/nextEpisode.ts";

const direct = { url: "https://cdn/x.mkv", behaviorHints: {} };
const torrent = { infoHash: "a".repeat(40), behaviorHints: {} };
const grouped = { infoHash: "b".repeat(40), behaviorHints: { bingeGroup: "g1" } };
const nothing = { behaviorHints: {} };

// The case that broke continuing an episode: addons return torrents, and
// requiring a url meant nothing qualified at all.
test("a torrent counts as a candidate", () => {
  assert.equal(pickBingeCandidates([torrent]).length, 1);
  assert.equal(pickBingeStream([torrent]), torrent);
});

test("a source with neither a url nor a hash is not offered", () => {
  assert.deepEqual(pickBingeCandidates([nothing]), []);
  assert.equal(pickBingeStream([nothing]), null);
});

test("the binge group is preferred but others still follow it", () => {
  const ordered = pickBingeCandidates([direct, grouped], "g1");
  assert.equal(ordered[0], grouped);
  assert.equal(ordered[1], direct);
});

// The first cached-looking torrent may not actually be held, so more than one
// has to be offered for the caller to fall through.
test("several candidates are returned, capped", () => {
  const many = Array.from({ length: 20 }, () => ({ ...torrent }));
  assert.equal(pickBingeCandidates(many).length, 6);
});
