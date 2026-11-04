import assert from "node:assert/strict";
import test from "node:test";
import { codecsFromInit, initSegmentLength, startOffsetFromInit } from "../src/lib/proxyMse.ts";

const box = (type, ...parts) => {
  const body = parts.reduce((all, part) => [...all, ...part], []);
  const size = 8 + body.length;
  return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body];
};
const zeros = (n) => new Array(n).fill(0);
const stsd = (entry) => box("stsd", zeros(4), [0, 0, 0, 1], entry);
const hdlr = (kind) => box("hdlr", zeros(8), [...kind].map((c) => c.charCodeAt(0)), zeros(12));
const trak = (entry, kind = entry.slice(4, 8).map((c) => String.fromCharCode(c)).join("") === "mp4a" ? "soun" : "vide") =>
  box("trak", box("mdia", hdlr(kind), box("minf", box("stbl", stsd(entry)))));

const avc = box("avc1", zeros(78), box("avcC", [1, 0x64, 0x00, 0x28, 0xff]));
// hvcC: version, profile_space/tier/profile (Main = 1), compat 0x60000000, 6 constraint bytes, level 120.
const hvc = box("hvc1", zeros(78), box("hvcC", [1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120]));
const aac = box("mp4a", zeros(28));

test("an init segment is complete once its moov has fully arrived", () => {
  const init = [...box("ftyp", zeros(8)), ...box("moov", trak(avc))];
  const moof = box("moof", zeros(8));
  assert.equal(initSegmentLength(new Uint8Array(init.slice(0, init.length - 3))), null);
  assert.equal(initSegmentLength(new Uint8Array([...init, ...moof])), init.length);
});

test("codecs are named from the sample entries", () => {
  assert.equal(codecsFromInit(new Uint8Array(box("moov", trak(avc), trak(aac)))), "avc1.640028,mp4a.40.2");
  assert.equal(codecsFromInit(new Uint8Array(box("moov", trak(hvc)))), "hvc1.1.6.L120.90");
});

test("an unknown codec is not guessed at", () => {
  assert.equal(codecsFromInit(new Uint8Array(box("moov", trak(box("vp09", zeros(80)))))), null);
});

test("a chapter track is skipped rather than failing the whole stream", () => {
  const chapters = trak(box("text", zeros(40)), "text");
  assert.equal(codecsFromInit(new Uint8Array(box("moov", trak(avc), trak(aac), chapters))), "avc1.640028,mp4a.40.2");
});

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const i32 = (n) => u32(n >>> 0);
// mvhd v0: version/flags, creation, modification, timescale, ...
const mvhd = (timescale) => box("mvhd", zeros(4), zeros(8), u32(timescale), zeros(80));
const elst = (entries) => box("edts", box("elst", zeros(4), u32(entries.length), ...entries.map(([d, m]) => [...u32(d), ...i32(m), 0, 1, 0, 0])));
const vtrak = (edits) => box("trak", edits, box("mdia", hdlr("vide"), box("minf", box("stbl", stsd(avc)))));

test("the start comes from the video track's empty edit", () => {
  // As the proxy writes it for start=1790: an empty edit of 1789.579s, then the media.
  const init = box("moov", mvhd(1000), vtrak(elst([[1789579, -1], [0, 1328]])));
  assert.equal(startOffsetFromInit(new Uint8Array(init)), 1789.579);
});

test("a stream from the beginning has no offset", () => {
  assert.equal(startOffsetFromInit(new Uint8Array(box("moov", mvhd(1000), vtrak(elst([[0, 0]]))))), 0);
  assert.equal(startOffsetFromInit(new Uint8Array(box("moov", mvhd(1000), vtrak([])))), 0);
});
