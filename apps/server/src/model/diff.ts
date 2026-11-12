/**
 * Richer IFC version comparison: property-level changes (which property, old → new) and change
 * groups by kind, storey and class, most significant first. Deterministic; the AI only words it.
 */
import {
  ifcClassLabel,
  modelFieldLabel,
  type CompareGroupDto,
  type ComparePropChange,
  type ModelChangeKind,
  type VersionCompareDto,
} from "@sitekeep/shared";
import type { ModelIndex } from "./model-index.js";
import type { Candidate } from "./query.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

export const PROP_STOREY = "Kat";
export const PROP_TYPE = "Tip";
export const PROP_NAME = "Ad";
export const PROP_CLASS = "Sınıf"; // i18n-ok: change key (data), shown through modelFieldLabel
export const PROP_MATERIAL = "Malzeme";
export const PROP_PLACEMENT = "Konum";
export const PROP_OTHER = "Diğer"; // i18n-ok: change key (data), shown through modelFieldLabel

const MAX_CHANGES_PER_ELEMENT = 30;
const MAX_GROUP_GUIDS = 5000;
/** More value pairs than this for one storey / class / property are folded into one group. */
const MAX_PAIRS = 3;

const IMPORTANT = /fire|yangin|yangın|loadbearing|tasiyici|taşıyıcı|isexternal|acoustic|akustik|thermal|uvalue|^malzeme$|^kat$|^tip$|^sınıf$/i;

type Diff = Pick<VersionCompareDto, "added" | "removed" | "changed">;

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Property-level changes of one element between two versions. */
export function elementChanges(oldIdx: ModelIndex, newIdx: ModelIndex, guid: string): ComparePropChange[] {
  const a = oldIdx.element(guid);
  const b = newIdx.element(guid);
  if (!a || !b) return [];
  const out: ComparePropChange[] = [];
  const push = (prop: string, from: unknown, to: unknown) => {
    if (str(from) !== str(to)) out.push({ prop, from: str(from), to: str(to) });
  };
  push(PROP_CLASS, a.cls, b.cls);
  push(PROP_NAME, a.name, b.name);
  if (oldIdx.detailed && newIdx.detailed) {
    push(PROP_STOREY, a.storey, b.storey);
    push(PROP_TYPE, a.type, b.type);
    push(PROP_MATERIAL, a.material, b.material);
    const pa = oldIdx.props(a);
    const pb = newIdx.props(b);
    for (const k of new Set([...pa.keys(), ...pb.keys()])) {
      if (out.length >= MAX_CHANGES_PER_ELEMENT) break;
      push(k, pa.get(k), pb.get(k));
    }
    if (!out.length) out.push({ prop: a.placementHash !== b.placementHash ? PROP_PLACEMENT : PROP_OTHER, from: null, to: null });
  }
  return out;
}

export interface DetailedDiff {
  detailed: boolean;
  storeys: Record<string, string | null>;
  changes: Record<string, ComparePropChange[]>;
  groups: CompareGroupDto[];
}

/** Storeys, property changes and change groups for a GlobalId diff. */
/** Group texts are written in `lang` (the reader's). */
export function detailDiff(oldIdx: ModelIndex, newIdx: ModelIndex, diff: Diff, lang = DEFAULT_LANGUAGE): DetailedDiff {
  const detailed = oldIdx.detailed && newIdx.detailed;
  const storeys: Record<string, string | null> = {};
  const changes: Record<string, ComparePropChange[]> = {};
  for (const g of diff.added) storeys[g] = newIdx.element(g)?.storey ?? null;
  for (const g of diff.removed) storeys[g] = oldIdx.element(g)?.storey ?? null;
  for (const g of diff.changed) {
    storeys[g] = newIdx.element(g)?.storey ?? null;
    if (detailed) changes[g] = elementChanges(oldIdx, newIdx, g);
  }
  return { detailed, storeys, changes, groups: groupChanges(oldIdx, newIdx, diff, storeys, changes, detailed, lang) };
}

interface Bucket {
  kind: ModelChangeKind;
  storey: string | null;
  storeyIdx: number;
  cls: string;
  prop?: string;
  pairs: Map<string, { from: string | null; to: string | null; guids: string[] }>;
  guids: string[];
}

export function groupChanges(
  oldIdx: ModelIndex,
  newIdx: ModelIndex,
  diff: Diff,
  storeys: Record<string, string | null>,
  changes: Record<string, ComparePropChange[]>,
  detailed: boolean,
  lang = DEFAULT_LANGUAGE,
): CompareGroupDto[] {
  const t = tFor(lang);
  const buckets = new Map<string, Bucket>();
  const bucket = (kind: ModelChangeKind, guid: string, idx: ModelIndex, prop?: string): Bucket => {
    const el = idx.element(guid);
    const cls = el?.cls ?? "";
    const storey = storeys[guid] ?? null;
    const key = JSON.stringify([kind, storey, cls, prop ?? null]);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { kind, storey, storeyIdx: el?.storeyIdx ?? -1, cls, prop, pairs: new Map(), guids: [] }));
    return b;
  };
  for (const g of diff.added) bucket("added", g, newIdx).guids.push(g);
  for (const g of diff.removed) bucket("removed", g, oldIdx).guids.push(g);
  for (const g of diff.changed) {
    const list = detailed ? (changes[g] ?? []) : [];
    if (!list.length) {
      bucket("changed", g, newIdx).guids.push(g);
      continue;
    }
    for (const c of list) {
      const b = bucket("changed", g, newIdx, c.prop);
      b.guids.push(g);
      const pk = JSON.stringify([c.from, c.to]);
      let p = b.pairs.get(pk);
      if (!p) b.pairs.set(pk, (p = { from: c.from, to: c.to, guids: [] }));
      p.guids.push(g);
    }
  }

  const groups: Omit<CompareGroupDto, "id">[] = [];
  for (const b of buckets.values()) {
    const where = `${b.storey ?? t("model:diff.noStorey")} · ${ifcClassLabel(b.cls, lang)}`;
    const kindWeight = b.kind === "removed" ? 1.6 : b.kind === "added" ? 1.4 : 1;
    const base = { kind: b.kind, storey: b.storey, class: b.cls };
    if (b.kind !== "changed" || !b.prop) {
      const n = b.guids.length;
      const key = b.kind === "added" ? "model:diff.added" : b.kind === "removed" ? "model:diff.removed" : "model:diff.changed";
      groups.push({
        ...base,
        count: n,
        guids: b.guids.slice(0, MAX_GROUP_GUIDS),
        text: t(key, { where, count: n }),
        score: kindWeight * (1 + Math.log2(n)),
      });
      continue;
    }
    const label = modelFieldLabel(b.prop, lang);
    const propWeight = IMPORTANT.test(label) ? 2.5 : b.prop === PROP_PLACEMENT ? 1.2 : b.prop === PROP_OTHER ? 0.6 : 1;
    if (b.pairs.size <= MAX_PAIRS) {
      for (const p of b.pairs.values()) {
        const n = p.guids.length;
        const text =
          b.prop === PROP_PLACEMENT ? t("model:diff.moved", { where, count: n })
          : b.prop === PROP_OTHER ? t("model:diff.otherChanged", { where, count: n })
          : t("model:diff.propChanged", { where, count: n, label, from: p.from ?? "—", to: p.to ?? "—" });
        groups.push({ ...base, count: n, guids: p.guids.slice(0, MAX_GROUP_GUIDS), prop: b.prop, from: p.from, to: p.to, text, score: kindWeight * propWeight * (1 + Math.log2(n)) });
      }
    } else {
      const n = new Set(b.guids).size;
      groups.push({
        ...base,
        count: n,
        guids: [...new Set(b.guids)].slice(0, MAX_GROUP_GUIDS),
        prop: b.prop,
        mixed: true,
        text: t("model:diff.propMixed", { where, count: n, label, values: b.pairs.size }),
        score: kindWeight * propWeight * 0.7 * (1 + Math.log2(n)),
      });
    }
  }
  return groups
    .sort((a, b) => b.score - a.score || b.count - a.count || a.text.localeCompare(b.text, "tr"))
    .map((g, i) => ({ id: `g${i + 1}`, ...g, score: Math.round(g.score * 100) / 100 }));
}

/** Query candidates of a comparison: added / changed elements from the new version, removed from the old. */
export function diffCandidates(oldIdx: ModelIndex, newIdx: ModelIndex, diff: Diff): Candidate[] {
  return [
    ...diff.added.map((guid) => ({ index: newIdx, guid, change: "added" as const })),
    ...diff.changed.map((guid) => ({ index: newIdx, guid, change: "changed" as const })),
    ...diff.removed.map((guid) => ({ index: oldIdx, guid, change: "removed" as const })),
  ];
}

/** Deterministic summary bullets: the most significant groups. */
export function summaryBullets(groups: CompareGroupDto[], max = 12): { text: string; groupIds: string[] }[] {
  return groups.slice(0, max).map((g) => ({ text: g.text, groupIds: [g.id] }));
}
