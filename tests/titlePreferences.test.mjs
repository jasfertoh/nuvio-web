import assert from "node:assert/strict";
import test from "node:test";

// A stand-in for the browser's, so the module can be exercised under node.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

const {
  clearTitlePreferences,
  readTitlePreferences,
  rememberTitlePreference,
  titleKey,
} = await import("../src/lib/titlePreferences.ts");

const key = titleKey("1", "tt123");

test("nothing is remembered until something is set", () => {
  clearTitlePreferences();
  assert.deepEqual(readTitlePreferences(key), {});
});

// Setting a delay must not forget the language chosen a minute earlier.
test("preferences merge rather than replace", () => {
  clearTitlePreferences();
  rememberTitlePreference(key, { subtitleLanguage: "eng" });
  rememberTitlePreference(key, { subtitleDelayMs: -500 });
  const found = readTitlePreferences(key);
  assert.equal(found.subtitleLanguage, "eng");
  assert.equal(found.subtitleDelayMs, -500);
});

// Three people share this browser; a delay one of them set says nothing about
// what the others are watching.
test("profiles do not share a title's preferences", () => {
  clearTitlePreferences();
  rememberTitlePreference(titleKey("1", "tt123"), { subtitleDelayMs: 250 });
  assert.equal(readTitlePreferences(titleKey("2", "tt123")).subtitleDelayMs, undefined);
});

test("titles do not share either", () => {
  clearTitlePreferences();
  rememberTitlePreference(titleKey("1", "tt123"), { subtitleDelayMs: 250 });
  assert.equal(readTitlePreferences(titleKey("1", "tt999")).subtitleDelayMs, undefined);
});

// A zero delay is the absence of a correction, not a correction of zero -
// otherwise resetting one would pin the title to a value forever.
test("resetting a delay to zero forgets it", () => {
  clearTitlePreferences();
  rememberTitlePreference(key, { subtitleDelayMs: 400 });
  rememberTitlePreference(key, { subtitleDelayMs: 0 });
  assert.equal(readTitlePreferences(key).subtitleDelayMs, undefined);
});

test("a title with nothing left to say is dropped", () => {
  clearTitlePreferences();
  rememberTitlePreference(key, { subtitleDelayMs: 400 });
  rememberTitlePreference(key, { subtitleDelayMs: 0 });
  assert.equal(localStorage.getItem("nuvio-web-title-preferences"), "{}");
});

// One browser must not accumulate an unbounded blob.
test("the oldest titles are dropped once it is full", () => {
  clearTitlePreferences();
  for (let index = 0; index < 205; index += 1)
    rememberTitlePreference(titleKey("1", `tt${index}`), { subtitleDelayMs: 100 }, index);
  assert.equal(readTitlePreferences(titleKey("1", "tt0")).subtitleDelayMs, undefined);
  assert.equal(readTitlePreferences(titleKey("1", "tt204")).subtitleDelayMs, 100);
});

// A blob from an older version, or a half-written one, must not throw on the
// path that opens the player.
test("unreadable storage reads as no preferences", () => {
  store.set("nuvio-web-title-preferences", "not json at all");
  assert.equal(readTitlePreferences(key).subtitleDelayMs, undefined);
  store.set("nuvio-web-title-preferences", JSON.stringify([1, 2, 3]));
  assert.equal(readTitlePreferences(key).subtitleDelayMs, undefined);
  store.set("nuvio-web-title-preferences", JSON.stringify({ [key]: "nonsense" }));
  assert.equal(readTitlePreferences(key).subtitleDelayMs, undefined);
});

test("values of the wrong type are ignored, not trusted", () => {
  clearTitlePreferences();
  store.set(
    "nuvio-web-title-preferences",
    JSON.stringify({ [key]: { subtitleDelayMs: "soon", subtitleLanguage: 7, at: 1 } }),
  );
  const found = readTitlePreferences(key);
  assert.equal(found.subtitleDelayMs, undefined);
  assert.equal(found.subtitleLanguage, undefined);
});
