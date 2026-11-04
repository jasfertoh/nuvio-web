/**
 * Plays the media proxy's transcode through Media Source.
 *
 * A transcode is an open-ended fragmented MP4 with no Content-Length, so the
 * element sees nothing as seekable and every seek used to restart the
 * transcode from scratch - seconds of waiting even to step back ten seconds
 * into what had just played. Fed through Media Source instead, everything
 * that has arrived stays in the SourceBuffer: a seek inside it is instant,
 * and only a seek outside it asks the proxy for a new stream, which is
 * appended to the same buffer. The proxy keeps the film's own timestamps
 * (copyts), so pieces from different starts sit where they belong.
 *
 * Anything this cannot handle - a relay (the proxy only marks transcodes), a
 * codec Media Source refuses, no Media Source at all - falls back to setting
 * the element's src, which is what happened before.
 */

/** How far ahead of the playhead to read before waiting for it. */
const READ_AHEAD_SECONDS = 90;
/** What to keep behind the playhead when the buffer is full. */
const KEEP_BEHIND_SECONDS = 30;

type Box = { type: string; start: number; end: number; body: number };

function boxes(data: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header) break;
    found.push({ type, start: at, end: at + size, body: at + header });
    at += size;
  }
  return found;
}

/** Bytes needed before the init segment (ftyp + moov) is complete, or its length once it is. */
export function initSegmentLength(data: Uint8Array): number | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 8 <= data.length) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    if (size === 1) {
      if (at + 16 > data.length) return null;
      size = Number(view.getBigUint64(at + 8));
    }
    if (size < 8) return null;
    if (at + size > data.length) return null;
    at += size;
    if (type === "moov") return at;
  }
  return null;
}

const hex = (value: number) => value.toString(16).padStart(2, "0");

/**
 * The codecs parameter for an init segment, read from its sample entries:
 * `avc1.64001f`, `hvc1.1.6.L120.90`, `mp4a.40.2`. Null if a track is not one
 * this knows how to name - the caller falls back rather than guessing.
 */
export function codecsFromInit(data: Uint8Array): string | null {
  const moov = boxes(data, 0, data.length).find((box) => box.type === "moov");
  if (!moov) return null;
  const codecs: string[] = [];
  const descend = (box: Box, path: string[]): Box | undefined => {
    let current: Box | undefined = box;
    for (const type of path) {
      current = current && boxes(data, current.body, current.end).find((child) => child.type === type);
    }
    return current;
  };
  for (const trak of boxes(data, moov.body, moov.end).filter((box) => box.type === "trak")) {
    // Only picture and sound reach the SourceBuffer. Matroska chapters arrive
    // as a QuickTime text track, and other timed text is the player's own.
    const hdlr = descend(trak, ["mdia", "hdlr"]);
    const handler = hdlr
      ? String.fromCharCode(...data.subarray(hdlr.body + 8, hdlr.body + 12))
      : "";
    if (handler !== "vide" && handler !== "soun") continue;
    const stsd = descend(trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) continue;
    // stsd: version/flags (4) + entry count (4), then the sample entries.
    const entry = boxes(data, stsd.body + 8, stsd.end)[0];
    if (!entry) continue;
    if (entry.type === "avc1" || entry.type === "avc3") {
      // VisualSampleEntry is 78 bytes before its child boxes.
      const avcC = boxes(data, entry.body + 78, entry.end).find((box) => box.type === "avcC");
      if (!avcC) return null;
      const b = avcC.body;
      codecs.push(`${entry.type}.${hex(data[b + 1])}${hex(data[b + 2])}${hex(data[b + 3])}`);
    } else if (entry.type === "hvc1" || entry.type === "hev1") {
      const hvcC = boxes(data, entry.body + 78, entry.end).find((box) => box.type === "hvcC");
      if (!hvcC) return null;
      const b = hvcC.body;
      const profileSpace = data[b + 1] >> 6;
      const tier = (data[b + 1] >> 5) & 1;
      const profile = data[b + 1] & 0x1f;
      let compat = 0;
      for (let i = 0; i < 4; i += 1) compat = (compat << 8) | data[b + 2 + i];
      // The compatibility flags are written bit-reversed in the codec string.
      let reversed = 0;
      for (let i = 0; i < 32; i += 1) reversed = (reversed << 1) | ((compat >>> i) & 1);
      const level = data[b + 12];
      const constraints: string[] = [];
      for (let i = 0; i < 6; i += 1) constraints.push(data[b + 6 + i].toString(16).toUpperCase());
      while (constraints.length > 1 && constraints[constraints.length - 1] === "0") constraints.pop();
      const space = ["", "A", "B", "C"][profileSpace];
      codecs.push(
        `${entry.type}.${space}${profile}.${(reversed >>> 0).toString(16).toUpperCase()}.${tier ? "H" : "L"}${level}.${constraints.join(".")}`,
      );
    } else if (entry.type === "mp4a") {
      // The proxy always encodes AAC-LC for the browser.
      codecs.push("mp4a.40.2");
    } else {
      return null;
    }
  }
  return codecs.length ? codecs.join(",") : null;
}

/**
 * Where this stream starts in the film, in seconds.
 *
 * The proxy keeps the film's timestamps (-copyts), but the MP4 muxer records a
 * nonzero start as an empty edit at the head of each track's edit list and
 * numbers the fragments from zero. A <video src> applies the edit list; Media
 * Source does not, so the offset has to be given to the SourceBuffer instead.
 * Read from the video track (audio starts within a millisecond of it, since
 * the proxy seeks both to the same keyframe). 0 for a stream from the start.
 */
export function startOffsetFromInit(data: Uint8Array): number {
  const moov = boxes(data, 0, data.length).find((box) => box.type === "moov");
  if (!moov) return 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const children = boxes(data, moov.body, moov.end);
  const mvhd = children.find((box) => box.type === "mvhd");
  if (!mvhd) return 0;
  const timescale = view.getUint32(mvhd.body + (data[mvhd.body] === 1 ? 20 : 12));
  if (!timescale) return 0;
  for (const trak of children.filter((box) => box.type === "trak")) {
    const mdia = boxes(data, trak.body, trak.end).find((box) => box.type === "mdia");
    const hdlr = mdia && boxes(data, mdia.body, mdia.end).find((box) => box.type === "hdlr");
    if (!hdlr || String.fromCharCode(...data.subarray(hdlr.body + 8, hdlr.body + 12)) !== "vide") continue;
    const edts = boxes(data, trak.body, trak.end).find((box) => box.type === "edts");
    const elst = edts && boxes(data, edts.body, edts.end).find((box) => box.type === "elst");
    if (!elst) return 0;
    const version = data[elst.body];
    if (!view.getUint32(elst.body + 4)) return 0;
    const at = elst.body + 8;
    const duration = version === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
    const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
    // An empty edit (media time -1) is the gap before the first sample.
    return mediaTime === -1 ? duration / timescale : 0;
  }
  return 0;
}

function bufferedRangeAt(buffered: TimeRanges, time: number): [number, number] | null {
  for (let index = 0; index < buffered.length; index += 1) {
    // A little slack at the start: a seek lands on the keyframe before the
    // target, so a range can begin a fraction after a point it covers.
    if (buffered.start(index) - 0.25 <= time && time < buffered.end(index) - 0.5)
      return [buffered.start(index), buffered.end(index)];
  }
  return null;
}

export class ProxyMse {
  static supported(): boolean {
    return typeof window !== "undefined" && "MediaSource" in window;
  }

  private source = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private objectUrl = "";
  private abort: AbortController | null = null;
  private disposed = false;
  private generation = 0;
  private duration = 0;
  private fellBack = false;

  private element: HTMLVideoElement;
  private urlAt: (seconds: number) => string;
  private handlers: {
    /** This stream cannot go through Media Source; play it the old way. */
    onFallback(): void;
    /** Data for the start point has arrived. */
    onReady?(): void;
  };

  constructor(
    element: HTMLVideoElement,
    urlAt: (seconds: number) => string,
    handlers: ProxyMse["handlers"],
  ) {
    this.element = element;
    this.urlAt = urlAt;
    this.handlers = handlers;
    this.objectUrl = URL.createObjectURL(this.source);
    element.src = this.objectUrl;
  }

  /** Whether a seek to this point can be answered from what has arrived. */
  holds(seconds: number): boolean {
    return !!this.buffer && !!bufferedRangeAt(this.buffer.buffered, seconds);
  }

  setDuration(seconds: number) {
    this.duration = seconds;
    this.applyDuration();
  }

  /** Start (or move) the stream at this point. Instant when already held. */
  seek(seconds: number) {
    if (this.holds(seconds)) {
      this.element.currentTime = seconds;
      return;
    }
    void this.load(seconds);
  }

  start(seconds: number) {
    void this.load(seconds);
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.abort?.abort();
    URL.revokeObjectURL(this.objectUrl);
  }

  private applyDuration() {
    if (!this.duration || this.source.readyState !== "open" || this.buffer?.updating) return;
    try {
      this.source.duration = this.duration;
    } catch {
      // Lower than what is buffered, or mid-update: the next append retries.
    }
  }

  private async opened() {
    if (this.source.readyState === "open") return;
    await new Promise<void>((resolve) =>
      this.source.addEventListener("sourceopen", () => resolve(), { once: true }),
    );
  }

  private async idle() {
    const buffer = this.buffer;
    if (!buffer?.updating) return;
    await new Promise<void>((resolve) => buffer.addEventListener("updateend", () => resolve(), { once: true }));
  }

  private fallback(reason: string) {
    if (this.fellBack || this.disposed) return;
    // One line, so a stream that plays the old way says why.
    console.info(`[proxy-mse] falling back to the element: ${reason}`);
    this.fellBack = true;
    this.dispose();
    this.handlers.onFallback();
  }

  private async append(chunk: Uint8Array, generation: number): Promise<boolean> {
    const buffer = this.buffer!;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.idle();
      if (generation !== this.generation) return false;
      try {
        buffer.appendBuffer(chunk as Uint8Array<ArrayBuffer>);
        await this.idle();
        this.applyDuration();
        return true;
      } catch (error) {
        if ((error as DOMException)?.name !== "QuotaExceededError") throw error;
        // Full: let go of what is well behind the playhead and try again.
        const behind = this.element.currentTime - KEEP_BEHIND_SECONDS;
        if (behind <= 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        else {
          buffer.remove(0, behind);
          await this.idle();
        }
      }
    }
    return false;
  }

  /** Seconds buffered ahead of the playhead in the range it is in. */
  private ahead(): number {
    if (!this.buffer) return 0;
    const range = bufferedRangeAt(this.buffer.buffered, this.element.currentTime);
    return range ? range[1] - this.element.currentTime : 0;
  }

  /** `move` false continues the buffer without touching the playhead. */
  private async load(seconds: number, move = true) {
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    try {
      await this.opened();
      if (generation !== this.generation) return;
      await this.idle();
      // A stream cut off mid-fragment leaves the parser holding half of it.
      if (this.buffer && this.source.readyState === "open") this.buffer.abort();
      if (move) this.element.currentTime = seconds;
      const response = await fetch(this.urlAt(seconds), { signal: abort.signal });
      if (generation !== this.generation) return;
      if (!response.ok || !response.body || response.headers.get("X-Nuvio-Transcode") !== "1") {
        // A relay: ordinary ranges the element can seek itself.
        abort.abort();
        this.fallback(`response ${response.status}, transcode header ${response.headers.get("X-Nuvio-Transcode")}`);
        return;
      }
      const reader = response.body.getReader();
      let pending = new Uint8Array(0);
      let initDone = false;
      let ready = !move;
      for (;;) {
        // Read ahead only so far: the proxy transcodes as fast as it is read.
        while (this.ahead() > READ_AHEAD_SECONDS && generation === this.generation) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (generation !== this.generation) return;
        const { done, value } = await reader.read();
        if (generation !== this.generation) return;
        if (done) break;
        if (!initDone) {
          const joined = new Uint8Array(pending.length + value.length);
          joined.set(pending);
          joined.set(value, pending.length);
          pending = joined;
          const length = initSegmentLength(pending);
          if (length === null) continue;
          initDone = true;
          if (!this.buffer) {
            const codecs = codecsFromInit(pending.subarray(0, length));
            const type = codecs && `video/mp4; codecs="${codecs}"`;
            if (!type || !MediaSource.isTypeSupported(type)) {
              abort.abort();
              this.fallback(`codecs ${codecs ?? "unreadable"} not supported`);
              return;
            }
            this.buffer = this.source.addSourceBuffer(type);
          }
          // Each stream carries its own start in its header; place it there.
          await this.idle();
          if (generation !== this.generation) return;
          this.buffer.timestampOffset = startOffsetFromInit(pending.subarray(0, length));
          if (!(await this.append(pending, generation))) return;
          pending = new Uint8Array(0);
        } else if (!(await this.append(value, generation))) return;
        if (!ready && this.holds(seconds)) {
          ready = true;
          // A keyframe seek starts a little early; begin where it was asked.
          if (Math.abs(this.element.currentTime - seconds) > 0.5) this.element.currentTime = seconds;
          this.handlers.onReady?.();
        }
      }
      // The end of the film, or the proxy giving up part-way.
      const reached = this.buffer ? bufferedRangeAt(this.buffer.buffered, this.element.currentTime) : null;
      const end = reached?.[1] ?? 0;
      if (this.duration && end >= this.duration - 1) {
        await this.idle();
        if (generation === this.generation && this.source.readyState === "open") this.source.endOfStream();
      } else if (end > seconds + 1) {
        // Cut short: carry on from where it stopped.
        void this.load(end - 0.5, false);
      }
    } catch (error) {
      if (abort.signal.aborted || generation !== this.generation) return;
      // An append the buffer refused (a decode problem) or a network failure:
      // the element's own path has the error handling and the re-encode retry.
      this.fallback(String((error as Error)?.message ?? error));
    }
  }
}
