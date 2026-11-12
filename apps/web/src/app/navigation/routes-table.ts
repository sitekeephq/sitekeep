/**
 * Where every project URL lives in the five-item menu (docs/product/SADELESTIRME.md, 1. aşama).
 *
 * Old addresses keep working: most of them now render inside their new place (İşler hub, Model
 * tabs, Dokümanlar), the rest redirect (`legacyRedirect`). Notification, e-mail and MCP links
 * (/works/:id, /reviews/:id, /forms/:id, /issues/:id, /files/…?file=…, /viewer?v=…) are unchanged.
 */
import type { HubViewKey } from "@sitekeep/shared";
import { HUB_VIEWS, WORK_SECTIONS, type NavKey, type SettingsTabKey } from "./nav";

export interface NavPlace {
  nav: NavKey;
  /** İşler hub view. */
  hubView?: HubViewKey;
  /** Model tab. */
  modelTab?: "viewer" | "coordination" | "schedule" | "params";
  /** Proje Ayarları tab. */
  settingsTab?: SettingsTabKey;
  /** A single record page inside the place (no list, no "Görünümü Kaydet"). */
  record?: boolean;
}

/** `rest`: the path after /projects/:pid/ without the leading slash ("", "works/12", "coordination/tests/3"). */
export function placeOf(rest: string, search = ""): NavPlace | null {
  const parts = rest.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const [head = "", second] = parts;
  const q = new URLSearchParams(search);
  switch (head) {
    case "":
      return { nav: "bugun" };
    case "works": {
      const bolum = q.get("bolum") ?? "";
      const view = HUB_VIEWS.find((v) => v.path === "works" && v.section && v.section === bolum);
      return { nav: "isler", hubView: view?.key ?? "tum" };
    }
    case "issues":
      return { nav: "isler", hubView: "sorunlar" };
    case "reviews":
      return { nav: "isler", hubView: "incelemeler", record: !!second };
    case "forms":
      return { nav: "isler", hubView: "formlar", record: !!second };
    case "files":
    case "view":
    case "open":
    case "edit":
    case "compare":
    case "spec":
      return { nav: "dokumanlar" };
    case "viewer":
      return { nav: "model", modelTab: "viewer" };
    case "coordination":
      return { nav: "model", modelTab: "coordination" };
    case "schedule":
    case "contracts":
    case "quantities":
      return { nav: "model", modelTab: "schedule" };
    case "param-changes":
      return { nav: "model", modelTab: "params" };
    case "reports":
      return { nav: "raporlar" };
    case "locations":
      return { nav: "ayarlar", settingsTab: "konumlar" };
    case "settings":
      return { nav: "ayarlar", settingsTab: (q.get("sekme") as SettingsTabKey | null) ?? undefined };
    default:
      return null;
  }
}

/** Old addresses that moved: the new address under /projects/:pid/, or null when the old one still renders. */
export function legacyRedirect(rest: string, search = ""): string | null {
  const path = rest.replace(/^\/+|\/+$/g, "");
  if (path === "locations") return "settings?sekme=konumlar";
  if (path === "coordination") return "coordination/sets";
  if (path === "works") {
    // Unknown sections fall back to the whole list instead of an empty page.
    const bolum = new URLSearchParams(search).get("bolum");
    if (bolum && bolum !== "bana" && !WORK_SECTIONS.some((s) => s.key === bolum)) return "works";
  }
  return null;
}

/** URL of a hub view under /projects/:pid/. */
export function hubViewPath(key: HubViewKey, params: Record<string, string> = {}): string {
  const v = HUB_VIEWS.find((x) => x.key === key) ?? HUB_VIEWS[1]!;
  const q = new URLSearchParams();
  if (v.section) q.set("bolum", v.section);
  for (const [k, val] of Object.entries(params)) if (k !== "bolum" && val !== "") q.set(k, val);
  const s = q.toString();
  return s ? `${v.path}?${s}` : v.path;
}

/** The list behind a hub address, without the record: "works/12?bolum=x" → "works?bolum=x". */
export function hubListPath(rest: string, search = ""): string | null {
  const head = rest.replace(/^\/+/, "").split("/")[0] ?? "";
  if (!["works", "issues", "reviews", "forms"].includes(head)) return null;
  const q = search.replace(/^\?/, "");
  return q ? `${head}?${q}` : head;
}

/**
 * The old addresses (menu entries of the 17-item menu and links in notifications, e-mails and MCP
 * answers) with the place they open in now. test/app/routes.test.ts checks that each one is routed and
 * lands in its place.
 */
/** `module`: the page belongs to that module and exists only when it is installed (app/modules.ts). */
export const LEGACY_URLS: { url: string; place: NavPlace; redirect?: string; module?: string }[] = [
  { url: "", place: { nav: "bugun" } },
  { url: "works", place: { nav: "isler", hubView: "tum" } },
  { url: "works?bolum=yazismalar", place: { nav: "isler", hubView: "yazismalar" } },
  { url: "works?bolum=toplantilar", place: { nav: "isler", hubView: "toplantilar" } },
  { url: "works?bolum=bilgi-talepleri", place: { nav: "isler", hubView: "bilgi-talepleri" } },
  { url: "works?bolum=teknik-onaylar", place: { nav: "isler", hubView: "teknik-onaylar" } },
  { url: "works?bolum=gonderimler", place: { nav: "isler", hubView: "gonderimler" } },
  { url: "works/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "isler", hubView: "tum" } },
  { url: "works/0f8c6d8e-1111-4222-8333-444455556666?bolum=yazismalar", place: { nav: "isler", hubView: "yazismalar" } },
  { url: "issues", place: { nav: "isler", hubView: "sorunlar" } },
  { url: "issues/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "isler", hubView: "sorunlar" } },
  { url: "reviews", place: { nav: "isler", hubView: "incelemeler", record: false } },
  { url: "reviews/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "isler", hubView: "incelemeler", record: true } },
  { url: "forms", place: { nav: "isler", hubView: "formlar", record: false }, module: "field" },
  { url: "forms/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "isler", hubView: "formlar", record: true }, module: "field" },
  { url: "forms/templates/pdf/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "isler", hubView: "formlar", record: true }, module: "field" },
  { url: "files", place: { nav: "dokumanlar" } },
  { url: "files/0f8c6d8e-1111-4222-8333-444455556666?file=0f8c6d8e-1111-4222-8333-444455556667", place: { nav: "dokumanlar" } },
  { url: "view/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "dokumanlar" } },
  { url: "open/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "dokumanlar" } },
  { url: "edit/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "dokumanlar" }, module: "connect" },
  { url: "compare?from=a&to=b", place: { nav: "dokumanlar" } },
  { url: "spec", place: { nav: "dokumanlar" } },
  { url: "spec/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "dokumanlar" } },
  { url: "viewer", place: { nav: "model", modelTab: "viewer" } },
  { url: "viewer?v=0f8c6d8e-1111-4222-8333-444455556666&issue=x", place: { nav: "model", modelTab: "viewer" } },
  { url: "coordination", place: { nav: "model", modelTab: "coordination" }, redirect: "coordination/sets" },
  { url: "coordination/sets", place: { nav: "model", modelTab: "coordination" } },
  { url: "coordination/tests/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "model", modelTab: "coordination" } },
  { url: "coordination/ids", place: { nav: "model", modelTab: "coordination" } },
  { url: "schedule", place: { nav: "model", modelTab: "schedule" }, module: "planning" },
  { url: "schedule?s=x&a=y", place: { nav: "model", modelTab: "schedule" }, module: "planning" },
  { url: "contracts", place: { nav: "model", modelTab: "schedule" }, module: "cost" },
  { url: "contracts/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "model", modelTab: "schedule" }, module: "cost" },
  { url: "quantities?v=x&from=y", place: { nav: "model", modelTab: "schedule" }, module: "cost" },
  // Notification links of parameter change requests (Değişiklik Talebi).
  { url: "param-changes", place: { nav: "model", modelTab: "params" }, module: "coordinate" },
  { url: "param-changes/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "model", modelTab: "params" }, module: "coordinate" },
  { url: "reports", place: { nav: "raporlar" } },
  { url: "reports/0f8c6d8e-1111-4222-8333-444455556666", place: { nav: "raporlar" } },
  { url: "reports?template=issue-status", place: { nav: "raporlar" } },
  { url: "locations", place: { nav: "ayarlar", settingsTab: "konumlar" }, redirect: "settings?sekme=konumlar" },
  { url: "settings", place: { nav: "ayarlar" } },
];
