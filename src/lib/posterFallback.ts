/**
 * The addresses a poster can be drawn from, best first.
 *
 * AIOMetadata serves its posters through its own host — a proxy that adds the
 * rating overlay — so when that host rate limits, the posters go with the
 * metadata and a whole grid turns blank. Each proxied address carries the
 * plain image it would fall back to (`fallback=`, usually TMDB), and any IMDb
 * title has a Metahub poster. Neither is behind the same limiter.
 */
export function posterCandidates(poster: string | undefined, id: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value || !/^https:\/\//i.test(value) || candidates.includes(value)) return;
    candidates.push(value);
  };
  add(poster);
  if (poster) {
    try {
      add(new URL(poster).searchParams.get("fallback"));
    } catch {
      // Not a URL we can read; the rest of the list still applies.
    }
  }
  const imdb = /^(tt\d+)/.exec(id)?.[1];
  if (imdb) add(`https://images.metahub.space/poster/medium/${imdb}/img`);
  return candidates;
}
