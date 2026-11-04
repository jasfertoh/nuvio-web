/**
 * Subtitle size for this device.
 *
 * The profile's size is one value synced across everything signed in, which
 * is wrong for this particular setting: a size chosen on a phone held at
 * arm's length is not the size wanted on a desktop across the room, and
 * setting it on one changed it on the other.
 *
 * So the profile's value becomes the starting point rather than the answer.
 * A device that has chosen a size keeps it here, in storage that never
 * leaves the browser; one that has not falls back to the profile, so a new
 * device still starts somewhere sensible instead of at a hard-coded default.
 *
 * Same shape as the media proxy's own override, which solves the same problem
 * of a per-device choice inside an account-wide setting.
 */

const KEY = "nuvio-web-subtitle-size";

/** The size chosen on this device, or null to follow the profile. */
export function deviceSubtitleFontSize(): number | null {
  let raw = "";
  try {
    raw = localStorage.getItem(KEY) ?? "";
  } catch {
    // A browser refusing storage simply follows the profile.
    return null;
  }
  if (!raw) return null;
  const value = Number(raw);
  // Anything unparseable or outside the range the controls allow is treated
  // as absent rather than clamped: a stored value that cannot have come from
  // the controls is more likely to be junk than an intention.
  if (!Number.isFinite(value) || value < 6 || value > 40) return null;
  return Math.round(value);
}

/** Pass null to stop overriding and follow the profile again. */
export function setDeviceSubtitleFontSize(size: number | null): void {
  try {
    if (size === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(size)));
  } catch {
    // Nothing to do: the size simply will not persist on this device.
  }
}
