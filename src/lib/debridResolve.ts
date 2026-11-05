/**
 * Turns an addon's torrent result into a playable link, via the media proxy.
 *
 * Addons mostly return torrents rather than URLs: a stream carries an
 * `infoHash` and no `url`, which is why those rows are unplayable here. A
 * debrid service turns one into a direct HTTPS link, but Torbox sends no
 * cross-origin headers, so a browser cannot call it at all - see the note in
 * App.tsx. The proxy makes that call instead, where CORS does not apply.
 *
 * The API key is the viewer's own, already synced to this device with the rest
 * of the account, and is sent to their own proxy in a POST body rather than a
 * query string.
 */

import { mediaProxyBase } from "./mediaProxy.ts";
import { fetchProxyTracks } from "./proxyTracks.ts";
import { partitionHashes, rememberHashes } from "./cachedHashes.ts";
import { providerCredential } from "./providerCredentials.ts";
import type { ProviderCredentialRow } from "./providerCredentials.ts";
import type { Stream } from "../types";

/** The account row the desktop and TV clients sync a Torbox key into. */
const TORBOX_PROVIDER = "debrid:torbox";

/**
 * Public trackers, so a bare hash still announces. Debrid services look a
 * torrent up by hash and ignore these, but a magnet without any is rejected
 * by some of them outright.
 */
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

/**
 * How the provider is named in a source label. TorBox is the only resolver
 * here, and the TV client abbreviates it the same way.
 */
export const DEBRID_SHORT_NAME = "TB";

export function torboxApiKey(rows: ProviderCredentialRow[]): string {
  return providerCredential(rows, TORBOX_PROVIDER, "api_key");
}

export function magnetFromStream(stream: Stream): string {
  const hash = String(stream.infoHash || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return "";
  const trackers = TRACKERS.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("");
  return `magnet:?xt=urn:btih:${hash}${trackers}`;
}

/**
 * True when this row is a torrent that only a debrid service can turn into
 * something playable - no direct URL, but a hash to look up.
 */
export function needsDebridResolve(stream: Stream): boolean {
  return !stream.url && Boolean(magnetFromStream(stream));
}

/** Whether resolving is possible at all: a proxy to ask, and a key to use. */
export function canResolveDebrid(rows: ProviderCredentialRow[]): boolean {
  return Boolean(mediaProxyBase() && torboxApiKey(rows));
}

export class DebridResolveError extends Error {}

const MESSAGES: Record<string, string> = {
  not_cached:
    "This torrent is not cached on Torbox, so there is nothing to stream yet. Pick another source.",
  unauthorized: "Torbox rejected the API key. Check it in Settings.",
  no_playable_file: "Torbox found no video file in this torrent.",
};

/**
 * Resolves one torrent stream to a direct URL. Throws with a message worth
 * showing; an uncached torrent is an ordinary outcome, not a fault.
 */
/**
 * Links resolved in this tab, so a click on a source the sheet already
 * prepared - or is preparing - plays without another round trip. Kept well
 * under the proxy's own 20-minute cache, as a debrid link expires.
 */
const RESOLVED_MS = 10 * 60 * 1000;
const resolved = new Map<string, { at: number; url: Promise<string> }>();

export function resolveDebridStream(
  stream: Stream,
  rows: ProviderCredentialRow[],
  where: { season?: number; episode?: number } = {},
): Promise<string> {
  const key = [torboxApiKey(rows), magnetFromStream(stream), stream.behaviorHints?.filename ?? "", where.season, where.episode].join("|");
  const entry = resolved.get(key);
  if (entry && Date.now() - entry.at < RESOLVED_MS) return entry.url;
  const url = requestResolve(stream, rows, where).then((link) => {
    // Sign it and have the proxy read the file now, while the player is still
    // mounting: both are otherwise paid after the click, one after the other.
    void fetchProxyTracks(link).catch(() => {});
    return link;
  });
  url.catch(() => {
    if (resolved.get(key)?.url === url) resolved.delete(key);
  });
  resolved.set(key, { at: Date.now(), url });
  return url;
}

async function requestResolve(
  stream: Stream,
  rows: ProviderCredentialRow[],
  { season, episode }: { season?: number; episode?: number },
): Promise<string> {
  const base = mediaProxyBase();
  const apiKey = torboxApiKey(rows);
  const magnet = magnetFromStream(stream);
  if (!base || !apiKey || !magnet) {
    throw new DebridResolveError("This source needs a Torbox key and a media proxy.");
  }
  let response: Response;
  try {
    response = await fetch(`${base}/media-transcode/debrid/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "torbox",
        apiKey,
        magnet,
        filename: stream.behaviorHints?.filename ?? "",
        season,
        episode,
      }),
    });
  } catch {
    throw new DebridResolveError("Could not reach the media proxy.");
  }
  const data = (await response.json().catch(() => null)) as
    | { url?: string; error?: string }
    | null;
  if (!response.ok || !data?.url) {
    const code = data?.error ?? "resolve_failed";
    throw new DebridResolveError(MESSAGES[code] ?? "Could not resolve this source.");
  }
  return data.url;
}

/**
 * Which of these torrents Torbox already holds, keyed by lowercase hash.
 *
 * One request for the whole list. Resolving each row up front would be a
 * Torbox call per source - dozens on a busy title - so the panel asks only
 * what will play, and resolves the one that gets clicked.
 *
 * A failure here is not fatal: the caller keeps showing every source, since
 * "we could not check" is not the same as "not available".
 */
export async function checkDebridCached(
  streams: Stream[],
  rows: ProviderCredentialRow[],
): Promise<Record<string, boolean>> {
  const base = mediaProxyBase();
  const apiKey = torboxApiKey(rows);
  const hashes = [
    ...new Set(
      streams
        .filter(needsDebridResolve)
        .map((stream) => String(stream.infoHash || "").toLowerCase()),
    ),
  ];
  if (!base || !apiKey || !hashes.length) return {};
  // Asked about once. The panel holds its list back until this answers, so a
  // hash already known is a wait not paid again.
  const { known, missing } = partitionHashes(hashes);
  if (!missing.length) return known;
  const response = await fetch(`${base}/media-transcode/debrid/cached`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, hashes: missing }),
  });
  const data = (await response.json().catch(() => null)) as
    | { cached?: Record<string, boolean> }
    | null;
  if (!response.ok || !data?.cached) {
    throw new DebridResolveError("Could not check what Torbox has cached.");
  }
  rememberHashes(data.cached);
  return { ...known, ...data.cached };
}

/**
 * A budget for background resolving, taken from the TV client's
 * DirectDebridStreamPreparer.
 *
 * Preparing links spends a Torbox call per source whether or not anything is
 * played, and opening panel after panel would spend them steadily. The TV
 * client caps this at six a minute and thirty an hour; the same numbers are
 * used here so the two behave alike against the same account. It lives at
 * module scope deliberately - a per-component allowance would reset every time
 * a title was opened, which is exactly when the spending happens.
 *
 * A click the viewer actually made never consults this. Only background work
 * is rationed.
 */
const MAX_PREPARES_PER_MINUTE = 6;
const MAX_PREPARES_PER_HOUR = 30;
const minuteStarts: number[] = [];
const hourStarts: number[] = [];

function prune(list: number[], cutoff: number): void {
  while (list.length && list[0] < cutoff) list.shift();
}

/** True when a background resolve may proceed, recording it if so. */
export function consumePrepareBudget(): boolean {
  const now = Date.now();
  prune(minuteStarts, now - 60_000);
  prune(hourStarts, now - 3_600_000);
  if (
    minuteStarts.length >= MAX_PREPARES_PER_MINUTE ||
    hourStarts.length >= MAX_PREPARES_PER_HOUR
  ) {
    return false;
  }
  minuteStarts.push(now);
  hourStarts.push(now);
  return true;
}
