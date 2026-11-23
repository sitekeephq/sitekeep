/**
 * Update check state (system setting `updates.check`): whether the daily check is on, what the last one found
 * and where it came from. Written by the check (check.ts), the licence reply (license/online.ts) and the
 * administrator (routes.ts).
 */
import type { Db } from "../db/index.js";
import { getSetting, putSetting } from "../ai/settings.js";
import { isNewerRelease, parseSemver } from "./semver.js";

export interface LatestRelease {
  version: string;
  url: string | null;
  publishedAt: string | null;
  /** "github": the daily check; "licence": the licensing service's reply (Enterprise). */
  source: "github" | "licence";
}

export interface UpdateCheckState {
  /** The daily check is on (off until an administrator turns it on; the manual check works either way). */
  enabled: boolean;
  /** The one-time "Check for new versions automatically?" card was answered (either way). */
  promptDismissed: boolean;
  lastCheckAt: string | null;
  latest: LatestRelease | null;
  lastError: string | null;
}

export const UPDATE_SETTING = "updates.check";
export const DEFAULT_UPDATE_STATE: UpdateCheckState = { enabled: false, promptDismissed: false, lastCheckAt: null, latest: null, lastError: null };

export async function getUpdateState(db: Db): Promise<UpdateCheckState> {
  return { ...DEFAULT_UPDATE_STATE, ...(await getSetting<Partial<UpdateCheckState>>(db, UPDATE_SETTING, {})) };
}

export async function saveUpdateState(db: Db, patch: Partial<UpdateCheckState>, userId: string | null = null): Promise<UpdateCheckState> {
  const next = { ...(await getUpdateState(db)), ...patch };
  await putSetting(db, UPDATE_SETTING, next, userId);
  return next;
}

/** Only an https link is shown to administrators (or http for a local mirror in SITEKEEP_UPDATE_URL tests). */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 500) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the newest release known: a `latest` from the licence reply (Enterprise) counts as "licence"; whichever source knows the
 * newer release wins. A pre-release is never kept.
 */
export async function noteLatest(db: Db, found: { version: string; url?: string | null; publishedAt?: string | null }, source: LatestRelease["source"], extra: Partial<UpdateCheckState> = {}): Promise<UpdateCheckState> {
  const state = await getUpdateState(db);
  const v = parseSemver(found.version);
  let latest = state.latest;
  if (v && !v.pre.length) {
    const candidate: LatestRelease = { version: `${v.major}.${v.minor}.${v.patch}`, url: safeUrl(found.url), publishedAt: found.publishedAt ?? null, source };
    // The newest known release wins; the same version is refreshed (link, date, source). GitHub's "latest release"
    // replaces what GitHub said before, also downwards: a release that was withdrawn stops being offered.
    if (!latest || candidate.version === latest.version || isNewerRelease(candidate.version, latest.version) || (source === "github" && latest.source === "github"))
      latest = candidate;
  }
  if (latest === state.latest && !Object.keys(extra).length) return state;
  return saveUpdateState(db, { ...extra, latest });
}
