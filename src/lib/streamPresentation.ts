/**
 * Turning an addon's raw stream text into something readable.
 *
 * Torrent addons put the release name on the first line and everything else -
 * seeders, size, tracker, the original filename - on the lines below it, as
 * free text with emoji in it. Printed whole, that is what makes a source list
 * look like a torrent index.
 *
 * The parsing here follows the TV client
 * (js/ui/screens/stream/streamScreen.js) so the two agree on quality and size.
 * It departs from it in two places, deliberately:
 *
 *  - The TV heads a card with the first line of `name`, which for Torrentio is
 *    the addon's own name, and then prints the remaining lines verbatim
 *    underneath - so the torrent text is still on screen there. Here the
 *    metadata is read out into fields instead and the raw lines are dropped.
 *  - `title` is preferred over `name` for the heading. The addon is already
 *    named beside the row, and `name` is usually just that name again with the
 *    quality after it, which would leave the release itself nowhere.
 */

import type { Stream } from "../types";

const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i;
const KILO = 1024;
const UNIT_MULTIPLIERS: Record<string, number> = {
  TB: KILO ** 4,
  GB: KILO ** 3,
  MB: KILO ** 2,
  KB: KILO,
};

/** Seeder counts arrive as "👤 42", "Seeders: 42" or plain "42 seeders". */
const SEEDER_PATTERNS = [
  /👤\s*(\d+)/,
  /(\d+)\s*seed(?:er)?s?\b/i,
  /seed(?:er)?s?\s*[:=]\s*(\d+)/i,
];

function streamText(stream: Stream): string {
  return [stream.name, stream.title, stream.description]
    .map((value) => String(value ?? ""))
    .join("\n");
}

/**
 * The name to show: the first non-empty line of whichever field carries one.
 * Everything after it is metadata, not title.
 */
export function streamHeadline(stream: Stream): string {
  const primary = [stream.title, stream.name, stream.description].find((value) =>
    String(value ?? "").trim(),
  );
  const firstLine = String(primary ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || stream.addonName || "Unknown source";
}

export function streamQuality(stream: Stream): string | null {
  const value = streamText(stream).toLowerCase();
  if (value.includes("2160") || value.includes("4k")) return "4K";
  if (value.includes("1440")) return "1440p";
  if (value.includes("1080")) return "1080p";
  if (value.includes("720")) return "720p";
  if (value.includes("480")) return "480p";
  return null;
}

export function sizeBytesFromText(text: string): number | null {
  const match = String(text ?? "").match(SIZE_PATTERN);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, "."));
  const multiplier = UNIT_MULTIPLIERS[match[2].toUpperCase()];
  if (!Number.isFinite(amount) || !multiplier) return null;
  const bytes = Math.trunc(amount * multiplier);
  return bytes > 0 ? bytes : null;
}

/**
 * A size the addon stated properly, or failing that one dug out of its text -
 * Torrentio and its like only ever put it in the title.
 */
export function streamSizeBytes(stream: Stream): number | null {
  const declared = Number(stream.behaviorHints?.videoSize);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return sizeBytesFromText(streamText(stream));
}

export function streamSeeders(stream: Stream): number | null {
  const text = streamText(stream);
  for (const pattern of SEEDER_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * Words worth keeping out of the noise: how it was encoded and what it was
 * ripped from, which is what people actually choose between once quality and
 * size are known.
 */
const TAGS = [
  "HDR10+", "HDR10", "HDR", "DOLBY VISION", "DV",
  "REMUX", "BLURAY", "BLU-RAY", "WEB-DL", "WEBDL", "WEBRIP", "BDRIP", "HDTV", "CAM",
  "X265", "H265", "HEVC", "X264", "H264", "AV1",
  "ATMOS", "TRUEHD", "DTS-HD", "DTS", "DDP5.1", "DD5.1", "EAC3", "AC3", "AAC", "FLAC",
  "10BIT", "IMAX", "EXTENDED", "PROPER", "REPACK",
];

export function streamTags(stream: Stream): string[] {
  const haystack = streamText(stream).toUpperCase();
  const found: string[] = [];
  for (const tag of TAGS) {
    if (!haystack.includes(tag)) continue;
    // "DTS" is inside "DTS-HD" and "HDR" inside "HDR10": keep the longer claim
    // only, or a row ends up asserting both.
    if (found.some((kept) => kept.includes(tag))) continue;
    found.push(tag);
  }
  return found.slice(0, 4);
}

const QUALITY_RANK: Record<string, number> = {
  "4K": 5,
  "1440p": 4,
  "1080p": 3,
  "720p": 2,
  "480p": 1,
};

/** Best first within one addon: quality, then size, then seeders. */
function byMerit(a: Stream, b: Stream): number {
  const quality =
    (QUALITY_RANK[streamQuality(b) ?? ""] ?? 0) -
    (QUALITY_RANK[streamQuality(a) ?? ""] ?? 0);
  if (quality !== 0) return quality;
  // Size stands in for bitrate within a quality; seeders break that, since a
  // torrent nobody holds is no use however large.
  const size = (streamSizeBytes(b) ?? 0) - (streamSizeBytes(a) ?? 0);
  if (size !== 0) return size;
  return (streamSeeders(b) ?? 0) - (streamSeeders(a) ?? 0);
}

/**
 * Grouped by addon, best first inside each group.
 *
 * Addons return their results in whatever order they please, so sorting purely
 * on merit interleaves them and the list stops reading as "what each addon
 * found". Addon order is the order they first appear, which is the order they
 * are installed in - so the addon you trust most keeps the top of the list,
 * and its own results are still ordered best first.
 */
export function sortStreams(streams: readonly Stream[]): Stream[] {
  const order = new Map<string, number>();
  for (const stream of streams) {
    const addon = stream.addonName || "";
    if (!order.has(addon)) order.set(addon, order.size);
  }
  return [...streams].sort((a, b) => {
    const group =
      (order.get(a.addonName || "") ?? 0) - (order.get(b.addonName || "") ?? 0);
    if (group !== 0) return group;
    return byMerit(a, b);
  });
}

/**
 * The TV client's short quality words. It heads its label with these rather
 * than the exact resolution because the resolution is printed in the line
 * beneath it.
 */
const QUALITY_WORDS: Record<string, string> = {
  "4K": "4K",
  "1440p": "QHD",
  "1080p": "FHD",
  "720p": "HD",
  "480p": "SD",
};

/**
 * The name to print for a source, built from what was parsed out of it rather
 * than from the addon's own line.
 *
 * The TV client (js/core/debrid/directDebridStreamPresentation.js) throws the
 * addon's `name` and `description` away for every stream its debrid resolver
 * manages and renders a template in their place, which is why "[TORRENT]" and
 * the rest of the release blob never reach the screen there. This is that
 * template's default written out: quality word, provider, "Instant".
 *
 * Streams the resolver does not manage - a plain HTTP link an addon returned -
 * keep their own line, as they do on TV. They are not torrents, so there is no
 * blob to hide, and calling them instant would say something untrue.
 */
export function streamLabel(stream: Stream, provider: string | null): string {
  if (!provider) return streamHeadline(stream);
  // No resolution parsed is not the same as a low one: the TV says "Direct"
  // rather than guessing, and a wrong quality word is worse than none.
  const quality = QUALITY_WORDS[streamQuality(stream) ?? ""] ?? "Direct";
  return `${quality} ${provider} Instant`;
}

/**
 * The release itself, for the line under the label.
 *
 * The filename the addon declared is preferred over its heading: the heading
 * is sometimes only the addon's own name again, which the row already prints
 * beside it.
 */
export function streamReleaseName(stream: Stream): string | null {
  const filename = String(stream.behaviorHints?.filename ?? "").trim();
  if (filename) return filename;
  const headline = streamHeadline(stream);
  if (!headline || headline === "Unknown source") return null;
  return headline === (stream.addonName || "") ? null : headline;
}

/**
 * Whether this client offers a source at all.
 *
 * 2160p is dropped here and nowhere else. A 4K remux runs 40-60 Mbps and every
 * byte crosses the proxy twice - pulled from the debrid host, then served to
 * the browser - for a picture a browser window is almost always scaling back
 * down. The addons still return it and every other client still lists it; this
 * is a rule about the browser client, not about the library.
 */
export function offeredInBrowser(stream: Stream): boolean {
  return streamQuality(stream) !== "4K";
}
