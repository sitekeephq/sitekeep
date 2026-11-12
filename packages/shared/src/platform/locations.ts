/**
 * Location tree (Forma "Locations"): project-scoped hierarchy of stations, zones, floors,
 * rooms or tunnel sections. Linear assets (metro, rail, road) carry a chainage range in km.
 * Issues, forms and files are linked to a location through a separate link table.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";

/** Suggested node types; the field is free text (stored as typed: data, not translated). */
export const LOCATION_TYPES = [
  "Hat",
  "İstasyon", // i18n-ok: data (node type stored as text)
  "Bölge", // i18n-ok: data (node type stored as text)
  "Bina",
  "Kat",
  "Mahal",
  "Tünel Kesimi", // i18n-ok: data (node type stored as text)
  "Şaft", // i18n-ok: data (node type stored as text)
  "Saha",
] as const;

export const LOCATION_LINK_KINDS = ["issue", "form", "file"] as const;
export type LocationLinkKind = (typeof LOCATION_LINK_KINDS)[number];

export const LOCATION_LINK_KIND_LABELS_TR: Record<LocationLinkKind, string> = {
  issue: "Sorun",
  form: "Form",
  file: "Dosya",
};

export interface LocationDto {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  code: string | null;
  type: string | null;
  /** Chainage in kilometres (e.g. 12.3456 = Km 12+345.6). */
  kmStart: number | null;
  kmEnd: number | null;
  sortOrder: number;
  /** IFC spatial element the node was built from or linked to. */
  ifcFileVersionId: string | null;
  ifcGlobalId: string | null;
  ifcClass: string | null;
}

export interface LocationLinkDto {
  kind: LocationLinkKind;
  targetId: string;
  locationId: string;
  /** Display text of the target (issue title, form number, file name). */
  label?: string;
}

/**
 * Parses a chainage: "12+345.6", "Km 12+345", "12,3456" or "12.3456" (km). Returns km or null
 * for an empty value; throws on garbage (message in `lang`).
 */
export function parseChainage(raw: string | number | null | undefined, lang: string = SHARED_DEFAULT_LANGUAGE): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error(sharedText(lang, "locations.invalidKm"));
    return raw;
  }
  const s = raw.trim().replace(/^km\s*/i, "");
  if (!s) return null;
  const plus = /^(-?)(\d+)\s*\+\s*(\d{1,3}(?:[.,]\d+)?)$/.exec(s);
  if (plus) {
    const v = Number(plus[2]) + Number(plus[3]!.replace(",", ".")) / 1000;
    return plus[1] ? -v : v;
  }
  if (/^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
  throw new Error(sharedText(lang, "locations.invalidKmValue", { value: raw }));
}

/** 12.3456 → "12+345.6"; null → "". */
export function formatChainage(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return "";
  const sign = km < 0 ? "-" : "";
  const abs = Math.abs(km);
  let whole = Math.floor(abs);
  let metres = Math.round((abs - whole) * 1000 * 1000) / 1000;
  if (metres >= 1000) {
    whole += 1;
    metres -= 1000;
  }
  const [int, frac] = String(metres).split(".");
  return `${sign}${whole}+${int!.padStart(3, "0")}${frac ? `.${frac}` : ""}`;
}

/** "SG1 · Pendik Merkez İstasyonu / Kat -1" style path of a node. */
export function locationPath(byId: ReadonlyMap<string, Pick<LocationDto, "id" | "parentId" | "name" | "code">>, id: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.code ? `${cur.code} ${cur.name}` : cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" / ");
}
