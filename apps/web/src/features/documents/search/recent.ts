/**
 * The last five document searches of this browser, per project (a convenience: lost with the
 * browser's storage, never sent to the server).
 */
import { searchFilterCount, savedSearchParams, type DocSearchParams } from "@sitekeep/shared";

const KEY = (projectId: string) => `sk.docs.recentSearches.${projectId}`;
export const RECENT_MAX = 5;

export function readRecent(projectId: string): DocSearchParams[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY(projectId)) ?? "[]") as unknown;
    return Array.isArray(list) ? (list.filter((x) => x && typeof x === "object") as DocSearchParams[]).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Adds a search at the top (a repeated one moves up); empty searches are not kept. */
export function rememberRecent(projectId: string, params: DocSearchParams): DocSearchParams[] {
  const p = savedSearchParams({ ...params, sort: undefined, dir: undefined });
  if (!p.q?.trim() && !searchFilterCount(p)) return readRecent(projectId);
  const same = JSON.stringify(p);
  const list = [p, ...readRecent(projectId).filter((x) => JSON.stringify(x) !== same)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(KEY(projectId), JSON.stringify(list));
  } catch {
    // Search still works without browser storage.
  }
  return list;
}
