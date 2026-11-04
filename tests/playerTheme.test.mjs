import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const css = postcss.parse(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));
function declarations(selector, property) {
  const result = [];
  css.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(property, decl => result.push(decl.value));
  });
  return result;
}
test("all loading ring heads and SVG loaders use the selected accent", () => {
  for (const selector of [".mini-spinner", ".detail-entry-loading-content .mini-spinner", ".nuvio-loading-spinner", ".calendar-sync i", ".calendar-month-loading i"]) {
    assert.match(declarations(selector, "border-top-color").at(-1), /var\(--accent/);
  }
  for (const selector of [".spin", ".spin-icon", ".crate-spinner"]) {
    assert.equal(declarations(selector, "color").at(-1), "var(--accent)");
  }
});
