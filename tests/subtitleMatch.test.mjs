import assert from "node:assert/strict";
import test from "node:test";
import { releaseTraits, subtitleFrameRateMatches, subtitleMatchesVideo } from "../src/lib/subtitleMatch.ts";

const pack = "Dead-End Job (2026) S01 EP (01-08) TRUE WEB-DL - 1080p - AVC - [Tamil + Telugu + Hindi + Eng + Kor]";
const marky = "Dead.End.Job.2026.S01E03.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-MARKY";

test("release traits are read from scene names", () => {
  assert.deepEqual(releaseTraits(`${marky}.mkv`), { group: "marky", source: "web", service: "nf", resolution: "1080p" });
  assert.equal(releaseTraits(pack).group, undefined);
  assert.equal(releaseTraits("Show.S01E01.1080p.WEB-DL").group, undefined);
});

test("a named group must be the same group", () => {
  assert.equal(subtitleMatchesVideo({ release: marky }, `${marky}.mkv`), true);
  assert.equal(subtitleMatchesVideo({ release: "Dead-End.Job.S01E03.1080p.WEB.h264-GRACE" }, `${marky}.mkv`), false);
});

test("without a group, source, resolution and service must agree", () => {
  assert.equal(subtitleMatchesVideo({ release: marky }, pack), true);
  assert.equal(subtitleMatchesVideo({ release: "Dead.End.Job.S01E03.720p.WEB-DL-X" }, pack), false);
  assert.equal(subtitleMatchesVideo({ release: "Dead.End.Job.S01E03.1080p.BluRay.x264-Y" }, pack), false);
  assert.equal(subtitleMatchesVideo({ release: "Dead.End.Job.S01E03.1080p.AMZN.WEB-DL-Z" }, "Show.S01E03.1080p.NF.WEB-DL"), false);
});

test("a hash match always counts, and no release information never does", () => {
  assert.equal(subtitleMatchesVideo({ hashMatch: true }, undefined), true);
  assert.equal(subtitleMatchesVideo({}, pack), false);
  assert.equal(subtitleMatchesVideo({ release: marky }, undefined), false);
});

test("a subtitle at another frame rate is refused; an unknown rate is not", () => {
  assert.equal(subtitleFrameRateMatches(23.976, 23.976), true);
  assert.equal(subtitleFrameRateMatches(24, 23.976), false);
  assert.equal(subtitleFrameRateMatches(25, 23.976), false);
  assert.equal(subtitleFrameRateMatches(undefined, 23.976), true);
  assert.equal(subtitleFrameRateMatches(24, 0), true);
});
