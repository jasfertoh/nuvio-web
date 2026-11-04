/**
 * What the media proxy knows about a source: its audio tracks, its embedded
 * subtitles, and how long it actually is.
 *
 * The proxy reads all of this out of the transcode it is already running, so
 * asking costs the source nothing. It matters most for a transcoded stream,
 * where the element's own `duration` is whatever has been produced so far and
 * grows as playback continues - useless for a seek bar.
 */

import { mediaProxyBase } from "./mediaProxy.ts";
import {
  ensureProxySignature,
  proxySignatureQuery,
} from "./proxySignature.ts";

export type ProxyAudioTrack = {
  ordinal: number;
  codec: string;
  language: string;
  title: string;
  channels?: number;
  default?: boolean;
};

export type ProxySubtitleTrack = {
  ordinal: number;
  language: string;
  title: string;
  textBased: boolean;
  forced?: boolean;
  ready?: boolean;
};

export type ProxyTracks = {
  durationSeconds: number;
  /** The video's frame rate, or 0 where the proxy could not say. */
  fps: number;
  audio: ProxyAudioTrack[];
  subtitles: ProxySubtitleTrack[];
};

function endpoint(path: string, sourceUrl: string, extra = ""): string {
  const base = mediaProxyBase();
  if (!base) return "";
  return (
    `${base}/media-transcode/${path}?url=${encodeURIComponent(sourceUrl)}${extra}` +
    proxySignatureQuery(sourceUrl)
  );
}

/**
 * How far an addon subtitle is out against this file's own audio, measured by
 * the proxy from three short stretches of it. `applied` is the proxy's verdict:
 * the match beat shuffled copies of the subtitle and is worth correcting.
 */
export async function fetchSubtitleOffset(
  sourceUrl: string,
  subtitleUrl: string,
  audioOrdinal: number,
  signal?: AbortSignal,
): Promise<{ offsetMs: number; applied: boolean } | null> {
  await ensureProxySignature(sourceUrl);
  const target = endpoint(
    "subtitle-offset",
    sourceUrl,
    `&sub=${encodeURIComponent(subtitleUrl)}&audio=${Math.max(0, audioOrdinal)}`,
  );
  if (!target) return null;
  const response = await fetch(target, { signal });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as
    | { offsetMs?: number; applied?: boolean }
    | null;
  if (!data || !Number.isFinite(data.offsetMs)) return null;
  return { offsetMs: Number(data.offsetMs), applied: data.applied === true };
}

/** The proxy's thumbnails come in 10-second steps; asking within one reuses it. */
export const THUMBNAIL_STEP_SECONDS = 10;

/** A small still of the source at this point, for the seek bar. "" without a proxy. */
export function proxyThumbnailUrl(sourceUrl: string, seconds: number): string {
  const step = Math.round(seconds / THUMBNAIL_STEP_SECONDS) * THUMBNAIL_STEP_SECONDS;
  return endpoint("thumbnail", sourceUrl, `&t=${step}`);
}

export async function fetchProxyTracks(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<ProxyTracks | null> {
  // Minted here as well as at the player, because whichever asks first pays
  // for it and the rest of the calls about this source are then free.
  await ensureProxySignature(sourceUrl);
  const target = endpoint("tracks", sourceUrl);
  if (!target) return null;
  const response = await fetch(target, { signal });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as
    | { durationSeconds?: number; tracks?: ProxyAudioTrack[]; subtitles?: ProxySubtitleTrack[]; video?: { fps?: number } | null }
    | null;
  if (!data) return null;
  return {
    durationSeconds: Number(data.durationSeconds) || 0,
    fps: Number(data.video?.fps) || 0,
    audio: Array.isArray(data.tracks) ? data.tracks : [],
    subtitles: Array.isArray(data.subtitles) ? data.subtitles : [],
  };
}

/**
 * Embedded subtitles have to be demuxed out of the file before they can be
 * served, which is one pass over the source - so it is started explicitly and
 * the result polled, rather than blocking a request for as long as it takes.
 * Every text track is extracted in that one pass and kept.
 */
export async function fetchProxySubtitles(
  sourceUrl: string,
  { extract = false, signal }: { extract?: boolean; signal?: AbortSignal } = {},
): Promise<ProxySubtitleTrack[]> {
  await ensureProxySignature(sourceUrl);
  const target = endpoint("subtitles", sourceUrl, extract ? "&extract=1" : "");
  if (!target) return [];
  const response = await fetch(target, { signal });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as
    | { subtitles?: ProxySubtitleTrack[] }
    | null;
  return Array.isArray(data?.subtitles) ? data.subtitles : [];
}

/** One extracted track as WebVTT, timed against the film. */
export function proxySubtitleUrl(sourceUrl: string, ordinal: number): string {
  return endpoint("subtitle", sourceUrl, `&index=${ordinal}`);
}

/** A readable name for a track, falling back through what the file provides. */
export function trackLabel(
  track: { language?: string; title?: string; channels?: number },
  index: number,
  kind: string,
): string {
  const language = String(track.language || "").trim();
  const title = String(track.title || "").trim();
  const channels = Number(track.channels) || 0;
  const parts = [
    language && language !== "und" ? language.toUpperCase() : "",
    title,
    channels >= 6 ? `${channels}.0` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${kind} ${index + 1}`;
}

/**
 * An addon's subtitle file, fetched through the proxy.
 *
 * Two reasons it cannot be used directly: a <track> renders WebVTT and addons
 * hand out SubRip, and the file comes from whichever host the addon chose,
 * which need not allow cross-origin reads. The proxy converts and re-serves it.
 */
export function subtitleRelayUrl(fileUrl: string): string {
  const base = mediaProxyBase();
  if (!base || !fileUrl) return "";
  return (
    `${base}/media-transcode/subtitle-relay?url=${encodeURIComponent(fileUrl)}` +
    proxySignatureQuery(fileUrl)
  );
}

/**
 * The subtitle file is a different URL to the film, so it needs its own
 * signature. Awaited before the track element is built, since a <track> src
 * cannot be filled in later.
 */
export async function prepareSubtitleRelay(fileUrl: string): Promise<string> {
  if (!fileUrl) return "";
  await ensureProxySignature(fileUrl);
  return subtitleRelayUrl(fileUrl);
}

/**
 * A readable language name: "Russian" rather than "rus". Falls back to the
 * code itself, which is still better than nothing when Intl has no entry.
 */
export function languageName(code: string): string {
  const raw = String(code || "").trim();
  if (!raw || raw.toLowerCase() === "und") return "Unknown";
  try {
    const display = new Intl.DisplayNames([navigator.language || "en"], {
      type: "language",
    });
    // Intl wants a 2-letter code where one exists; a 3-letter one is passed
    // through and returned unchanged if it is not recognised.
    return display.of(raw) ?? raw.toUpperCase();
  } catch {
    return raw.toUpperCase();
  }
}

/** "AC3 · 5.1" - what distinguishes two tracks of the same language. */
export function audioDetail(track: ProxyAudioTrack): string {
  const channels =
    track.channels === 6 ? "5.1" : track.channels === 8 ? "7.1" : track.channels === 2 ? "Stereo" : "";
  return [track.codec?.toUpperCase(), channels].filter(Boolean).join(" · ");
}
