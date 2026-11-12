/**
 * Small per-browser memories of the simple screen: the last Dokümanlar folder and the last İşler
 * view of each project. Storage may be blocked (private window): then nothing is remembered.
 */

const DOCS_KEY = (pid: string) => `cde.docs.lastFolder.${pid}`;
const HUB_KEY = (pid: string) => `cde.hub.last.${pid}`;
const HUB_FILTERS_KEY = (pid: string, view: string) => `cde.hub.filters.${pid}.${view}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: not remembered.
  }
}

/** Last opened folder in Dokümanlar (null = project root). */
export function lastDocsFolder(pid: string): string | null {
  return read(DOCS_KEY(pid));
}
export function rememberDocsFolder(pid: string, folderId: string | null) {
  write(DOCS_KEY(pid), folderId);
}

/** Last İşler view as a path under /projects/:pid/ ("works?bolum=toplantilar&q=…"), without a record id. */
export function lastHubPath(pid: string): string | null {
  const v = read(HUB_KEY(pid));
  return v && /^(works|issues|reviews|forms)(\?|$)/.test(v) ? v : null;
}
export function rememberHubPath(pid: string, path: string) {
  write(HUB_KEY(pid), path);
}

/** Filter query of one İşler view, without the section (`bolum`) or a saved view (`gorunum`). */
export function filtersOfSearch(search: URLSearchParams): Record<string, string> {
  const filters: Record<string, string> = {};
  search.forEach((v, k) => {
    if (k !== "gorunum" && k !== "bolum" && v) filters[k] = v;
  });
  return filters;
}

/** Filters last used on this view. Empty once the user clears them. */
export function hubViewFilters(pid: string, view: string): Record<string, string> {
  const raw = read(HUB_FILTERS_KEY(pid, view));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return filtersOfSearch(new URLSearchParams(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string")));
  } catch {
    return {};
  }
}

export function rememberHubFilters(pid: string, view: string, filters: Record<string, string>) {
  const clean = filtersOfSearch(new URLSearchParams(filters));
  write(HUB_FILTERS_KEY(pid, view), Object.keys(clean).length ? JSON.stringify(clean) : null);
}
