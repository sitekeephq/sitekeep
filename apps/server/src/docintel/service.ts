/** Document intelligence: background extraction job and read helpers used by the routes. */
import { and, eq } from "drizzle-orm";
import { splitExtension, type AntetResult, type RevisionInfo, type VersionDocIntelDto } from "@sitekeep/shared";
import { FolderTree } from "../core/security/access.js";
import { resolveProvider, type AiProvider } from "../ai/provider.js";
import type { Db } from "../db/index.js";
import { docExtractions, fileVersions, files, specRegisters } from "../db/schema.js";
import { effectiveDefinitions } from "../modules/documents/public.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";
import type { Storage } from "../core/platform/storage.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import { analyzeAntet, antetNote } from "./antet.js";
import { extractPdfText, pdfErrorText } from "./extract.js";
import { detectRevision, isRevisionAttribute, revisionWarnings, type PreviousVersion } from "./revision.js";
import { suggestNaming, type SuggestInput } from "./suggest.js";
import { fold } from "./text.js";

type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;
type ExtractionRow = typeof docExtractions.$inferSelect;

export const EXTRACT_JOB = "docintel_extract";

export function isPdf(name: string): boolean {
  return splitExtension(name).extension.toLowerCase() === "pdf";
}

/** Revision attribute value of a file (first attribute named like "Revizyon"). */
export function revisionAttribute(attributes: Record<string, string>): string | null {
  const k = Object.keys(attributes).find(isRevisionAttribute);
  return k ? (attributes[k] ?? null) : null;
}

async function previousVersion(db: Db, file: FileRow, version: VersionRow): Promise<PreviousVersion | null> {
  if (version.version <= 1) return null;
  const [row] = await db
    .select({ v: fileVersions, x: docExtractions })
    .from(fileVersions)
    .leftJoin(docExtractions, eq(docExtractions.versionId, fileVersions.id))
    .where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.version, version.version - 1)));
  if (!row) return null;
  return { version: row.v.version, sha256: row.v.sha256, revision: row.x?.effectiveRevision ?? null };
}

/** Job: reads the title block of a PDF version and records revision warnings. */
export async function processVersion(db: Db, storage: Storage, versionId: string): Promise<void> {
  const [row] = await db
    .select({ v: fileVersions, f: files })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(fileVersions.id, versionId));
  if (!row) throw new Error(`Version ${versionId} not found`);
  const { v, f } = row;
  const upsert = async (set: Partial<typeof docExtractions.$inferInsert>) => {
    await db
      .insert(docExtractions)
      .values({ versionId, projectId: f.projectId, ...set })
      .onConflictDoUpdate({ target: docExtractions.versionId, set: { ...set, updatedAt: new Date() } });
  };
  if (!isPdf(f.name)) {
    await upsert({ status: "unsupported", error: null });
    return;
  }
  await upsert({ status: "processing", error: null });
  try {
    const out = await extractPdfText({ filePath: storage.localPath(v.storageKey) }, { maxPages: 1, timeoutMs: 120_000 });
    const antet = analyzeAntet(out);
    const isCurrent = v.version === f.currentVersion;
    const attr = isCurrent ? revisionAttribute(f.attributes) : null;
    const revision = detectRevision(antet, f.name);
    const prev = await previousVersion(db, f, v);
    const warnings = revisionWarnings(revision, { sha256: v.sha256, version: v.version }, prev, attr);
    await upsert({
      status: "done",
      antet,
      revision,
      warnings,
      effectiveRevision: revision.value ?? attr ?? null,
      pageCount: out.pageCount,
      error: null,
    });
  } catch (err) {
    const message = pdfErrorText(err);
    await upsert({ status: "failed", error: message.slice(0, 500) });
    throw err;
  }
}

/** True when a language model can be used for this project (mode, policy and provider). */
export async function aiProviderFor(db: Db, secretKey: Buffer, projectId: string): Promise<AiProvider | null> {
  try {
    return await resolveProvider(db, secretKey, projectId);
  } catch {
    return null;
  }
}

/** Context for naming suggestions in a folder. */
export async function suggestContext(db: Db, tree: FolderTree, folderId: string) {
  const standard = await standardForFolder(db, tree, folderId);
  const defs = await effectiveDefinitions(db, tree, folderId);
  const folderNames = tree.ancestry(folderId).map((id) => tree.get(id).name);
  return { standard, defs, folderNames };
}

export function buildSuggestInput(
  ctx: Awaited<ReturnType<typeof suggestContext>>,
  fileName: string,
  antet: AntetResult | null,
  revision: RevisionInfo | null,
  currentAttributes?: Record<string, string>,
  lang?: string,
): SuggestInput {
  return {
    standard: ctx.standard,
    fileName,
    antet,
    revision,
    folderNames: ctx.folderNames,
    attributeDefs: ctx.defs,
    currentAttributes,
    lang,
  };
}

/** Spec context: the name or folder path mentions a specification, or the first page is running text. */
export function looksLikeSpec(fileName: string, folderNames: string[], antet: AntetResult | null, pageCount: number | null): boolean {
  const text = fold([fileName, ...folderNames].join(" "));
  if (/(sartname|spesifikasyon|specification|\bspec\b|teknik sart)/.test(text)) return true;
  return antet?.kind === "text" && (pageCount ?? 0) >= 3;
}

/** Everything the file drawer shows for one version. */
export async function versionDocIntel(
  db: Db,
  tree: FolderTree,
  file: FileRow,
  version: VersionRow,
  aiAvailable: boolean,
  lang: string = DEFAULT_LANGUAGE,
): Promise<VersionDocIntelDto> {
  const [x]: (ExtractionRow | undefined)[] = await db.select().from(docExtractions).where(eq(docExtractions.versionId, version.id));
  const [reg] = await db.select({ id: specRegisters.id }).from(specRegisters).where(eq(specRegisters.versionId, version.id));
  const ctx = await suggestContext(db, tree, file.folderId);
  const base: VersionDocIntelDto = {
    versionId: version.id,
    fileId: file.id,
    version: version.version,
    status: x?.status ?? (isPdf(file.name) ? "pending" : "unsupported"),
    error: x?.error ?? null,
    // The stored note is in the language of the extraction job; shown in the reader's.
    antet: x?.antet ? { ...x.antet, note: antetNote(x.antet, lang) } : null,
    revision: x?.revision ?? null,
    warnings: x?.warnings ?? [],
    suggestion: null,
    specLike: looksLikeSpec(file.name, ctx.folderNames, x?.antet ?? null, x?.pageCount ?? null),
    registerId: reg?.id ?? null,
    aiAvailable,
    updatedAt: x?.updatedAt.toISOString() ?? null,
  };
  if (!x || x.status !== "done") return base;
  const isCurrent = version.version === file.currentVersion;
  // Warnings are recomputed so that later attribute edits are reflected.
  const attr = isCurrent ? revisionAttribute(file.attributes) : null;
  const prev = await previousVersion(db, file, version);
  const revision = x.revision ?? detectRevision(x.antet, file.name);
  base.warnings = revisionWarnings(revision, { sha256: version.sha256, version: version.version }, prev, attr, lang);
  base.suggestion = suggestNaming(buildSuggestInput(ctx, file.name, x.antet, revision, file.attributes, lang));
  return base;
}
