/**
 * Whether an addon subtitle was made for the file actually playing.
 *
 * Subtitles are timed to a release: a WEB-DL and a Blu-ray of the same episode
 * differ by seconds, and a different group's encode can drift through the
 * whole runtime. So an addon subtitle is offered only when it can be shown to
 * belong to this file:
 *
 * - OpenSubtitles matched it by file hash (`m: "h"`), or
 * - its release has the same release group as the video, or
 * - the video's name carries no group (a season pack, say), and the source
 *   family, resolution and - where the video names one - streaming service
 *   all agree.
 *
 * A subtitle that says nothing about its release cannot be checked and is not
 * offered. When nothing qualifies, the player falls back to the subtitles
 * inside the file, which match by definition.
 */

export type SubtitleRelease = {
  /** The release the subtitle was timed to, e.g. its movieReleaseName. */
  release?: string;
  /** OpenSubtitles matched it to this exact file by hash. */
  hashMatch?: boolean;
};

const SOURCES: [RegExp, string][] = [
  [/\bweb-?rip\b/, "webrip"],
  [/\bweb(-?dl)?\b/, "web"],
  [/\b(blu-?ray|bd-?rip|br-?rip|bdremux|remux)\b/, "bluray"],
  [/\bhdtv\b/, "hdtv"],
  [/\bdvd-?rip\b|\bdvd\b/, "dvd"],
];
const SERVICES = ["nf", "amzn", "dsnp", "hmax", "max", "atvp", "hulu", "pcok", "pmtp", "cr", "viki", "iqiyi", "tving", "wavve", "coupang", "dsny", "stan"];
const RESOLUTIONS = ["2160p", "1080p", "720p", "576p", "480p"];

function normalise(name: string): string {
  // Dots and underscores separate words in release names.
  return ` ${name.toLowerCase().replace(/[._]+/g, " ")} `;
}

type Traits = { group?: string; source?: string; service?: string; resolution?: string };

export function releaseTraits(name: string): Traits {
  const text = normalise(name);
  const source = SOURCES.find(([pattern]) => pattern.test(text))?.[1];
  const service = SERVICES.find((code) => text.includes(` ${code} `));
  const resolution = RESOLUTIONS.find((value) => text.includes(value));
  // Scene naming ends with "-GROUP", optionally before an extension or a
  // bracketed tag. Words like "WEB-DL" or "H-264" are not groups.
  const match = name
    .replace(/\.(mkv|mp4|avi|srt|ass|sub)$/i, "")
    .match(/-([A-Za-z0-9]{2,})(?:\[[^\]]*\])?\s*$/);
  const candidate = match?.[1]?.toLowerCase();
  const group = candidate && !["dl", "rip", "264", "265"].includes(candidate) ? candidate : undefined;
  return { group, source, service, resolution };
}

export function subtitleMatchesVideo(subtitle: SubtitleRelease, videoName: string | undefined): boolean {
  if (subtitle.hashMatch) return true;
  if (!subtitle.release || !videoName) return false;
  const video = releaseTraits(videoName);
  const sub = releaseTraits(subtitle.release);
  if (video.group) return sub.group === video.group;
  if (!video.source || !video.resolution) return false;
  if (sub.source !== video.source || sub.resolution !== video.resolution) return false;
  return !video.service || sub.service === video.service;
}
