/**
 * The faces subtitles can be set in.
 *
 * Stacks rather than single names, and only families a browser already has -
 * nothing is fetched. A line of dialogue that arrives late because its font is
 * still downloading is worse than one in a face nobody picked, and this app
 * already spends its bandwidth on the video.
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
