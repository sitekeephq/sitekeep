/**
 * WOPI discovery (<editor>/hosting/discovery): which file extensions the editor can view and
 * edit, the action URL of each (urlsrc with placeholders) and the proof-key public keys.
 *
 * Formats handled:
 * - ONLYOFFICE Docs: apps "Word", "Excel", "PowerPoint", "WordPdf"… with one action per
 *   extension (name="edit" ext="docx" requires="locks,update"), urlsrc with <xx=PLACEHOLDER&>.
 * - Collabora Online: apps named by MIME type (ext="") and apps "writer", "calc", "impress"
 *   with per-extension actions; urlsrc ends with "cool.html?" and needs WOPISrc appended.
 */
import { proofKeysFrom, type ProofKeyAttributes, type ProofKeys } from "./proof.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

export interface DiscoveryAction {
  app: string;
  name: string;
  ext: string;
  urlsrc: string;
  requires: string[];
  isDefault: boolean;
}

export interface Discovery {
  /** Net zone the actions were taken from ("external-https", "external-http"…). */
  zone: string | null;
  actions: DiscoveryAction[];
  favIcons: Record<string, string>;
  proofKey: ProofKeyAttributes | null;
  proofKeys: ProofKeys;
}

/** Collabora's MIME-named apps → extensions. */
const MIME_EXTENSIONS: Record<string, string[]> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-word.document.macroenabled.12": ["docm"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": ["dotx"],
  "application/msword": ["doc"],
  "application/vnd.oasis.opendocument.text": ["odt"],
  "application/vnd.oasis.opendocument.text-template": ["ott"],
  "application/rtf": ["rtf"],
  "text/rtf": ["rtf"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.ms-excel.sheet.macroenabled.12": ["xlsm"],
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": ["xlsb"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.oasis.opendocument.spreadsheet": ["ods"],
  "text/csv": ["csv"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": ["pptm"],
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": ["ppsx"],
  "application/vnd.ms-powerpoint": ["ppt", "pps"],
  "application/vnd.oasis.opendocument.presentation": ["odp"],
  "text/plain": ["txt"],
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Parses discovery XML; actions from the preferred net zone (else the first one with actions). */
export function parseDiscovery(xml: string, preferredZone?: string): Discovery {
  if (!/<wopi-discovery[\s>]/.test(xml)) throw new Error(tFor(DEFAULT_LANGUAGE)("office:discovery.notXml"));
  const zones: { name: string; actions: DiscoveryAction[]; favIcons: Record<string, string> }[] = [];
  const zoneRe = /<net-zone\b([^>]*)>([\s\S]*?)<\/net-zone>/g;
  for (const z of xml.matchAll(zoneRe)) {
    const zone = { name: attrs(z[1]!).name ?? "", actions: [] as DiscoveryAction[], favIcons: {} as Record<string, string> };
    for (const app of z[2]!.matchAll(/<app\b([^>]*?)(\/>|>([\s\S]*?)<\/app>)/g)) {
      const a = attrs(app[1]!);
      const appName = a.name ?? "";
      if (a.favIconUrl) zone.favIcons[appName] = a.favIconUrl;
      for (const act of (app[3] ?? "").matchAll(/<action\b([^>]*?)\/?>/g)) {
        const x = attrs(act[1]!);
        if (!x.name || !x.urlsrc) continue;
        const exts = x.ext ? [x.ext.toLowerCase()] : (MIME_EXTENSIONS[appName.toLowerCase()] ?? []);
        for (const ext of exts) {
          zone.actions.push({
            app: appName,
            name: x.name,
            ext,
            urlsrc: x.urlsrc,
            requires: (x.requires ?? "").split(",").map((s) => s.trim()).filter(Boolean),
            isDefault: x.default === "true",
          });
        }
      }
    }
    zones.push(zone);
  }
  const chosen =
    zones.find((z) => z.name === preferredZone && z.actions.length) ?? zones.find((z) => z.actions.length) ?? zones[0] ?? null;
  const pk = /<proof-key\b([^>]*?)\/?>/.exec(xml);
  const proofKey = pk ? (attrs(pk[1]!) as ProofKeyAttributes) : null;
  return {
    zone: chosen?.name ?? null,
    actions: chosen?.actions ?? [],
    favIcons: chosen?.favIcons ?? {},
    proofKey,
    proofKeys: proofKey ? proofKeysFrom(proofKey) : { current: null, old: null },
  };
}

/** The action for an extension: "edit" (needs locks/update support, which this host has) or "view". */
export function findAction(d: Discovery, extension: string, mode: "edit" | "view"): DiscoveryAction | null {
  const ext = extension.replace(/^\.+/, "").toLowerCase();
  const names = mode === "edit" ? ["edit"] : ["view", "embedview", "view_comment"];
  for (const name of names) {
    const list = d.actions.filter((a) => a.ext === ext && a.name === name);
    const hit = list.find((a) => a.isDefault) ?? list[0];
    if (hit) return hit;
  }
  return null;
}

export function extensionsWith(d: Discovery, mode: "edit" | "view"): string[] {
  const exts = new Set(d.actions.map((a) => a.ext));
  return [...exts].filter((e) => findAction(d, e, mode)).sort();
}

export interface ActionUrlOptions {
  /** UI and document language (UI_LLCC, DC_LLCC), e.g. "tr-TR". */
  lang?: string;
  /** Extra query parameters (Collabora: lang, closebutton). */
  extra?: Record<string, string>;
}

/**
 * Fills the urlsrc placeholders (<name=PLACEHOLDER&>): language and WOPI source are set,
 * the rest are dropped. WOPISrc is appended when the urlsrc has no WOPI_SOURCE placeholder.
 */
export function buildActionUrl(urlsrc: string, wopiSrc: string, opts: ActionUrlOptions = {}): string {
  let hasSource = false;
  const lang = opts.lang ?? "tr-TR";
  let url = urlsrc.replace(/<([A-Za-z0-9_]+)=([A-Z0-9_]+)&?>/g, (_m, key: string, ph: string) => {
    switch (ph) {
      case "UI_LLCC":
      case "DC_LLCC":
        return `${key}=${encodeURIComponent(lang)}&`;
      case "WOPI_SOURCE":
        hasSource = true;
        return `${key}=${encodeURIComponent(wopiSrc)}&`;
      default:
        return "";
    }
  });
  const params = new URLSearchParams();
  if (!hasSource) params.set("WOPISrc", wopiSrc);
  for (const [k, v] of Object.entries(opts.extra ?? {})) params.set(k, v);
  url = url.replace(/&{2,}/g, "&").replace(/\?&+/, "?").replace(/[?&]+$/, "");
  const q = params.toString();
  if (!q) return url;
  return url + (url.includes("?") ? "&" : "?") + q;
}

/** Swaps the internal editor address for the public one in a URL from the discovery. */
export function toPublicUrl(url: string, internalBase: string | null, publicBase: string | null): string {
  if (!publicBase || !internalBase) return url;
  const i = internalBase.replace(/\/+$/, "");
  const p = publicBase.replace(/\/+$/, "");
  if (url === i || url.startsWith(`${i}/`) || url.startsWith(`${i}?`)) return p + url.slice(i.length);
  try {
    // The editor may report its own host name (e.g. http://localhost:9980): same path, public origin.
    const u = new URL(url);
    const pub = new URL(p);
    const int = new URL(i);
    if (u.origin !== pub.origin && (u.origin === int.origin || ["localhost", "127.0.0.1"].includes(u.hostname))) {
      return pub.origin + u.pathname + u.search;
    }
  } catch {
    /* keep */
  }
  return url;
}
