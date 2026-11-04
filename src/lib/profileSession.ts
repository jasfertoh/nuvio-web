import type { Profile } from "../types.ts";

export const SESSION_PROFILE_KEY = "nuvio-session-profile";

/** A tab reload restores its own profile, rather than another tab's preference. */
export function profileForReload(profiles: Profile[], stored: string | null): Profile | undefined {
  if (!stored?.trim()) return undefined;
  try {
    const saved: unknown = JSON.parse(stored);
    // Migrate the previous numeric tab marker without introducing a persistent
    // PIN bypass: the caller still runs the normal unlock flow.
    if (typeof saved === "number" && Number.isInteger(saved)) {
      return profiles.find((profile) => profile.profileIndex === saved);
    }
    if (!saved || typeof saved !== "object") return undefined;
    const marker = saved as Record<string, unknown>;
    return profiles.find((profile) => profile.id === marker.id &&
      profile.userId === marker.userId && profile.profileIndex === marker.profileIndex);
  } catch {
    return undefined;
  }
}

export function profileSessionMarker(profile: Profile): string {
  return JSON.stringify({ id: profile.id, userId: profile.userId, profileIndex: profile.profileIndex });
}
