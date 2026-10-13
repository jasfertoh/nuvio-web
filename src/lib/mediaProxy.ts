/**
 * Routes playback through a self-hosted media proxy.
 *
 * The proxy decides per source whether the browser can already play it. If it
 * can, the bytes are relayed untouched and seeking stays native; if the audio
 * is a codec no browser licenses, the video is copied and only the audio is
 * re-encoded. Either way what arrives is an ordinary file the element plays,
 * which is why this bypasses the Matroska decode engine entirely rather than
 * feeding it.
 *
 * It exists for the cases the in-browser engine cannot reach: AC-3 outside
 * Matroska, DTS and TrueHD anywhere (the WASM decoder covers AC-3/E-AC-3
 * only), and devices with no WebCodecs at all. It also moves the decode off
 * the phone, which matters more than it sounds on a long film.
 */

import { proxySignatureQuery } from "./proxySignature.ts";

const BASE_KEY = "nuvio-web-media-proxy";
/** Stored under BASE_KEY to turn the proxy off despite the build default. */
export const MEDIA_PROXY_OFF = "off";

/** Codecs the proxy may leave alone, being ones browsers actually decode. */
const NATIVE_AUDIO_CODECS = ["aac", "mp3", "opus", "flac", "vorbis"];

/**
 * Where the proxy lives, from the build.
 *
 * Its own setting first, falling back to the backend's URL because the two are
 * usually served by one stack. They are not the same thing though: pointing
 * the client at a different account backend - the official one, say - would
 * otherwise send playback at a host that has no proxy on it and break every
 * stream. Set NUVIO_MEDIA_PROXY_URL to keep them apart.
 *
 * Written as the bare `import.meta.env.X` that Vite substitutes at build time -
 * the optional form would not match its define key - hence the guard for Node,
 * where `import.meta.env` does not exist at all.
 */
function buildDefaultBase(): string {
  try {
    const explicit = (import.meta.env.VITE_NUVIO_MEDIA_PROXY_URL ?? "").trim();
    if (explicit) return explicit.replace(/\/+$/, "");
  } catch {
    // No build environment here; fall through to the backend's URL.
  }
  try {
    return (import.meta.env.VITE_NUVIO_SUPABASE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * The proxy's origin, e.g. `https://backend.example.com`. Defaults to the
 * build's own backend; a stored value overrides it, and the value "off" turns
 * proxying off on this device. Empty means no proxying.
 */
export function mediaProxyBase(): string {
  let stored = "";
  try {
    stored = (localStorage.getItem(BASE_KEY) ?? "").trim();
  } catch {
    // A browser refusing storage just falls through to the build default.
  }
  if (stored === MEDIA_PROXY_OFF) return "";
  if (stored) return stored.replace(/\/+$/, "");
  return buildDefaultBase();
}

/**
 * Pass MEDIA_PROXY_OFF to disable, or an empty string to go back to whatever
 * the build defaults to.
 */
export function setMediaProxyBase(base: string): void {
  const clean = base.trim().replace(/\/+$/, "");
  try {
    if (clean) localStorage.setItem(BASE_KEY, clean);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    // A browser refusing storage just means the setting does not persist.
  }
}

/**
 * Only plain HTTP(S) media is worth proxying. HLS is already segmented and
 * seekable, and a magnet or `externalUrl` is not something the proxy reads.
 */
function isProxyableSource(url: string): boolean {
  if (!url || /\.m3u8(?:$|\?)/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The proxy is told what this browser can decode rather than guessing. AC-3
 * and E-AC-3 are deliberately absent even though the Matroska engine can
 * decode them: this URL is played by the element, which cannot, so naming
 * them here would have the proxy pass through audio that then plays silently.
 */
function playbackCapabilities(): string[] {
  const caps = [...NATIVE_AUDIO_CODECS];
  const probe = document.createElement("video");
  if (probe.canPlayType('audio/mp4; codecs="ac-3"') === "probably") {
    caps.push("ac3");
  }
  if (probe.canPlayType('audio/mp4; codecs="ec-3"') === "probably") {
    caps.push("eac3");
  }
  return caps;
}

/**
 * The URL to hand the video element, or the original when proxying is off or
 * does not apply. Already-proxied URLs are returned untouched so this stays
 * safe to call more than once on the same source.
 */
export type ProxyPlaybackOptions = {
  /** Which audio track the proxy should carry, by ordinal. */
  audioOrdinal?: number | null;
  /** Where the stream should begin, for sources the element cannot seek. */
  startSeconds?: number | null;
  /**
   * Insist the picture is re-encoded rather than copied.
   *
   * For a stream whose codec is decodable in principle but whose bitstream
   * this decoder refuses - a Blu-ray remux is h264 like anything else, and
   * VideoToolbox still rejects one partway through. The proxy cannot know
   * that from the codec name; the browser finds out by failing.
   */
  reencode?: boolean;
};

export function proxiedPlaybackUrl(
  url: string,
  { audioOrdinal, startSeconds, reencode }: ProxyPlaybackOptions = {},
): string {
  const base = mediaProxyBase();
  if (!base || !isProxyableSource(url) || url.includes("/media-transcode/")) {
    return url;
  }
  // Switching audio, or starting part-way in, is the same URL with another
  // parameter - so both belong in the URL rather than in player state.
  const audio = Number(audioOrdinal);
  const start = Number(startSeconds);
  return (
    `${base}/media-transcode/play?url=${encodeURIComponent(url)}` +
    (Number.isFinite(audio) && audio > 0 ? `&audio=${audio}` : "") +
    (Number.isFinite(start) && start > 0 ? `&start=${start}` : "") +
    // Ask for the film's own timestamps. A transcode is not seekable, so
    // seeking reloads it from the new point - and without this the element's
    // clock would restart at zero each time, leaving the position, the seek
    // bar and every subtitle cue to be corrected by hand. This costs the
    // proxy's read pacing on transcodes; a pass-through ignores it entirely.
    "&copyts=1" +
    (reencode ? "&reencode=1" : "") +
    `&caps=${playbackCapabilities().join(",")}` +
    // Empty until one has been minted for this source, which is what the
    // proxy's log-only mode is for: an unsigned request is still served, and
    // still recorded.
    proxySignatureQuery(url) +
    // A live transcode must never come from a cache, and saying so is not
    // enough. The response carries no-store, CDN-Cache-Control: no-store,
    // Cloudflare-CDN-Cache-Control: no-store and Vary: *, and Cloudflare
    // stores it anyway - a zone Cache Rule with an explicit edge TTL outranks
    // every one of those. Measured: two identical requests, the second a HIT
    // with a stored body.
    //
    // What it stores is worse than wasteful. A transcode aborted partway - a
    // track change, a seek, a viewer leaving - is kept as though it were the
    // whole thing, and replayed to the next request as a stream that plays
    // for a few seconds and then ends, which a browser reports as a format it
    // cannot play. A distinct URL per request cannot be answered from that.
    //
    // This belongs in a Cache Rule that bypasses /media-transcode/, and
    // should be removed once there is one.
    `&nocache=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  );
}
