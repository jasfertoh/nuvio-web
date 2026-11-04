import assert from "node:assert/strict";
import test from "node:test";
import { continuationOrder, pickBingeCandidates, pickBingeStream } from "../src/lib/nextEpisode.ts";

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

test("a browser continuation skips 4K and keeps the quality being watched", () => {
  const uhd = { name: "Comet 2160p", title: "dv.2160p", infoHash: "c".repeat(40), behaviorHints: {} };
  const hd = { name: "Comet 1080p", title: "1080p", infoHash: "d".repeat(40), behaviorHints: {} };
  const sd = { name: "Comet 720p", title: "720p", infoHash: "e".repeat(40), behaviorHints: {} };
  const watching = { name: "Comet 1080p", title: "1080p", behaviorHints: {} };
  assert.deepEqual(continuationOrder([uhd, sd, hd], watching, true), [hd, sd]);
  // A native shell plays 4K itself, so only the ordering applies.
  assert.deepEqual(continuationOrder([uhd, sd, hd], watching, false), [hd, uhd, sd]);
});
