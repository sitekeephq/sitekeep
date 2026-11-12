/** Revision of a document from its title block, revision table and file name, plus consistency warnings. */
import {
  compareRevisions,
  normalizeRevision,
  revisionFromFileName,
  type AntetResult,
  type RevisionInfo,
  type RevisionWarning,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import { foldKey } from "./text.js";

/** Attribute names that hold a revision ("Revizyon", "REVİZYON", "Rev No", "Revision"). */ // i18n-ok: comment
export function isRevisionAttribute(name: string): boolean {
  const k = foldKey(name);
  return ["revizyon", "rev", "rev no", "revision", "revizyon no", "rev nr"].includes(k);
}

export function detectRevision(antet: AntetResult | null, fileName: string, attributeValue?: string | null): RevisionInfo {
  const candidates: RevisionInfo["candidates"] = [];
  const field = antet?.fields.find((f) => f.key === "revision" && f.source !== "table");
  if (field) {
    const v = normalizeRevision(field.value);
    if (v) candidates.push({ value: v, source: "antet", raw: `${field.label}: ${field.value}` });
  }
  const latest = antet?.revisionTable[antet.revisionTable.length - 1];
  if (latest) candidates.push({ value: latest.rev, source: "table", raw: [latest.rev, latest.date, latest.description].filter(Boolean).join(" · ") });
  const fromName = revisionFromFileName(fileName);
  if (fromName) candidates.push({ value: fromName.value, source: "filename", raw: fromName.raw });
  const attr = normalizeRevision(attributeValue ?? null);
  if (attr) candidates.push({ value: attr, source: "attribute", raw: attributeValue! });

  // Title block first, then its revision table, then the file name; the attribute is what the
  // user typed and is compared, not detected.
  const order = ["antet", "table", "filename"] as const;
  for (const source of order) {
    const c = candidates.find((x) => x.source === source);
    if (!c) continue;
    const agree = candidates.filter((x) => x.source !== source && x.source !== "attribute" && x.value === c.value).length;
    const baseConf = source === "antet" ? (field?.confidence ?? 0.7) : source === "table" ? 0.75 : 0.6;
    return { value: c.value, source, confidence: Math.min(0.98, round2(baseConf + 0.1 * agree)), candidates };
  }
  return { value: null, source: null, confidence: 0, candidates };
}

export interface PreviousVersion {
  version: number;
  sha256: string;
  /** Revision recorded for that version (detected, or the attribute at that time). */
  revision: string | null;
}

/**
 * Warnings for a version: same file uploaded again, content changed but the revision did not,
 * revision went backwards, and disagreements between title block, revision table, file name and
 * the file's revision attribute.
 */
export function revisionWarnings(
  info: RevisionInfo,
  current: { sha256: string; version: number },
  previous: PreviousVersion | null,
  attributeValue: string | null,
  lang: string = DEFAULT_LANGUAGE,
): RevisionWarning[] {
  const t = tFor(lang);
  const out: RevisionWarning[] = [];
  const rev = info.value;
  if (previous) {
    if (previous.sha256 === current.sha256) {
      out.push({
        code: "same_content",
        severity: "warn",
        message: t("docintel:revision.sameContent", { version: current.version, previous: previous.version }),
      });
    } else if (rev && previous.revision) {
      const cmp = compareRevisions(rev, previous.revision);
      if (cmp === 0 || rev === previous.revision) {
        out.push({
          code: "same_revision_changed",
          severity: "warn",
          message: t("docintel:revision.sameRevisionChanged", { revision: rev, previous: previous.version, previousRevision: previous.revision }),
        });
      } else if (cmp !== null && cmp < 0) {
        out.push({
          code: "revision_backwards",
          severity: "warn",
          message: t("docintel:revision.backwards", { previous: previous.version, previousRevision: previous.revision, version: current.version, revision: rev }),
        });
      }
    }
  }
  const byName = info.candidates.find((c) => c.source === "filename");
  const antet = info.candidates.find((c) => c.source === "antet");
  const table = info.candidates.find((c) => c.source === "table");
  if (antet && table && antet.value !== table.value && compareRevisions(antet.value, table.value) !== 0) {
    out.push({
      code: "table_mismatch",
      severity: "warn",
      message: t("docintel:revision.tableMismatch", { antet: antet.value, table: table.value }),
    });
  }
  if (byName && rev && info.source !== "filename" && byName.value !== rev && compareRevisions(byName.value, rev) !== 0) {
    out.push({
      code: "name_mismatch",
      severity: "warn",
      message: t("docintel:revision.nameMismatch", { name: byName.raw, revision: rev }),
    });
  }
  const attr = normalizeRevision(attributeValue);
  if (attr && rev && attr !== rev && compareRevisions(attr, rev) !== 0) {
    out.push({
      code: "attribute_mismatch",
      severity: "info",
      message: t("docintel:revision.attributeMismatch", { attribute: attributeValue, revision: rev }),
    });
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
