import type { Meta, Video } from "../types";

/**
 * The ids to ask subtitle addons with, most specific first.
 *
 * Anime catalogs name episodes by Kitsu or MAL ids, which the big subtitle
 * addons do not understand — OpenSubtitles only knows IMDb. The Kitsu addon
 * maps each episode to an IMDb season and episode, so that mapping is offered
 * as a second id for the addons that would otherwise have nothing to say.
 */
export function subtitleRequestIds(
  meta: Pick<Meta, "id" | "imdbId">,
  video?: Pick<Video, "id" | "imdbId" | "imdbSeason" | "imdbEpisode"> | null,
): string[] {
  const ids = [video?.id || meta.id];
  if (video?.imdbId)
    ids.push(
      video.imdbSeason != null && video.imdbEpisode != null
        ? `${video.imdbId}:${video.imdbSeason}:${video.imdbEpisode}`
        : video.imdbId,
    );
  else if (!video && meta.imdbId) ids.push(meta.imdbId);
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Which of `ids` an addon accepts, by the prefixes it declares. One that
 * declares none is asked with the first; one that matches none is not asked,
 * rather than sent an id it can only answer with nothing.
 */
export function idForPrefixes(
  ids: readonly string[],
  prefixes: readonly string[] | undefined,
): string | undefined {
  if (!prefixes?.length) return ids[0];
  return ids.find((id) => prefixes.some((prefix) => id.startsWith(prefix)));
}
