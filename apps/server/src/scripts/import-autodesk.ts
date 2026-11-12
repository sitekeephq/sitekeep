import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { openDb } from "../db/index.js";
import { externalDocuments, externalDocumentSources, projects } from "../db/schema.js";

interface SnapshotFolder {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  createdTime: string | null;
  lastModifiedTime: string | null;
  extensionType: string | null;
}

interface SnapshotFile {
  id: string;
  folderId: string;
  name: string;
  path: string;
  createdTime: string | null;
  lastModifiedTime: string | null;
  versionNumber: number | string | null;
  extensionType: string | null;
  tipHref: string | null;
  webView: string | null;
}

interface AutodeskSnapshot {
  source: string;
  readOnly: boolean;
  fetchedAt: string;
  hub: { id: string; name: string };
  project: { id: string; name: string };
  counts: { folders: number; files: number };
  folders: SnapshotFolder[];
  files: SnapshotFile[];
}

const databaseUrl = process.env.DATABASE_URL;
const input = process.argv[2];
if (!databaseUrl || !input) {
  throw new Error(
    "Kullanım: DATABASE_URL=... CDE_PROJECT_ID=<uuid> node dist/scripts/import-autodesk.js <snapshot.json>",
  );
}

const snapshot = JSON.parse(await readFile(path.resolve(input), "utf8")) as AutodeskSnapshot;
if (
  !snapshot.readOnly ||
  !snapshot.hub?.id ||
  !snapshot.project?.id ||
  !Array.isArray(snapshot.folders) ||
  !Array.isArray(snapshot.files)
) {
  throw new Error("Geçersiz Autodesk metadata snapshot'ı.");
}

const handle = await openDb(databaseUrl);
try {
  const projectId = await resolveProjectId();
  const syncedAt = requiredDate(snapshot.fetchedAt, "fetchedAt");
  const result = await handle.db.transaction(async (tx) => {
    const [source] = await tx
      .insert(externalDocumentSources)
      .values({
        projectId,
        provider: "autodesk",
        externalHubId: snapshot.hub.id,
        externalProjectId: snapshot.project.id,
        name: snapshot.project.name,
        metadata: { hubName: snapshot.hub.name, snapshotSource: snapshot.source, readOnly: true },
        syncedAt,
      })
      .onConflictDoUpdate({
        target: [
          externalDocumentSources.projectId,
          externalDocumentSources.provider,
          externalDocumentSources.externalProjectId,
        ],
        set: {
          externalHubId: snapshot.hub.id,
          name: snapshot.project.name,
          metadata: { hubName: snapshot.hub.name, snapshotSource: snapshot.source, readOnly: true },
          syncedAt,
        },
      })
      .returning({ id: externalDocumentSources.id });
    if (!source) throw new Error("Harici doküman kaynağı oluşturulamadı.");

    await tx.delete(externalDocuments).where(eq(externalDocuments.sourceId, source.id));
    const rows: (typeof externalDocuments.$inferInsert)[] = [
      ...snapshot.folders.map((folder) => ({
        sourceId: source.id,
        externalId: folder.id,
        parentExternalId: folder.parentId,
        kind: "folder" as const,
        name: folder.name,
        path: folder.path,
        sourceCreatedAt: optionalDate(folder.createdTime),
        sourceModifiedAt: optionalDate(folder.lastModifiedTime),
        metadata: { extensionType: folder.extensionType },
      })),
      ...snapshot.files.map((file) => ({
        sourceId: source.id,
        externalId: file.id,
        parentExternalId: file.folderId,
        kind: "file" as const,
        name: file.name,
        path: file.path,
        versionNumber: optionalInteger(file.versionNumber),
        webUrl: file.webView,
        sourceCreatedAt: optionalDate(file.createdTime),
        sourceModifiedAt: optionalDate(file.lastModifiedTime),
        metadata: { extensionType: file.extensionType, tipHref: file.tipHref },
      })),
    ];
    // PGlite has a lower bind-parameter ceiling than PostgreSQL; small batches work for both.
    for (let i = 0; i < rows.length; i += 50) {
      await tx.insert(externalDocuments).values(rows.slice(i, i + 50));
    }
    return { sourceId: source.id, rows: rows.length };
  });
  console.log(
    JSON.stringify({
      ok: true,
      projectId,
      sourceId: result.sourceId,
      folders: snapshot.folders.length,
      files: snapshot.files.length,
      rows: result.rows,
    }),
  );

  async function resolveProjectId(): Promise<string> {
    const requestedId = process.env.CDE_PROJECT_ID;
    if (requestedId) {
      const [project] = await handle.db.select({ id: projects.id }).from(projects).where(eq(projects.id, requestedId));
      if (!project) throw new Error(`CDE projesi bulunamadı: ${requestedId}`);
      return project.id;
    }
    const requestedCode = process.env.CDE_PROJECT_CODE;
    if (requestedCode) {
      const [project] = await handle.db.select({ id: projects.id }).from(projects).where(and(eq(projects.code, requestedCode), eq(projects.archived, false)));
      if (!project) throw new Error(`CDE projesi bulunamadı: ${requestedCode}`);
      return project.id;
    }
    throw new Error("CDE_PROJECT_ID veya CDE_PROJECT_CODE gerekli.");
  }
} finally {
  await handle.close();
}

function optionalDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requiredDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Geçersiz tarih: ${field}`);
  return date;
}

function optionalInteger(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
