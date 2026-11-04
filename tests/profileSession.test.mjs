import assert from "node:assert/strict";
import test from "node:test";
import { profileForReload, profileSessionMarker } from "../src/lib/profileSession.ts";

const profile = { id: "profile-a", userId: "account-a", profileIndex: 2, name: "A" };

test("a reload restores the same tab profile, including its PIN requirement", () => {
  const locked = { ...profile, pinEnabled: true };
  assert.equal(profileForReload([locked], profileSessionMarker(locked)), locked);
  assert.equal(profileForReload([locked], "2"), locked);
});

test("a tab marker cannot select a different account's or recreated profile", () => {
  const stored = profileSessionMarker(profile);
  assert.equal(profileForReload([{ ...profile, userId: "account-b" }], stored), undefined);
  assert.equal(profileForReload([{ ...profile, id: "replacement" }], stored), undefined);
  assert.equal(profileForReload([], stored), undefined);
});

test("missing, corrupt and invalid tab markers leave the picker available", () => {
  for (const stored of [null, "", " ", "broken", "null", "[]", "{}", '"2"', "2.5"]) {
    assert.equal(profileForReload([profile], stored), undefined);
  }
});
