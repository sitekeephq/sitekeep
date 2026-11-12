/**
 * Route table of the five-item menu (docs/product/SADELESTIRME.md, 1. aşama): every old address (the 17-item
 * menu, notification / e-mail / MCP links) is routed and lands in its new place.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchPath } from "react-router-dom";
import { HUB_VIEW_KEYS } from "@sitekeep/shared";
import { HUB_VIEWS, MODEL_TABS, NAV_ITEMS, NAV_SETTINGS, SETTINGS_TABS } from "../../src/app/navigation/nav";
import { LEGACY_URLS, hubListPath, hubViewPath, legacyRedirect, placeOf } from "../../src/app/navigation/routes-table";
import { webModules } from "../../src/app/modules";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoutes = fs.readFileSync(path.join(here, "../../src/app/routes/AppRoutes.tsx"), "utf8");
const legacyProjectRedirect = fs.readFileSync(path.join(here, "../../src/app/routes/LegacyProjectRedirect.tsx"), "utf8");

/** Paths of the canonical project routes, with layout routes flattened ("" = index), plus the modules' pages. */
function projectRoutePaths(): string[] {
  const start = appRoutes.indexOf('<Route path="projects/:pid"');
  expect(start).toBeGreaterThan(0);
  const block = appRoutes.slice(start, appRoutes.indexOf('<Route path="*"', start));
  const paths = [...block.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!).filter((p) => p !== "projects/:pid");
  if (/<Route\s+index\b/.test(block)) paths.push("");
  // Installed modules add their pages under the same project route (app/modules.ts).
  for (const m of webModules) for (const r of m.projectRoutes ?? []) paths.push(r.path);
  return paths;
}

const ROUTES = projectRoutePaths();
const installed = new Set(webModules.map((m) => m.id));
const PID = "0f8c6d8e-0000-4000-8000-000000000001";

function routed(url: string): string | null {
  const pathname = `/projects/${PID}${url ? `/${url.split("?")[0]}` : ""}`;
  return ROUTES.find((r) => matchPath({ path: `/projects/:pid${r ? `/${r}` : ""}`, end: true }, pathname)) ?? null;
}

describe("route table (old addresses keep working)", () => {
  it("reads the project routes from AppRoutes.tsx", () => {
    expect(ROUTES).toEqual(expect.arrayContaining(["", "works", "works/:wid", "issues/:iid", "reviews/:rid", "viewer", "locations", "spec/:rid"]));
    if (installed.has("planning")) expect(ROUTES).toContain("schedule");
    if (installed.has("field")) expect(ROUTES).toContain("forms/:fid");
  });

  it("keeps /p only as a compatibility redirect", () => {
    expect(appRoutes).toContain('<Route path="p/:pid/*" element={<LegacyProjectRedirect />} />');
    expect(legacyProjectRedirect).toContain("`/projects/${pid}/${rest}${location.search}${location.hash}`");
  });

  const urls = LEGACY_URLS.filter((l) => !l.module || installed.has(l.module));
  it.each(urls.map((l) => [l.url || "(proje ana sayfası)", l] as const))("%s is routed and lands in its place", (_, l) => {
    const [p, q = ""] = l.url.split("?");
    expect(routed(l.url), `no route for ${l.url}`).not.toBeNull();
    expect(placeOf(p!, q ? `?${q}` : "")).toEqual(l.place);
    expect(legacyRedirect(p!, q ? `?${q}` : "")).toBe(l.redirect ?? null);
    if (l.redirect) {
      expect(routed(l.redirect), `redirect target ${l.redirect}`).not.toBeNull();
      const [rp, rq = ""] = l.redirect.split("?");
      expect(placeOf(rp!, rq ? `?${rq}` : "")?.nav).toBe(l.place.nav);
    }
  });

  it("covers the menu entries of the old 17-item menu", () => {
    const old = ["works", "works?bolum=yazismalar", "works?bolum=toplantilar", "works?bolum=bilgi-talepleri", "works?bolum=teknik-onaylar", "works?bolum=gonderimler", "files", "reviews", "spec", "viewer", "coordination", "issues", "forms", "locations", "schedule", "reports", "settings"];
    for (const url of old) expect(LEGACY_URLS.some((l) => l.url === url), url).toBe(true);
  });

  it("every link of the new menu, the hub views and the Model tabs is routed", () => {
    for (const it of [...NAV_ITEMS, NAV_SETTINGS]) expect(routed(it.to), it.key).not.toBeNull();
    for (const t of MODEL_TABS) if (!t.webModule || installed.has(t.webModule)) expect(routed(t.to), t.key).not.toBeNull();
    for (const v of HUB_VIEWS) {
      if (v.webModule && !installed.has(v.webModule)) continue; // that module's pages are not installed
      const url = hubViewPath(v.key, { q: "kablo" });
      expect(routed(url), url).not.toBeNull();
      const [p, q] = url.split("?");
      // Round trip: the address of a view opens that view.
      expect(placeOf(p!, `?${q}`)).toMatchObject({ nav: "isler", hubView: v.key });
    }
    expect(HUB_VIEWS.map((v) => v.key)).toEqual([...HUB_VIEW_KEYS]);
    expect(placeOf("settings", "?sekme=konumlar")).toEqual({ nav: "ayarlar", settingsTab: "konumlar" });
    expect(SETTINGS_TABS.some((t) => t.key === "konumlar")).toBe(true);
  });

  it("an unknown İşler section falls back to the whole list", () => {
    expect(legacyRedirect("works", "?bolum=eski-bolum")).toBe("works");
    expect(legacyRedirect("works", "?bolum=bana")).toBeNull();
    expect(placeOf("works", "?bolum=bana")).toEqual({ nav: "isler", hubView: "bana" });
  });

  it("remembers the hub list without the record", () => {
    expect(hubListPath("/works/abc", "?bolum=toplantilar&q=x")).toBe("works?bolum=toplantilar&q=x");
    expect(hubListPath("issues/1", "")).toBe("issues");
    expect(hubListPath("files/1", "")).toBeNull();
    expect(hubViewPath("tum", { gorunum: "v1", bolum: "x" })).toBe("works?gorunum=v1");
  });
});
