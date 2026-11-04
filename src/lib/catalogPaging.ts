import type { Meta } from "../types";

/**
 * The shortest gap between two page requests to one catalog.
 *
 * Scrolling a long catalog asks for page after page as fast as each answers,
 * and that burst is what an addon's rate limiter is there to stop. A browser
 * usually cannot even see the 429 it sends back (see `shouldRetry`), so the
 * cheaper fix is not to earn it.
 */
export const PAGE_GAP_MS = 400;

export type PageMerge = {
  /** Titles from the page not already shown. */
  additions: Meta[];
  /** Where the next page starts. */
  nextOffset: number;
  /** No more pages worth asking for. */
  done: boolean;
};

const keyOf = (item: Pick<Meta, "id" | "type">) => `${item.type}:${item.id}`;

/**
 * Folds one page into what is already shown.
 *
 * The offset moves by what the addon sent, not by what was kept. It used to
 * be the number of titles on screen, which drifts from the addon's own count
 * as soon as anything is dropped as a duplicate, and starts wrong whenever the
 * first page was trimmed for a home row — so every request after the first
 * asked for an overlapping, oddly placed page.
 */
export function mergePage(
  shown: Pick<Meta, "id" | "type">[],
  offset: number,
  page: Meta[],
): PageMerge {
  const known = new Set(shown.map(keyOf));
  const additions: Meta[] = [];
  for (const item of page) {
    const key = keyOf(item);
    if (known.has(key)) continue;
    known.add(key);
    additions.push(item);
  }
  return {
    additions,
    nextOffset: offset + page.length,
    // An empty page is the end. So is one with nothing new: addons that ignore
    // `skip` send their first page forever, and that must not loop.
    done: page.length === 0 || additions.length === 0,
  };
}
