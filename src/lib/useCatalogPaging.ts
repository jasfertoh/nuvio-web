import { useCallback, useEffect, useRef, useState } from "react";
import type { Meta } from "../types";
import { mergePage, PAGE_GAP_MS } from "./catalogPaging.ts";

type Start = { items: Meta[]; offset: number; more: boolean };

/**
 * A catalog grid that loads its next page as the bottom comes into view.
 *
 * Shared by the catalog page and Discover, which each had their own copy and
 * the same faults: pages requested back to back, the next one placed by how
 * many titles were on screen rather than by the addon's own count, and the
 * first failure ending the scroll for good — on the catalog page with the
 * error shown above everything that had loaded fine.
 *
 * A failure now stops at the bottom with a retry, keeping what loaded.
 */
export function useCatalogPaging({
  loadPage,
  enabled = true,
  initial,
}: {
  /** Fetches the page starting at `offset`. */
  loadPage(offset: number): Promise<Meta[]>;
  /** Off while something else owns the grid, such as a search. */
  enabled?: boolean;
  initial?: Start;
}) {
  const [items, setItems] = useState<Meta[]>(initial?.items ?? []);
  const [exhausted, setExhausted] = useState(!(initial?.more ?? false));
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState("");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;
  const offset = useRef(initial?.offset ?? 0);
  const busy = useRef(false);
  const lastRequest = useRef(0);
  // Bumped by `reset`, so a page still in flight for the previous catalog is
  // dropped rather than appended to the new one.
  const generation = useRef(0);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);

  const reset = useCallback((start: Start) => {
    generation.current += 1;
    busy.current = false;
    offset.current = start.offset;
    setItems(start.items);
    setExhausted(!start.more);
    setLoadingMore(false);
    setFailure("");
  }, []);

  const more = useCallback(async () => {
    if (!enabled || busy.current || exhausted || failure) return;
    busy.current = true;
    const run = generation.current;
    setLoadingMore(true);
    try {
      const gap = PAGE_GAP_MS - (Date.now() - lastRequest.current);
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      if (run !== generation.current) return;
      lastRequest.current = Date.now();
      const page = await loadRef.current(offset.current);
      if (run !== generation.current) return;
      const merged = mergePage(itemsRef.current, offset.current, page);
      offset.current = merged.nextOffset;
      if (merged.additions.length)
        setItems((current) => [...current, ...merged.additions]);
      if (merged.done) setExhausted(true);
    } catch (reason) {
      if (run !== generation.current) return;
      setFailure(reason instanceof Error ? reason.message : "Could not load more");
    } finally {
      if (run === generation.current) {
        busy.current = false;
        setLoadingMore(false);
      }
    }
  }, [enabled, exhausted, failure]);

  // Re-created after each page (`items.length`), so a sentinel still in view
  // asks for the next one — paced by `PAGE_GAP_MS` — until the screen fills.
  useEffect(() => {
    if (!sentinel || !enabled || exhausted || failure) return;
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void more();
      },
      { rootMargin: "600px" },
    );
    watcher.observe(sentinel);
    return () => watcher.disconnect();
  }, [sentinel, enabled, exhausted, failure, more, items.length]);

  const retry = useCallback(() => setFailure(""), []);

  return {
    items,
    reset,
    loadingMore,
    exhausted,
    failure,
    retry,
    /** Ref for the element below the grid that triggers the next page. */
    sentinel: setSentinel,
  };
}
