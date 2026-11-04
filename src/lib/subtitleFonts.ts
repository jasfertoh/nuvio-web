/**
 * The faces subtitles can be set in.
 *
 * Stacks rather than single names, and families a browser already has - with
 * one exception, the Netflix-style preset, whose face (Inter, OFL) ships with
 * the app as a 48KB file and is fetched only when that preset is in use. A
 * line that arrives before the font shows in the fallback rather than waiting.
 *
 * Stored against a key rather than the stack itself, so a stack can be
 * corrected later without rewriting what every profile has saved.
 */
export const SUBTITLE_FONTS = {
  default: {
    label: "Nuvio",
    stack: "Nuvio, Inter, system-ui, sans-serif",
  },
  system: {
    label: "System",
    stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  grotesque: {
    label: "Grotesque",
    stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  humanist: {
    label: "Humanist",
    stack: "Verdana, Tahoma, Geneva, sans-serif",
  },
  serif: {
    label: "Serif",
    stack: "Georgia, 'Times New Roman', Times, serif",
  },
  mono: {
    label: "Monospace",
    stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  // Netflix's own face (Netflix Sans) is not licensed for use elsewhere; Inter
  // is the open face closest to it. More than a font: see NETFLIX_STYLE.
  netflix: {
    label: "Netflix-style",
    stack: "'Inter Subtitles', Inter, 'Helvetica Neue', Arial, sans-serif",
  },
} as const;

/**
 * What the Netflix-style preset changes besides the face: a soft drop shadow
 * instead of an outline, no box, and a medium weight. Colour, size and
 * position stay the viewer's.
 */
export const NETFLIX_STYLE = {
  weight: 500,
  boldWeight: 700,
  shadow: "0 0 2px #000, 0 0 6px #000c, 0 2px 3px #000",
} as const;

export type SubtitleFontKey = keyof typeof SUBTITLE_FONTS;

export const SUBTITLE_FONT_KEYS = Object.keys(
  SUBTITLE_FONTS,
) as SubtitleFontKey[];

/**
 * Falls back rather than failing. A key can arrive from a newer build or from
 * another client writing the same synced setting, and a subtitle with no font
 * at all is a worse answer than one in the default face.
 */
export const subtitleFontStack = (key: string): string =>
  (SUBTITLE_FONTS[key as SubtitleFontKey] ?? SUBTITLE_FONTS.default).stack;
