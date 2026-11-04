import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const update = readFileSync(new URL("../src/lib/appUpdate.ts", import.meta.url), "utf8");
const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

test("web builds install service-worker updates automatically", () => {
  assert.match(vite, /registerType:\s*"autoUpdate"/);
  assert.match(main, /onNeedReload\(\)/);
  assert.match(main, /reloadForUpdateWhenSafe\(\)/);
  assert.doesNotMatch(app, /UpdateModal|hasUpdate|updatePrompt/);
});

test("an automatic reload waits until the app is out of sight and no player is open", () => {
  // Reloading during ordinary browsing dropped people mid-scroll back at the
  // profile picker whenever a deploy landed.
  assert.match(update, /querySelector\("\.player-view"\)/);
  assert.match(update, /document\.visibilityState !== "hidden" \|\| playerOpen\(\)/);
  assert.match(update, /addEventListener\("visibilitychange", reloadIfUnseen\)/);
  // An old build that outlives its chunks reloads when one fails to load.
  assert.match(main, /addEventListener\("vite:preloadError"/);
});
