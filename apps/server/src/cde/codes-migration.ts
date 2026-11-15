/**
 * Live-data migration of ISO 19650 codes (docs/features/CDE_STATES.md "Codes"): before codes were
 * stored per version, they were free file attributes ("Uygunluk Kodu" from the ISO template,
 * "Uygunluk" from OpenCDE, "Revizyon" and the like). For the current version of each file the
 * values that are valid codes of the project's profile are copied into
 * file_versions.suitability_code / revision_code. Attributes stay as they are.
 *
 * Code scheme per project, chosen once (marker: audit "cde.codes_migrated"): a project with any
 * R-revision ("R01", "Rev 2") gets `legacy_r`, others keep `iso_uk_na`. A project whose scheme is
 * not the default or whose CDE settings were saved by a person keeps its scheme.
 *
 * Values that are not codes of the profile are left in the attributes and reported: audit
 * "cde.migration_unmapped" per project (only when the list changed) and
 * GET /projects/:pid/cde/codes/unmapped.
 *
 * Idempotent and batched: a version whose codes were set (codes_set_at) is never touched again;
 * the run can be repeated or stopped at any time. Runs at server start (after the migrations) and
 * from src/scripts/cde-backfill.ts.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  codeProfile,
  isKnownRevision,
  isKnownSuitability,
  normaliseRevision,
  normaliseSuitability,
  type CdeCodeProfile,
  type CdeCodeScheme,
  type CdeUnmappedCodeDto,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog, fileVersions, files, projectCdeSettings } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { legacyCodeInputs, loadCodeSettings } from "./codes.js";

export type UnmappedCode = CdeUnmappedCodeDto;

export interface CodesMigrationReport {
  /** Projects whose scheme was decided in this run. */
  schemesChosen: number;
  /** Of these, projects switched to legacy_r. */
  legacyProjects: number;
  /** Versions that got codes. */
  versionsMapped: number;
  /** Attribute values left unmapped. */
  unmapped: number;
}

/** Older revisions written with R ("R01", "Rev 2") mean the project uses the legacy scheme. */
const isRRevision = (raw: string) => /^R\d+/.test(normaliseRevision(raw) ?? "");

type Candidate = {
  fileId: string;
  projectId: string;
  name: string;
  folderId: string;
  attributes: Record<string, string>;
  versionId: string;
  suitabilityCode: string | null;
  revisionCode: string | null;
};

/**
 * Current versions with legacy attribute values and a code still empty, in id order (one project's
 * live files, or every file). `untouched`: only versions whose codes nobody set (the migration).
 */
async function* candidates(db: Db, batchSize: number, filter: { projectId?: string; untouched?: boolean } = {}): AsyncGenerator<Candidate[]> {
  const { projectId, untouched } = filter;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await db
      .select({
        fileId: files.id,
        projectId: files.projectId,
        name: files.name,
        folderId: files.folderId,
        attributes: files.attributes,
        versionId: fileVersions.id,
        suitabilityCode: fileVersions.suitabilityCode,
        revisionCode: fileVersions.revisionCode,
      })
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(
        and(
          gt(files.id, after),
          projectId ? and(eq(files.projectId, projectId), isNull(files.deletedAt)) : undefined,
          or(isNull(fileVersions.suitabilityCode), isNull(fileVersions.revisionCode)),
          untouched ? isNull(fileVersions.codesSetAt) : undefined,
          sql`${files.attributes} <> '{}'::jsonb`,
        ),
      )
      .orderBy(asc(files.id))
      .limit(batchSize);
    if (!rows.length) return;
    after = rows[rows.length - 1]!.fileId;
    const withValues = rows.filter((r) => {
      const raw = legacyCodeInputs(r.attributes);
      return (!r.suitabilityCode && raw.suitabilityCode) || (!r.revisionCode && raw.revisionCode);
    });
    if (withValues.length) yield withValues;
    if (rows.length < batchSize) return;
  }
}

/** What the attributes of a version give under a profile: codes to store and values that do not fit. */
function mapCandidate(profile: CdeCodeProfile, c: Candidate) {
  const raw = legacyCodeInputs(c.attributes);
  const set: { suitabilityCode?: string; revisionCode?: string } = {};
  const unmapped: UnmappedCode[] = [];
  const base = { fileId: c.fileId, versionId: c.versionId, name: c.name, folderId: c.folderId };
  if (!c.suitabilityCode && raw.suitabilityCode) {
    if (isKnownSuitability(profile, raw.suitabilityCode)) set.suitabilityCode = normaliseSuitability(raw.suitabilityCode)!;
    else unmapped.push({ ...base, field: "suitabilityCode", value: raw.suitabilityCode });
  }
  if (!c.revisionCode && raw.revisionCode) {
    if (isKnownRevision(profile, raw.revisionCode)) set.revisionCode = normaliseRevision(raw.revisionCode, profile)!;
    else unmapped.push({ ...base, field: "revisionCode", value: raw.revisionCode });
  }
  return { set, unmapped };
}

const MAX_REPORTED = 500;

/** Legacy attribute values of a project's current versions that are not codes of its profile. */
export async function unmappedLegacyCodes(db: Db, projectId: string, batchSize = 1000): Promise<{ items: UnmappedCode[]; truncated: boolean }> {
  const profile = codeProfile(await loadCodeSettings(db, projectId));
  const items: UnmappedCode[] = [];
  let truncated = false;
  for await (const batch of candidates(db, batchSize, { projectId })) {
    for (const c of batch) items.push(...mapCandidate(profile, c).unmapped);
    if (items.length > MAX_REPORTED) {
      truncated = true;
      break;
    }
  }
  return { items: items.slice(0, MAX_REPORTED), truncated };
}

async function hasAudit(db: Db, projectId: string, actions: string[]): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.projectId, projectId), inArray(auditLog.action, actions)))
    .limit(1);
  return !!row;
}

export async function migrateLegacyCodes(db: Db, opts: { batchSize?: number; log?: (line: string) => void } = {}): Promise<CodesMigrationReport> {
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const log = opts.log ?? (() => undefined);
  const report: CodesMigrationReport = { schemesChosen: 0, legacyProjects: 0, versionsMapped: 0, unmapped: 0 };

  // 1. Which projects have legacy values, and which of them use R revisions.
  const usesR = new Map<string, boolean>();
  for await (const batch of candidates(db, batchSize, { untouched: true })) {
    for (const c of batch) {
      const rev = legacyCodeInputs(c.attributes).revisionCode;
      usesR.set(c.projectId, (usesR.get(c.projectId) ?? false) || (!!rev && isRRevision(rev)));
    }
  }
  if (!usesR.size) return report;

  // 2. Scheme per project, once.
  const chosen = new Map<string, CdeCodeScheme>();
  for (const [projectId, r] of usesR) {
    const settings = await loadCodeSettings(db, projectId);
    if (settings.codeScheme !== "iso_uk_na" || (await hasAudit(db, projectId, ["cde.codes_migrated", "cde.settings_updated"]))) continue;
    const scheme: CdeCodeScheme = r ? "legacy_r" : "iso_uk_na";
    if (scheme !== settings.codeScheme)
      await db
        .insert(projectCdeSettings)
        .values({ projectId, codeScheme: scheme })
        .onConflictDoUpdate({ target: projectCdeSettings.projectId, set: { codeScheme: scheme, updatedAt: new Date() } });
    chosen.set(projectId, scheme);
    report.schemesChosen++;
    if (scheme === "legacy_r") report.legacyProjects++;
  }

  // 3. Codes of the current versions.
  const profiles = new Map<string, CdeCodeProfile>();
  const mapped = new Map<string, number>();
  const now = new Date();
  for await (const batch of candidates(db, batchSize, { untouched: true })) {
    for (const c of batch) {
      let profile = profiles.get(c.projectId);
      if (!profile) profiles.set(c.projectId, (profile = codeProfile(await loadCodeSettings(db, c.projectId))));
      const m = mapCandidate(profile, c);
      if (!m.set.suitabilityCode && !m.set.revisionCode) continue;
      await db
        .update(fileVersions)
        .set({ ...m.set, codesSetAt: now })
        .where(and(eq(fileVersions.id, c.versionId), isNull(fileVersions.codesSetAt)));
      mapped.set(c.projectId, (mapped.get(c.projectId) ?? 0) + 1);
      report.versionsMapped++;
    }
    log(`codes: ${report.versionsMapped} versions mapped`);
  }

  // 4. Audit: the decision and counts, and what is left unmapped when that list changed.
  for (const projectId of usesR.keys()) {
    const { items } = await unmappedLegacyCodes(db, projectId, batchSize);
    report.unmapped += items.length;
    const scheme = chosen.get(projectId);
    if (scheme || mapped.get(projectId))
      await audit(db, {
        projectId,
        action: "cde.codes_migrated",
        targetType: "project",
        targetId: projectId,
        details: { scheme: scheme ?? profiles.get(projectId)?.scheme ?? null, schemeChosen: !!scheme, mapped: mapped.get(projectId) ?? 0, unmapped: items.length },
      });
    if (!items.length) continue;
    const digest = createHash("sha256")
      .update(JSON.stringify(items.map((i) => [i.versionId, i.field, i.value])))
      .digest("hex");
    const [last] = await db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, "cde.migration_unmapped")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    if ((last?.details as { digest?: string } | null)?.digest === digest) continue;
    await audit(db, {
      projectId,
      action: "cde.migration_unmapped",
      targetType: "project",
      targetId: projectId,
      details: { count: items.length, digest, items: items.slice(0, 100) },
    });
  }
  log(`codes: ${report.versionsMapped} mapped, ${report.unmapped} unmapped, ${report.schemesChosen} schemes chosen`);
  return report;
}
