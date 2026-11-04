import assert from "node:assert/strict";
import test from "node:test";
import { createReturnReportCheck } from "../src/lib/externalReturn.ts";

const report = { outcome: "stopped", positionMs: 83_000, durationMs: 5_400_000 };

test("a late saved-position report settles before a manual fallback is allowed", async () => {
  let answer;
  let settled = false;
  const check = createReturnReportCheck(() => new Promise(resolve => { answer = resolve; }));
  const pending = check("playback").then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  answer(report);
  assert.equal(await pending, report);
});

test("pageshow and visibilitychange share the same consuming relay request", async () => {
  let answer;
  let reads = 0;
  const check = createReturnReportCheck(() => {
    reads += 1;
    return new Promise(resolve => { answer = resolve; });
  });
  const visible = check("playback");
  const shown = check("playback");
  assert.equal(visible, shown);
  answer(report);
  assert.deepEqual(await Promise.all([visible, shown]), [report, report]);
  assert.equal(reads, 1);
});

test("briefly empty relay responses are retried before showing manual entry", async () => {
  let reads = 0;
  const check = createReturnReportCheck(async () => ++reads === 3 ? report : null,
    { retryDelaysMs: [1, 1] });
  assert.equal(await check("playback"), report);
  assert.equal(reads, 3);
});

test("an unreachable relay falls back and can be checked again on the next return", async () => {
  let reads = 0;
  const check = createReturnReportCheck(async () => {
    reads += 1;
    throw new Error("offline");
  }, { retryDelaysMs: [] });
  assert.equal(await check("playback"), null);
  assert.equal(await check("playback"), null);
  assert.equal(reads, 2);
});

test("a stuck relay times out and aborts instead of permanently hiding manual entry", async () => {
  let signal;
  const check = createReturnReportCheck(async (_token, receivedSignal) => {
    signal = receivedSignal;
    return new Promise(() => {});
  }, { timeoutMs: 15, retryDelaysMs: [] });
  assert.equal(await check("playback"), null);
  assert.equal(signal.aborted, true);
});

test("a new playback token never shares the previous playback's result", async () => {
  const check = createReturnReportCheck(async token => token === "old" ? report : { outcome: "finished" });
  assert.deepEqual(await Promise.all([check("old"), check("new")]), [report, { outcome: "finished" }]);
});
