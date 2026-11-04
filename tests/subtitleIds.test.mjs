import assert from "node:assert/strict";
import test from "node:test";
import { idForPrefixes, subtitleRequestIds } from "../src/lib/subtitleIds.ts";

test("an anime episode is also offered by its IMDb mapping", () => {
  assert.deepEqual(
    subtitleRequestIds(
      { id: "kitsu:12" },
      { id: "kitsu:12:1", imdbId: "tt0388629", imdbSeason: 1, imdbEpisode: 1 },
    ),
    ["kitsu:12:1", "tt0388629:1:1"],
  );
  assert.deepEqual(subtitleRequestIds({ id: "kitsu:9", imdbId: "tt9" }), ["kitsu:9", "tt9"]);
  assert.deepEqual(subtitleRequestIds({ id: "tt5" }, { id: "tt5:1:1" }), ["tt5:1:1"]);
});

test("subtitle addons are asked with an id they declare, or not at all", () => {
  const ids = ["kitsu:12:1", "tt0388629:1:1"];
  assert.equal(idForPrefixes(ids, ["tt"]), "tt0388629:1:1");
  assert.equal(idForPrefixes(ids, ["kitsu"]), "kitsu:12:1");
  assert.equal(idForPrefixes(ids, undefined), "kitsu:12:1");
  assert.equal(idForPrefixes(["kitsu:12:1"], ["tt"]), undefined);
});
