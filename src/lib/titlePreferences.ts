/**
 * What was chosen while watching one title, remembered for the next time.
 *
 * The profile's settings say how subtitles should look and which languages are
 * wanted in general. These are the corrections made against one title, where
 * the general answer was wrong: a release whose subtitles run half a second
 * late, an anime watched in Japanese by someone who otherwise wants English,
 * a transfer whose burned-in credits want larger text.
 *
 * Local to the browser rather than synced. They describe a particular release
 * as much as a particular title - a delay that fixes one encode is wrong for
 * another - so pushing them to every device would spread a correction beyond
 * the thing it corrects.
 */
export type TitlePreferences = {
  /** Milliseconds to shift subtitles by; negative is earlier. */
  subtitleDelayMs?: number;
  subtitleFontSizeSp?: number;
  /** Normalized language codes, as the pickers report them. */
  subtitleLanguage?: string;
  audioLanguage?: string;
};

const STORE_KEY = "nuvio-web-title-preferences";
/**
 * Enough for a long watching history without letting one browser accumulate
 * an unbounded blob; the oldest are dropped first.
 */
const LIMIT = 200;

type StoredEntry = TitlePreferences & { at: number };
type Store = Record<string, StoredEntry>;

/**
 * Scoped by profile as well as title. Three people share this browser, and a
 * subtitle delay one of them set is not a fact about the other two.
 */
export function titleKey(profileKey: string, contentId: string): string {
  return `${profileKey}:${contentId}`;
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    // Private browsing, a cleared profile, or a blob some earlier version
    // wrote. A missing preference is a far smaller problem than a throw on the
    // path that opens the player.
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable. The preference is lost, nothing else is.
  }
}

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function readTitlePreferences(key: string): TitlePreferences {
  const entry = readStore()[key];
  if (!entry || typeof entry !== "object") return {};
  return {
    subtitleDelayMs: numberOrUndefined(entry.subtitleDelayMs),
    subtitleFontSizeSp: numberOrUndefined(entry.subtitleFontSizeSp),
    subtitleLanguage: stringOrUndefined(entry.subtitleLanguage),
    audioLanguage: stringOrUndefined(entry.audioLanguage),
  };
}

/**
 * Merged rather than replaced, so setting a delay does not forget a language.
 * A field set back to its default is dropped rather than stored, and a title
 * left with nothing to say is removed entirely.
 */
export function rememberTitlePreference(
  key: string,
  patch: TitlePreferences,
  now = Date.now(),
): void {
  const store = readStore();
  const merged: StoredEntry = { ...store[key], ...patch, at: now };
  for (const field of [
    "subtitleDelayMs",
    "subtitleFontSizeSp",
    "subtitleLanguage",
    "audioLanguage",
  ] as const) {
    if (merged[field] === undefined) delete merged[field];
  }
  // A zero delay is the absence of a correction, not a correction of zero.
  if (merged.subtitleDelayMs === 0) delete merged.subtitleDelayMs;

  const { at: _at, ...values } = merged;
  if (!Object.keys(values).length) {
    delete store[key];
  } else {
    store[key] = merged;
  }

  const keys = Object.keys(store);
  if (keys.length > LIMIT) {
    keys
      .sort((left, right) => (store[left]?.at ?? 0) - (store[right]?.at ?? 0))
      .slice(0, keys.length - LIMIT)
      .forEach((stale) => delete store[stale]);
  }
  writeStore(store);
}

/** Test seam. */
export function clearTitlePreferences(): void {
  writeStore({});
}
