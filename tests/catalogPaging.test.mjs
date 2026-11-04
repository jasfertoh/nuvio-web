import assert from "node:assert/strict";
import test from "node:test";
import { mergePage } from "../src/lib/catalogPaging.ts";
import { shouldRetry } from "../src/lib/requestPolicy.ts";

const meta = (id, type = "movie") => ({ id, type, name: id });

test("page two starts where the addon's first page ended, not at what is shown", () => {
  // A home row shows 24 of a 50-title first page; the catalog page starts
  // from all 50, and page two must be asked for from 50.
  const firstPage = Array.from({ length: 50 }, (_, index) => meta(`tt${index}`));
  const merged = mergePage(firstPage.slice(0, 24), 0, firstPage);
  assert.equal(merged.nextOffset, 50);
  assert.equal(merged.additions.length, 26);
  assert.equal(merged.done, false);
});

test("the offset moves by what was sent, even when duplicates are dropped", () => {
  const shown = [meta("a"), meta("b")];
  const page = [meta("b"), meta("c"), meta("c"), meta("d")];
  const merged = mergePage(shown, 20, page);
  assert.deepEqual(merged.additions.map((item) => item.id), ["c", "d"]);
  assert.equal(merged.nextOffset, 24);
  assert.equal(merged.done, false);
});

test("an empty page, or one with nothing new, ends the scroll", () => {
  assert.equal(mergePage([meta("a")], 10, []).done, true);
  // An addon that ignores `skip` sends its first page again.
  assert.equal(mergePage([meta("a"), meta("b")], 2, [meta("a"), meta("b")]).done, true);
  // Same id under another type is a different title.
  assert.equal(mergePage([meta("a")], 1, [meta("a", "series")]).done, false);
});

test("a blocked request is retried like a rate limit, a refusal is not", () => {
  // What the browser reports a CORS-less 429 or 504 as.
  assert.equal(shouldRetry(Object.assign(new Error("blocked"), { blocked: true })), true);
  assert.equal(shouldRetry(Object.assign(new Error("HTTP 429"), { status: 429 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("HTTP 503"), { status: 503 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("HTTP 404"), { status: 404 })), false);
  assert.equal(shouldRetry(new Error("Response is too large.")), false);
  assert.equal(shouldRetry(null), false);
});
