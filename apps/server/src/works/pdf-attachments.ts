import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { TRANSMITTAL_PURPOSE_LABELS_TR, type WorkEventKind } from "@sitekeep/shared";
import { FolderTree } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, labelFor, msg } from "../i18n/index.js";
import type { StoredObject } from "../core/platform/storage.js";
import type { Db } from "../db/index.js";
import { fileVersions, files, folders, projects, users, workLinks } from "../db/schema.js";
import { letterPdf } from "./letter-pdf.js";
import { isOutgoingLetter, letterDay, letterOf, letterReferences, pdfFileName } from "./letter.js";
import { revisionOf } from "./links.js";
import { transmittalCoverPdf } from "./pdf.js";
import {
  COVER_FOLDER_NAME,
  COVER_FOLDER_OLD_NAMES,
  INTAKE_FOLDER_NAME,
  LETTER_FOLDER_NAME,
  addEvent,
  companyNames,
  type TypeRow,
  type WorkRow,
  type WorksCtx,
} from "./work-core.js";

async function pdfFolder(
  db: Db,
  project: typeof projects.$inferSelect,
  type: TypeRow,
  userId: string,
  name: string,
  oldNames: readonly string[] = [],
): Promise<string> {
  const tree = await FolderTree.load(db, project.id);
  const configured = type.settings.coverFolderId;
  if (configured && tree.byId.has(configured)) return configured;
  const rootId = project.rootFolderId!;
  const kids = tree.children.get(rootId) ?? [];
  const existing = kids.find((f) => f.name === name) ?? kids.find((f) => oldNames.includes(f.name));
  if (existing) return existing.id;
  const [row] = await db
    .insert(folders)
    .values({ projectId: project.id, parentId: rootId, name, createdBy: userId })
    .onConflictDoNothing()
    .returning();
  if (row) return row.id;
  const [again] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.parentId, rootId), eq(folders.name, name), isNull(folders.deletedAt)));
  return again!.id;
}

export async function generateCover(
  ctx: WorksCtx,
  project: typeof projects.$inferSelect,
  work: WorkRow,
  type: TypeRow,
  actorId: string,
  lang: string = DEFAULT_LANGUAGE,
): Promise<{ fileId: string; versionId: string; version: number }> {
  const { db } = ctx;
  if (type.category !== "transmittal") throw badRequest(msg("works:errors.coverTransmittalOnly"));
  const links = await db.select().from(workLinks).where(eq(workLinks.workId, work.id));
  const versionIds = links.filter((l) => l.kind === "file_version" && l.role === "ek").map((l) => l.targetId);
  const rows = versionIds.length
    ? await db
        .select({ v: fileVersions, f: files })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(inArray(fileVersions.id, versionIds))
        .orderBy(asc(files.name))
    : [];
  const names = await companyNames(db, [work.fromCompanyId, ...work.toCompanyIds, ...work.ccCompanyIds]);
  const [creator] = await db.select({ name: users.name }).from(users).where(eq(users.id, work.createdBy));
  const purpose = typeof work.fields.amac === "string" ? work.fields.amac : "bilgi";
  const pdf = await transmittalCoverPdf({
    projectCode: project.code,
    projectName: project.name,
    number: work.number,
    title: work.title,
    date: new Date(),
    purpose: purpose in TRANSMITTAL_PURPOSE_LABELS_TR ? labelFor(lang, "transmittalPurpose", purpose) : purpose,
    from: work.fromCompanyId ? (names.get(work.fromCompanyId) ?? null) : null,
    to: work.toCompanyIds.map((c) => names.get(c) ?? c),
    cc: work.ccCompanyIds.map((c) => names.get(c) ?? c),
    note: typeof work.fields.not === "string" ? work.fields.not : null,
    files: rows.map((r) => ({ name: r.f.name, version: r.v.version, revision: revisionOf(r.f.attributes) })),
    createdBy: creator?.name ?? "",
    lang,
  });
  return storeWorkPdf(ctx, project, work, type, actorId, pdf, {
    folderName: COVER_FOLDER_NAME,
    oldFolderNames: COVER_FOLDER_OLD_NAMES,
    comment: `${work.number} gönderim formu kapak sayfası`, // i18n-ok: version comment stored as data
    event: "cover_pdf",
  });
}

async function storeWorkPdf(
  ctx: WorksCtx,
  project: typeof projects.$inferSelect,
  work: WorkRow,
  type: TypeRow,
  actorId: string,
  pdf: Uint8Array,
  o: { folderName: string; oldFolderNames?: readonly string[]; comment: string; event: WorkEventKind },
): Promise<{ fileId: string; versionId: string; version: number }> {
  const { db, storage } = ctx;
  const folderId = await pdfFolder(db, project, type, actorId, o.folderName, o.oldFolderNames);
  const obj = await storage.putBytes(pdf, `projects/${project.id}/files`);
  const name = pdfFileName(work.number);
  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(files)
      .where(and(eq(files.folderId, folderId), eq(files.name, name), isNull(files.deletedAt)));
    let file = existing;
    let versionNo = 1;
    if (existing) {
      versionNo = existing.currentVersion + 1;
      [file] = await tx.update(files).set({ currentVersion: versionNo }).where(eq(files.id, existing.id)).returning();
    } else {
      [file] = await tx
        .insert(files)
        .values({ projectId: project.id, folderId, name, attributes: {}, createdBy: actorId })
        .returning();
    }
    const [version] = await tx
      .insert(fileVersions)
      .values({
        fileId: file!.id,
        version: versionNo,
        storageKey: obj.key,
        size: obj.size,
        sha256: obj.sha256,
        uploadedBy: actorId,
        comment: o.comment,
      })
      .returning();
    await tx.delete(workLinks).where(and(eq(workLinks.workId, work.id), eq(workLinks.role, "kapak")));
    await tx.insert(workLinks).values({
      workId: work.id,
      kind: "file_version",
      targetId: version!.id,
      role: "kapak",
      meta: {},
      createdBy: actorId,
    });
    return { fileId: file!.id, versionId: version!.id, version: version!.version };
  });
  await addEvent(db, work.id, o.event, actorId, `${name} V${out.version}`, { fileId: out.fileId, versionId: out.versionId });
  await audit(db, {
    projectId: project.id,
    userId: actorId,
    action: out.version === 1 ? "file.uploaded" : "file.version_added",
    targetType: "file",
    targetId: out.fileId,
    details: { name, version: out.version, size: obj.size, folderId, workId: work.id, system: true },
  });
  return out;
}

export async function attachSourceFile(
  ctx: WorksCtx,
  project: typeof projects.$inferSelect,
  work: WorkRow,
  type: TypeRow,
  actorId: string,
  obj: StoredObject,
  originalName: string,
): Promise<{ fileId: string; versionId: string }> {
  const { db } = ctx;
  const folderId = await pdfFolder(db, project, type, actorId, type.category === "correspondence" ? LETTER_FOLDER_NAME : INTAKE_FOLDER_NAME);
  const safe = originalName.replace(/[\\/<>:"|?*\x00-\x1f]/g, "_").trim().slice(0, 180) || "dosya";
  const name = `${work.number.replace(/[\\/<>:"|?*\x00-\x1f]/g, "_")}_${safe}`;
  const out = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(files)
      .where(and(eq(files.folderId, folderId), eq(files.name, name), isNull(files.deletedAt)));
    let file = existing;
    let versionNo = 1;
    if (existing) {
      versionNo = existing.currentVersion + 1;
      [file] = await tx.update(files).set({ currentVersion: versionNo }).where(eq(files.id, existing.id)).returning();
    } else {
      [file] = await tx.insert(files).values({ projectId: project.id, folderId, name, attributes: {}, createdBy: actorId }).returning();
    }
    const [version] = await tx
      .insert(fileVersions)
      .values({
        fileId: file!.id,
        version: versionNo,
        storageKey: obj.key,
        size: obj.size,
        sha256: obj.sha256,
        uploadedBy: actorId,
        comment: `${work.number} kaynak dosyası`, // i18n-ok: version comment stored as data
      })
      .returning();
    await tx.insert(workLinks).values({ workId: work.id, kind: "file_version", targetId: version!.id, role: "ek", meta: {}, createdBy: actorId });
    return { fileId: file!.id, versionId: version!.id };
  });
  await addEvent(db, work.id, "linked", actorId, name, { links: [{ kind: "file_version", role: "ek", targetId: out.versionId }], source: true });
  await audit(db, {
    projectId: project.id,
    userId: actorId,
    action: "file.uploaded",
    targetType: "file",
    targetId: out.fileId,
    details: { name, size: obj.size, folderId, workId: work.id, system: true, intake: true },
  });
  return out;
}

export async function buildLetterPdf(
  db: Db,
  project: typeof projects.$inferSelect,
  work: WorkRow,
  type: TypeRow,
  date?: string | Date,
): Promise<Uint8Array> {
  if (!isOutgoingLetter(type)) throw badRequest(msg("works:errors.letterPdfOutgoingOnly"));
  const names = await companyNames(db, [work.fromCompanyId, work.ownerCompanyId]);
  const company = names.get(work.fromCompanyId ?? "") ?? names.get(work.ownerCompanyId ?? "") ?? project.name;
  const str = (k: string) => {
    const v = work.fields[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return letterPdf({
    company,
    projectCode: project.code,
    projectName: project.name,
    number: work.number,
    date: date ?? letterDay(work),
    title: work.title,
    letter: letterOf(work),
    projectRef: str("proje_kodu"),
    docNo: str("belge_no") ?? str("sayi"),
    references: await letterReferences(db, work.id),
  });
}

export async function generateLetterPdf(
  ctx: WorksCtx,
  project: typeof projects.$inferSelect,
  work: WorkRow,
  type: TypeRow,
  actorId: string,
): Promise<{ fileId: string; versionId: string; version: number }> {
  const pdf = await buildLetterPdf(ctx.db, project, work, type, letterDay({ ...work, sentAt: work.sentAt ?? new Date() }));
  return storeWorkPdf(ctx, project, work, type, actorId, pdf, {
    folderName: LETTER_FOLDER_NAME,
    comment: `${work.number} resmi yazı`, // i18n-ok: version comment stored as data
    event: "letter_pdf",
  });
}
