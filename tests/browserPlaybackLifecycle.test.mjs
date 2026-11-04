import assert from 'node:assert/strict';
import test from 'node:test';
import { MediabunnyPlayer } from '../src/lib/mediabunnyPlayer.ts';
import { readFileSync } from 'node:fs';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const player = () => new MediabunnyPlayer('https://example.test/file.mkv', {}, () => {});

test('silent video has an advancing wall clock rather than waiting forever for audio', () => {
  const p = player();
  p.playing = true;
  p.startedFrom = 10;
  p.contextStartTime = performance.now() / 1000 - 2;
  assert.ok(p.currentTime >= 12);
  p.pause();
  const paused = p.currentTime;
  assert.equal(p.currentTime, paused);
});

test('resuming holds the clock until the picture is back', () => {
  const p = player();
  // Where a resume starts: the position is known, the decoder is not there
  // yet. Re-opening it at the keyframe before this point is a second or two
  // of work, and the sound used to run for all of it.
  p.videoSink = {};
  p.pausedAt = 30;
  p.startedFrom = 30;
  p.playing = true;
  p.priming = true;
  p.contextStartTime = performance.now() / 1000 - 5;
  assert.equal(p.currentTime, 30, 'the clock must not run while priming');

  // The first frame lands; the origin is taken then, so nothing was lost.
  p.priming = false;
  p.contextStartTime = performance.now() / 1000;
  assert.ok(p.currentTime < 30.5, 'playback resumes from where it paused');
});

test('pausing parks the video decoder rather than closing it', () => {
  const p = player();
  p.videoSink = {};
  p.videoRunning = true;
  p.playing = true;
  p.startedFrom = 0;
  p.contextStartTime = performance.now() / 1000 - 10;
  const lifetime = p.videoGeneration;

  p.pause();

  // The run is over — audio and the clock stop — but the video loop's own
  // lifetime is untouched, so it is still parked holding the next frame.
  // Closing it meant an unpause re-opened the decoder at the keyframe before
  // the resume point to arrive back at the frame already on the canvas.
  assert.equal(p.videoGeneration, lifetime);
  assert.equal(p.videoRunning, true);
});

test('a seek does close it, because the decoder has to move', async () => {
  const p = player();
  p.videoRunning = true;
  const lifetime = p.videoGeneration;

  await p.seek(120);

  assert.ok(p.videoGeneration > lifetime, 'a move invalidates the video loop');
  assert.equal(p.videoRunning, false, 'and the next play re-opens it');
});

test('a resume draws from the resume point, not from the keyframe before it', () => {
  const engine = readFileSync(
    new URL("../src/lib/mediabunnyPlayer.ts", import.meta.url),
    "utf8",
  );
  // Frames decoded on the way up to the resume point are already watched;
  // drawing them rewinds the picture before it jumps forward again.
  assert.match(engine, /if \(frame\.timestamp < start\) continue;/);
  // And the sound waits for the picture rather than the other way round.
  assert.match(engine, /await this\.pictureReady;/);
  assert.match(engine, /this\.releasePicture\?\.\(\);/);
  // Only where there is a decoder to open. An unpause has one parked on the
  // next frame, and waiting there would be a stall of the engine's own making.
  assert.match(engine, /const reopening = !!this\.videoSink && !this\.videoRunning;/);
  // The wait is a spinner rather than a picture that has stopped for no
  // stated reason, and it ends by saying so.
  assert.match(engine, /if \(this\.priming\) this\.report\("buffering", ""\);/);
  assert.match(engine, /if \(this\.playing\) this\.reportReady\(\);/);
});

test('decoded playback clock follows the selected speed', () => {
  const p = player();
  p.setPlaybackRate(2);
  p.playing = true;
  p.startedFrom = 10;
  p.contextStartTime = performance.now() / 1000 - 2;
  assert.ok(p.currentTime >= 14);
  p.pause();
});

test('the experimental Movi player is no longer shipped or selectable', () => {
  const component = readFileSync(
    new URL("../src/components/Player.tsx", import.meta.url),
    "utf8",
  );
  const packageJson = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(component, /movi-player|MoviPlayer/);
  assert.doesNotMatch(packageJson, /movi-player/);
});

test('stopped startup cannot continue into another stage', async () => {
  const p = player();
  const pending = deferred();
  const stage = p.stage('Testing', () => pending.promise);
  p.stop();
  pending.resolve('late');
  await assert.rejects(stage, /canceled/);
  let ran = false;
  await assert.rejects(p.stage('Next', async () => { ran = true; }), /canceled/);
  assert.equal(ran, false);
});

test('startup timeout disposes input resources', async () => {
  const p = player();
  let disposed = false;
  p.input = { dispose() { disposed = true; } };
  await assert.rejects(p.stage('Testing', () => new Promise(() => {}), 1), /Gave up/);
  assert.equal(disposed, true);
});

test('late audio resume cannot revive stopped playback', async () => {
  const p = player();
  const pending = deferred();
  p.context = { state: 'suspended', resume: () => pending.promise, close: async () => {} };
  let started = false;
  p.run = () => { started = true; };
  const play = p.play();
  p.stop();
  p.context.state = 'running';
  pending.resolve();
  await play;
  assert.equal(started, false);
  assert.equal(p.paused, true);
});

test('old seek frame cannot paint over a newer seek', async () => {
  const p = player();
  const pending = deferred();
  const drawn = [];
  p.videoSink = { getCanvas: time => time === 1 ? pending.promise : Promise.resolve({ timestamp: time }) };
  p.draw = frame => drawn.push(frame.timestamp);
  const old = p.seek(1);
  await p.seek(2);
  pending.resolve({ timestamp: 1 });
  await old;
  assert.deepEqual(drawn, [2]);
});

test('a seek with no still frame keeps playing rather than failing', async () => {
  // The still drawn at a seek destination is a courtesy. Throwing when one
  // cannot be produced ended playback — and a resumed episode seeks to its
  // saved position first, so the same file played or died depending on where
  // it was left. That is what made it work one time and not the next.
  // Whether frames decode at all is the decode loop's business, and it
  // reports for itself.
  const p = player();
  p.videoSink = { getCanvas: async () => null };
  await assert.doesNotReject(p.seek(0));
});
