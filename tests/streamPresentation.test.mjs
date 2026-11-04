import assert from "node:assert/strict";
import test from "node:test";
import {
  sizeBytesFromText,
  streamHeadline,
  offeredInBrowser,
  streamLabel,
  streamQuality,
  streamReleaseName,
  streamSeeders,
  streamSizeBytes,
  streamTags,
  sortStreams,
} from "../src/lib/streamPresentation.ts";

/** What Torrentio actually returns: a release name, then a line of metadata. */
const TORRENT = {
  name: "Torrentio\n4k",
  title:
    "Reacher.S01E03.Spoonful.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-NTb\n👤 42 💾 5.81 GB ⚙️ ThePirateBay",
  description: "",
  addonName: "Torrentio",
  behaviorHints: {},
};

test("the headline is the first line, not the whole blob", () => {
  assert.equal(
    streamHeadline(TORRENT),
    "Reacher.S01E03.Spoonful.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-NTb",
  );
});

// `name` is the addon's own name with the quality after it, and the addon is
// already printed beside the row - heading with it would leave the release
// itself nowhere on screen.
test("a title outranks the addon's name", () => {
  assert.equal(streamHeadline({ ...TORRENT, title: "" }), "Torrentio");
});

test("a stream with nothing to say is named after its addon", () => {
  assert.equal(
    streamHeadline({ name: "", title: "", description: "", addonName: "Comet" }),
    "Comet",
  );
});

test("quality is read from anywhere in the text", () => {
  assert.equal(streamQuality(TORRENT), "4K");
  assert.equal(streamQuality({ ...TORRENT, name: "", title: "Movie 1080p WEB" }), "1080p");
  assert.equal(streamQuality({ name: "", title: "Movie", description: "" }), null);
});

test("sizes are parsed with their unit", () => {
  assert.equal(sizeBytesFromText("💾 5.81 GB"), Math.trunc(5.81 * 1024 ** 3));
  assert.equal(sizeBytesFromText("700 MB"), 700 * 1024 ** 2);
  assert.equal(sizeBytesFromText("1,5 GB"), Math.trunc(1.5 * 1024 ** 3));
  assert.equal(sizeBytesFromText("no size here"), null);
});

// A size the addon states properly is better evidence than one scraped out of
// a sentence, so it has to win.
test("a declared size outranks one found in the text", () => {
  assert.equal(
    streamSizeBytes({ ...TORRENT, behaviorHints: { videoSize: 12345 } }),
    12345,
  );
  assert.equal(streamSizeBytes(TORRENT), Math.trunc(5.81 * 1024 ** 3));
});

test("seeders are read from any of the shapes addons use", () => {
  assert.equal(streamSeeders(TORRENT), 42);
  assert.equal(streamSeeders({ name: "", title: "Seeders: 7", description: "" }), 7);
  assert.equal(streamSeeders({ name: "", title: "12 seeders", description: "" }), 12);
  assert.equal(streamSeeders({ name: "", title: "nothing", description: "" }), null);
});

test("tags name the encode and the source", () => {
  const tags = streamTags(TORRENT);
  assert.ok(tags.includes("WEB-DL"));
  assert.ok(tags.includes("HEVC"));
});

// "DTS" sits inside "DTS-HD" and "HDR" inside "HDR10": claiming both would have
// a row assert two things about one property.
test("a longer tag suppresses the shorter one it contains", () => {
  const tags = streamTags({ name: "", title: "Film HDR10 DTS-HD MA", description: "" });
  assert.ok(tags.includes("HDR10"));
  assert.ok(!tags.includes("HDR"));
  assert.ok(tags.includes("DTS-HD"));
  assert.ok(!tags.includes("DTS"));
});

const at = (q, size, addonName = "A") => ({
  name: "",
  title: `Release ${q} ${size}`,
  description: "",
  addonName,
  behaviorHints: {},
});

test("within one addon, sources are ordered best first", () => {
  const sorted = sortStreams([
    at("720p", "1.0 GB"),
    at("2160p", "20 GB"),
    at("1080p", "8 GB"),
    at("1080p", "2 GB"),
  ]);
  assert.deepEqual(
    sorted.map((s) => `${streamQuality(s)}/${Math.round((streamSizeBytes(s) ?? 0) / 1024 ** 3)}`),
    ["4K/20", "1080p/8", "1080p/2", "720p/1"],
  );
});

// Addon order comes first, so the list still reads as "what each addon found"
// rather than one interleaved run.
test("addons are kept together, in the order they first appear", () => {
  const sorted = sortStreams([
    at("720p", "1 GB", "First"),
    at("2160p", "30 GB", "Second"),
    at("1080p", "6 GB", "First"),
    at("480p", "0.4 GB", "Second"),
  ]);
  assert.deepEqual(
    sorted.map((s) => `${s.addonName}/${streamQuality(s)}`),
    ["First/1080p", "First/720p", "Second/4K", "Second/480p"],
  );
});

// Priority is the order an addon first appears in the results, which is the
// order the addons are installed in - not anything about the release itself.
// So a weaker source from the earlier addon still comes first.
test("a lesser source from the earlier addon still outranks a better one below", () => {
  const sorted = sortStreams([
    at("480p", "0.3 GB", "Earlier"),
    at("2160p", "40 GB", "Later"),
  ]);
  assert.deepEqual(
    sorted.map((s) => s.addonName),
    ["Earlier", "Later"],
  );
});

// Seeders only matter once quality and size have tied - a torrent nobody
// holds is no use however large.
test("seeders break a tie that size cannot", () => {
  const base = { name: "", description: "", behaviorHints: {} };
  const sorted = sortStreams([
    { ...base, title: "Film 1080p 5 GB 👤 2" },
    { ...base, title: "Film 1080p 5 GB 👤 90" },
  ]);
  assert.equal(streamSeeders(sorted[0]), 90);
});

// The whole point of the label: nothing the addon wrote reaches the heading,
// so a "[TORRENT]" marker or a tracker name cannot appear in it.
test("a managed stream is named from its attributes, not the addon's line", () => {
  assert.equal(streamLabel(TORRENT, "TB"), "4K TB Instant");
  assert.equal(
    streamLabel({ ...TORRENT, name: "", title: "[TORRENT] 1080p something" }, "TB"),
    "FHD TB Instant",
  );
});

// No resolution parsed is not a low one. Guessing would print a wrong quality
// word, which is worse than admitting there is none.
test("a stream with no parsable quality is Direct, not the lowest", () => {
  assert.equal(
    streamLabel({ name: "", title: "Some Release", description: "", addonName: "X" }, "TB"),
    "Direct TB Instant",
  );
});

// The TV leaves streams its resolver does not manage alone, and so does this:
// an HTTP link is not a torrent, and calling it instant would be untrue.
test("an unmanaged stream keeps the addon's own line", () => {
  assert.equal(
    streamLabel(TORRENT, null),
    "Reacher.S01E03.Spoonful.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-NTb",
  );
});

test("the release name is kept for the line beneath the label", () => {
  assert.equal(
    streamReleaseName(TORRENT),
    "Reacher.S01E03.Spoonful.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-NTb",
  );
});

// A declared filename is the real release; the heading is only a guess at it.
test("a declared filename outranks the heading", () => {
  assert.equal(
    streamReleaseName({ ...TORRENT, behaviorHints: { filename: "reacher.s01e03.mkv" } }),
    "reacher.s01e03.mkv",
  );
});

// Otherwise the row would print the addon's name three times over.
test("a heading that is only the addon's name is not a release", () => {
  assert.equal(
    streamReleaseName({ name: "", title: "", description: "", addonName: "Comet" }),
    null,
  );
});

// Missed until the label made it visible: a 1440p release was read as having
// no quality at all, so it sorted below 480p and was headed "Direct".
test("1440p is recognised and ranks under 4K", () => {
  const qhd = { name: "", title: "Thunderbolts 2025 1440p WEBRip", description: "" };
  assert.equal(streamQuality(qhd), "1440p");
  assert.equal(streamLabel(qhd, "TB"), "QHD TB Instant");
  assert.deepEqual(
    sortStreams([
      { ...qhd, addonName: "A" },
      { name: "", title: "Thunderbolts 2160p", description: "", addonName: "A" },
      { name: "", title: "Thunderbolts 1080p", description: "", addonName: "A" },
    ]).map(streamQuality),
    ["4K", "1440p", "1080p"],
  );
});

// 4K is filtered in the browser client only - it is the one place where every
// byte is paid for twice and displayed on a window that is scaling it down.
test("4K sources are not offered in the browser", () => {
  assert.equal(offeredInBrowser(TORRENT), false);
  assert.equal(
    offeredInBrowser({ name: "", title: "Movie 2160p WEB-DL", description: "" }),
    false,
  );
  assert.equal(
    offeredInBrowser({ name: "", title: "Movie 4K HDR", description: "" }),
    false,
  );
  assert.equal(
    offeredInBrowser({ name: "", title: "Movie 1080p WEB-DL", description: "" }),
    true,
  );
  // No parsable quality is not 4K, and hiding it would hide most direct links.
  assert.equal(
    offeredInBrowser({ name: "", title: "Some Release", description: "" }),
    true,
  );
});
