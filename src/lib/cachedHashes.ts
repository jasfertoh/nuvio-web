/**
 * What Torbox was last seen to hold, by torrent hash.
 *
 * Asking is not fast - measured between half a second and two and a half,
 * depending on how warm Torbox is - and the sources panel cannot show a list
 * until the answer is in, or it would show rows that then vanish. Remembering
 * the answer means that wait is paid once rather than every time a title is
 * opened, and the same hash turns up again constantly: reopening a title,
 * moving between episodes of a series, and the player's own sources drawer
 * all ask about the same torrents.
 *
 * Ten minutes, because this is a claim about somebody else's cache: a torrent
 * can be added or expire while the app is open, and a stale "no" would hide a
 * source that is now perfectly playable.
 */
const TTL_MS = 10 * 60_000;
/** Enough for a long evening's browsing; the oldest go first. */
const MAX_ENTRIES = 4_000;

const known = new Map<string, { cached: boolean; at: number }>();

/** Splits hashes into what is already known and what still has to be asked. */
export function partitionHashes(
  hashes: string[],
  now = Date.now(),
): { known: Record<string, boolean>; missing: string[] } {
  const answered: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const hash of hashes) {
    const hit = known.get(hash);
    if (hit && now - hit.at < TTL_MS) answered[hash] = hit.cached;
    else missing.push(hash);
  }
  return { known: answered, missing };
}

export function rememberHashes(
  answers: Record<string, boolean>,
  now = Date.now(),
): void {
  for (const [hash, cached] of Object.entries(answers)) {
    // Deleted first so a hash that is asked about again moves to the end of
    // the map, which is what makes the eviction below drop the least recently
    // seen rather than the first ever seen.
    known.delete(hash);
    known.set(hash, { cached, at: now });
  }
  while (known.size > MAX_ENTRIES) {
    const oldest = known.keys().next();
    if (oldest.done) break;
    known.delete(oldest.value);
  }
}

/** Test seam, and what a sign-out should call. */
export function forgetHashes(): void {
  known.clear();
}
