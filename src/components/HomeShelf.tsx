import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const listeners = new Map<Element, (nearby: boolean) => void>();
let observer: IntersectionObserver | undefined;

/** Keep poster trees and decoded images bounded even after browsing 250 rows. */
export function HomeShelf({ children, label, enabled = true }: {
  children: ReactNode;
  label?: string;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(!enabled);
  const height = useRef<number | undefined>(undefined);
  const scrollLeft = useRef(0);

  useLayoutEffect(() => {
    if (!enabled) return;
    const element = ref.current!;
    if (typeof IntersectionObserver === "undefined") {
      setNearby(true);
      return;
    }
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin: "1000px 0px" });
    listeners.set(element, (visible) => {
      if (!visible && element.contains(document.activeElement)) return;
      setNearby(visible);
    });
    observer.observe(element);
    return () => {
      observer?.unobserve(element);
      listeners.delete(element);
      if (!listeners.size) {
        observer?.disconnect();
        observer = undefined;
      }
    };
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled || !nearby) return;
    const element = ref.current!;
    const row = element.querySelector<HTMLElement>(".media-row");
    if (row) row.scrollLeft = scrollLeft.current;
    const saveScroll = () => { if (row) scrollLeft.current = row.scrollLeft; };
    row?.addEventListener("scroll", saveScroll, { passive: true });
    const measure = () => {
      height.current = element.getBoundingClientRect().height;
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    resize?.observe(element);
    return () => {
      row?.removeEventListener("scroll", saveScroll);
      resize?.disconnect();
    };
  }, [nearby, enabled]);

  if (!enabled) return children;
  return (
    <div
      ref={ref}
      className="home-shelf"
      role="group"
      aria-label={label}
      tabIndex={enabled && !nearby ? 0 : undefined}
      onFocus={() => setNearby(true)}
      style={nearby ? undefined : { height: height.current }}
    >
      {nearby ? children : <div className="home-shelf-placeholder" aria-hidden="true" />}
    </div>
  );
}
