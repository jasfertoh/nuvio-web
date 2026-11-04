import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBTITLE_FONTS,
  SUBTITLE_FONT_KEYS,
  subtitleFontStack,
} from "../src/lib/subtitleFonts.ts";

test("every offered face has a label and a stack", () => {
  assert.ok(SUBTITLE_FONT_KEYS.length >= 2);
  for (const key of SUBTITLE_FONT_KEYS) {
    assert.ok(SUBTITLE_FONTS[key].label, `${key} needs a label`);
    assert.ok(SUBTITLE_FONTS[key].stack.includes(","), `${key} needs a fallback`);
  }
});

// Nothing may be fetched to draw a subtitle: a line that arrives late because
// its font is still downloading is worse than one in a face nobody picked.
test("no face asks the browser to download anything", () => {
  for (const key of SUBTITLE_FONT_KEYS)
    assert.doesNotMatch(
      SUBTITLE_FONTS[key].stack,
      /url\(|@import|fonts\.googleapis/,
      `${key} must name families the browser already has`,
    );
});

// A key saved by a newer build, or a blob written by another client, must not
// leave the player with no font at all.
test("an unknown face falls back rather than failing", () => {
  assert.equal(subtitleFontStack("mono"), SUBTITLE_FONTS.mono.stack);
  assert.equal(subtitleFontStack("something-else"), SUBTITLE_FONTS.default.stack);
  assert.equal(subtitleFontStack(""), SUBTITLE_FONTS.default.stack);
});
