// Run with NODE_PATH pointing at a Playwright installation. No account or addon
// requests are made: this exercises the real shelves with 6,000 local posters.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require("playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { HomeShelf } from './src/components/HomeShelf';
      import { MediaRow } from './src/components/Media';
      const index = { byContent: new Map(), watched: new Set() };
      const poster = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="140" height="210"><rect width="140" height="210" fill="teal"/></svg>';
      const sections = Array.from({length: 250}, (_, row) => ({
        key: String(row), name: 'Catalogue ' + row,
        items: Array.from({length: 24}, (_, col) => ({
          id: row + '-' + col, type: 'movie', name: 'Movie ' + col, poster,
        })),
      }));
      const app = createRoot(document.getElementById('root'));
      window.drawShelves = (enabled = true) => app.render(
        <div id="scroll-area" style={{height: '100vh', overflow: 'auto'}}>
          {sections.map((section) => <HomeShelf key={section.key} enabled={enabled}>
            <MediaRow section={section} index={index} onOpen={() => {}} />
          </HomeShelf>)}
        </div>
      );
      window.drawShelves();
    `,
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(bundle.outputFiles[0].text);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(`<html><head><style>${css}</style></head><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const engine = process.env.NUVIO_TEST_WEBKIT ? webkit : chromium;
let browser;
try {
  browser = await engine.launch({ headless: true, executablePath: process.env.NUVIO_TEST_BROWSER_EXECUTABLE });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({
      viewport,
      isMobile: viewport.width < 760,
      hasTouch: viewport.width < 760,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length > 0);
    const mounted = () => page.locator('.poster-card').count();
    assert.equal(await page.locator('.home-shelf').count(), 250);
    assert.ok(await mounted() < 400, "initial mount is bounded instead of 6,000 cards");

    const original = await page.locator('.home-shelf').first().boundingBox();
    const firstRow = page.locator('.media-row').first();
    await firstRow.evaluate((row) => { row.scrollLeft = 400; });
    await page.waitForTimeout(150);
    const saved = await firstRow.evaluate((row) => row.scrollLeft);
    assert.ok(saved > 0);

    // Browse far beyond the initial rows and make sure old poster trees leave.
    for (const position of [0.25, 0.5, 0.75, 1]) {
      await page.locator('#scroll-area').evaluate((node, position) => {
        node.scrollTop = (node.scrollHeight - node.clientHeight) * position;
      }, position);
      await page.waitForTimeout(200);
      assert.ok(await mounted() < 400, "scrolling does not accumulate mounted posters");
    }
    assert.equal(await page.locator('.home-shelf').first().locator('.poster-card').count(), 0);
    const placeholder = await page.locator('.home-shelf').first().evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(Math.abs(placeholder - original.height) < 1, "unmounted row keeps its measured height");
    await page.locator('#scroll-area').evaluate((node) => { node.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('.home-shelf .media-row') !== null);
    await page.waitForTimeout(250);
    const restored = await page.locator('.media-row').first().evaluate((row) => row.scrollLeft);
    assert.ok(Math.abs(saved - restored) < 2, `horizontal position restored: ${saved} vs ${restored}`);
    await page.locator('.home-shelf').nth(125).focus();
    await page.waitForFunction(() => document.querySelectorAll('.home-shelf')[125].querySelector('.poster-card'));
    assert.ok(await mounted() < 400, "keyboard focus can reveal an unmounted shelf without mounting the entire page");
    assert.deepEqual(errors, []);
    console.log(`${viewport.width}px: 250 catalogues, ${await mounted()} mounted posters; height and horizontal position preserved`);

    // Native capability callers opt out so controller navigation can still
    // find controls on rows beyond the current viewport.
    await page.evaluate(() => window.drawShelves(false));
    await page.waitForFunction(() => document.querySelectorAll('.poster-card').length === 6000);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
