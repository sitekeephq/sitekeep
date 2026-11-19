/**
 * The full project export job (docs/features/PROJECT_EXPORT.md): streams the ZIP straight into the
 * storage under DATA_DIR (never whole in memory), every file and version hashed as it is written,
 * then the metadata parts, issues as BCF 3.0, the audit log, README.txt, manifest.json (with the
 * checksum list) and SHA256SUMS. Shares the version planning and the manifest metadata with the
 * close-out archive (closeout/collect.ts) and its limits (closeout/config.ts).
 */
import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
import {
  PROJECT_EXPORT_SCHEMA,
  can,
  splitExtension,
  type ExportFileEntry,
  type ExportVersionEntry,
  type ProjectExportCounts,
  type ProjectExportManifest,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog, issues, projectExports, users } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { audit } from "../core/platform/audit.js";
import { projectAccess, type AuthUser, type ProjectAccess } from "../core/security/access.js";
import { auditCsvLines } from "../audit/csv.js";
import { auditRows, toAuditDtos } from "../audit/query.js";
import { buildBcfZip } from "../bcf/export.js";
import { DEFAULT_LANGUAGE, msg, render, supportedLanguage, tFor } from "../i18n/index.js";
import { packageVersion } from "../admin/status.js";
import { notify } from "../workflow/service.js";
import type { CloseoutLimits } from "../closeout/config.js";
import { checkRoom } from "../closeout/build.js";
import { describeEntries } from "../closeout/collect.js";
import { HashedZip, STORED_EXTENSIONS, sha256sums } from "./zip.js";
import {
  PersonBook,
  exportScopeOf,
  foldersPart,
  membersPart,
  planExport,
  projectPart,
  reviewsPart,
  supersessionsPart,
  transmittalsPart,
  type ExportViewer,
} from "./collect.js";

export const PROJECT_EXPORT_JOB = "project_export";

/** Issues per .bcfzip in issues/ (each one is built in memory and stays under the BCF import limits). */
export const BCF_CHUNK = 500;
const PROGRESS_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExportJobDeps {
  db: Db;
  storage: Storage;
  limits: CloseoutLimits;
}

type ExportRow = typeof projectExports.$inferSelect;

/** The requester's access, read again when the job runs (a removed member exports nothing). */
export async function requesterAccess(db: Db, projectId: string, userId: string | null): Promise<ProjectAccess> {
  if (!userId) throw new Error("requester not found");
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.disabled) throw new Error("requester not found");
  const user: AuthUser = { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, companyId: u.companyId };
  return projectAccess(db, projectId, user);
}

/** Runs one export (job payload: exportId, lang). Errors mark the export failed and fail the job. */
export async function runExportJob(deps: ExportJobDeps, payload: Record<string, unknown>): Promise<void> {
  const { db, storage } = deps;
  const exportId = String(payload.exportId);
  const lang = supportedLanguage(typeof payload.lang === "string" ? payload.lang : null) ?? DEFAULT_LANGUAGE;
  const [row] = await db.select().from(projectExports).where(eq(projectExports.id, exportId));
  if (!row || (row.status !== "queued" && row.status !== "running")) return;
  await db
    .update(projectExports)
    .set({ status: "running", startedAt: new Date(), filesDone: 0, bytesDone: 0, error: null })
    .where(eq(projectExports.id, exportId));
  try {
    const result = await build(deps, row, lang);
    await finish(deps, row, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(projectExports)
      .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date(), storageKey: null })
      .where(eq(projectExports.id, exportId));
    if (row.requestedBy)
      await notify(db, [row.requestedBy], {
        projectId: row.projectId,
        kind: "project_export",
        title: msg("portability:notifications.exportFailed"),
        body: message.slice(0, 500),
        link: settingsLink(row.projectId),
      }).catch(() => undefined);
    throw err;
  }
}

const settingsLink = (projectId: string) => `/projects/${projectId}/settings?sekme=disa-aktarma`;

interface BuildResult {
  key: string;
  size: number;
  sha256: string;
  counts: ProjectExportCounts;
}

async function build(deps: ExportJobDeps, row: ExportRow, lang: string): Promise<BuildResult> {
  const { db, storage } = deps;
  const t = tFor(lang);
  const access = await requesterAccess(db, row.projectId, row.requestedBy);
  // The scope is the one asked for: a project administrator does not gain more if promoted meanwhile.
  const viewer: ExportViewer = { access, scope: row.scope === "full" && exportScopeOf(access) === "full" ? "full" : "visible" };
  const project = access.project;
  const people = new PersonBook(db);

  const { tree, entries } = await planExport(db, viewer);
  const bytesTotal = entries.reduce((n, e) => n + e.version.size, 0);
  await db.update(projectExports).set({ filesTotal: entries.length, bytesTotal }).where(eq(projectExports.id, row.id));
  const refusal = await checkRoom(storage, deps.limits, bytesTotal);
  if (refusal) throw new Error(render(lang, refusal));

  const described = await describeEntries(db, project.id, tree, entries);
  await people.load([...entries.flatMap((e) => [e.version.uploadedBy, e.version.codesSetBy, e.file.createdBy])]);
  const inExport = new Set(entries.map((e) => e.version.id));
  const pathOf = new Map(entries.map((e) => [e.version.id, e.path]));

  const zip = new HashedZip(storage, `exports/${project.id}`);
  const generatedAt = new Date();

  // Files: every version streamed and hashed; a version missing from the storage is only listed.
  const integrity = new Map<string, ExportVersionEntry["integrity"]>();
  let filesDone = 0;
  let bytesDone = 0;
  let lastProgress = 0;
  let progressChain: Promise<unknown> = Promise.resolve();
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    const values = { filesDone, bytesDone };
    progressChain = progressChain.then(() => db.update(projectExports).set(values).where(eq(projectExports.id, row.id))).catch(() => undefined);
  };
  for (const e of entries) {
    const size = await storage.size(e.version.storageKey).catch(() => null);
    if (size === null) {
      integrity.set(e.version.id, "missing");
      continue;
    }
    const ext = splitExtension(e.file.name).extension.toLowerCase();
    zip.addStream(
      e.path,
      () => storage.get(e.version.storageKey),
      { mtime: e.version.uploadedAt, compress: !STORED_EXTENSIONS.has(ext), size },
      (sum) => {
        integrity.set(e.version.id, sum.sha256 === e.version.sha256 ? "ok" : "mismatch");
        filesDone++;
        bytesDone += sum.size;
        progress();
      },
    );
  }

  // files.json: one entry per file with all its versions (written after the bytes, with their integrity).
  const versionEntries = (): ExportVersionEntry[] =>
    described.map((d, i) => {
      const v = entries[i]!.version;
      return {
        ...d,
        cdeState: entries[i]!.state,
        integrity: integrity.get(d.versionId) ?? "missing",
        uploadedByEmail: people.email(v.uploadedBy),
        comment: v.comment,
        codesSetByEmail: people.email(v.codesSetBy),
        codesSetAt: v.codesSetAt?.toISOString() ?? null,
      };
    });
  let problems = 0;
  zip.addLazy(
    "files.json",
    () => {
      const list = versionEntries();
      problems = list.filter((x) => x.integrity !== "ok").length;
      const byFile = new Map<string, ExportFileEntry>();
      for (const [i, ve] of list.entries()) {
        const e = entries[i]!;
        let f = byFile.get(e.file.id);
        if (!f) {
          f = {
            id: e.file.id,
            folderId: e.file.folderId,
            folderPath: e.folderPath,
            name: e.file.name,
            description: e.file.description,
            attributes: e.file.attributes,
            documentCode: e.file.documentCode,
            containerId: e.file.containerId,
            cdeState: e.state,
            cdeStatus: e.file.cdeStatus,
            currentVersion: e.file.currentVersion,
            createdBy: people.get(e.file.createdBy),
            createdAt: e.file.createdAt.toISOString(),
            versions: [],
          };
          byFile.set(e.file.id, f);
        }
        f.versions.push(ve);
      }
      for (const f of byFile.values()) f.versions.sort((a, b) => a.version - b.version);
      return JSON.stringify({ files: [...byFile.values()] }, null, 1);
    },
    generatedAt,
  );

  const projectJson = await projectPart(db, access);
  const folders = await foldersPart(db, tree, viewer);
  const members = await membersPart(db, project.id, people);
  const reviews = await reviewsPart(db, project.id, inExport, pathOf, viewer.scope, people);
  const transmittals = await transmittalsPart(db, viewer, inExport, pathOf, people);
  const supersessions = await supersessionsPart(db, project.id, inExport);
  const json = (v: unknown) => JSON.stringify(v, null, 1);
  zip.addLazy("project.json", () => json(projectJson), generatedAt);
  zip.addLazy("folders.json", () => json({ folders }), generatedAt);
  zip.addLazy("members.json", () => json(members), generatedAt);
  zip.addLazy("reviews.json", () => json({ reviews }), generatedAt);
  zip.addLazy("transmittals.json", () => json({ transmittals }), generatedAt);
  zip.addLazy("supersessions.json", () => json({ supersessions }), generatedAt);

  // Issues as BCF 3.0, BCF_CHUNK per package. Every member reads the issue list; header files name only
  // models the viewer can see.
  const [{ n: issueCount } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(eq(issues.projectId, project.id));
  const memberEmails = members.members.map((m) => m.email).filter((x): x is string => !!x);
  const canSeeFolder = (folderId: string) => viewer.scope === "full" || !tree.byId.has(folderId) || can(tree.permission(access.principal, folderId).level, "view");
  const bcfParts: string[] = [];
  for (let i = 0; i * BCF_CHUNK < issueCount; i++) {
    const name = `issues/issues-${String(i + 1).padStart(4, "0")}.bcfzip`;
    bcfParts.push(name);
    zip.addLazy(
      name,
      async () => {
        const rows = await db.select().from(issues).where(eq(issues.projectId, project.id)).orderBy(asc(issues.number)).limit(BCF_CHUNK).offset(i * BCF_CHUNK);
        return (await buildBcfZip({ db, storage, canSeeFolder }, project, rows, "3.0", memberEmails, { lang })).zip;
      },
      generatedAt,
      false,
    );
  }

  // The audit log (no IP address or user agent: personal data with its own retention period).
  const auditWhere = eq(auditLog.projectId, project.id);
  const auditViewer = viewer.scope === "full" ? undefined : { tree, principal: access.principal };
  let auditCount = 0;
  zip.addLines("audit/audit-log.csv", () => auditCsvLines(db, auditWhere, t, { client: false, viewer: auditViewer }), generatedAt);
  zip.addLines(
    "audit/audit-log.json",
    async function* () {
      yield "[";
      let first = true;
      for await (const rows of auditRows(db, auditWhere)) {
        for (const e of await toAuditDtos(db, rows, { client: false, viewer: auditViewer })) {
          auditCount++;
          yield `${first ? "\n" : ",\n"}${JSON.stringify(e)}`;
          first = false;
        }
      }
      yield "\n]\n";
    },
    generatedAt,
  );

  const counts = (): ProjectExportCounts => ({
    folders: folders.length,
    files: new Set(entries.map((e) => e.file.id)).size,
    versions: entries.length,
    bytes: bytesTotal,
    issues: issueCount,
    reviews: reviews.length,
    transmittals: transmittals.length,
    members: members.members.length,
    roles: members.roles.length,
    auditRows: auditCount,
    problems,
  });
  const [requester] = row.requestedBy ? await db.select().from(users).where(eq(users.id, row.requestedBy)) : [];
  zip.addLazy("README.txt", () => readme(t, { project, requester: requester?.name ?? null, generatedAt: generatedAt.toISOString(), scope: viewer.scope, counts: counts() }), generatedAt);

  let manifestCounts: ProjectExportCounts | null = null;
  zip.addLazy(
    "manifest.json",
    () => {
      manifestCounts = counts();
      const manifest: ProjectExportManifest = {
        schema: PROJECT_EXPORT_SCHEMA,
        generatedAt: generatedAt.toISOString(),
        generator: { product: "SiteKeep", version: packageVersion() ?? "unknown" },
        project: { id: project.id, code: project.code, name: project.name },
        exportedBy: requester ? { id: requester.id, email: requester.email, name: requester.name } : null,
        scope: viewer.scope,
        counts: manifestCounts,
        contents: {
          project: "project.json",
          folders: "folders.json",
          files: "files.json",
          members: "members.json",
          reviews: "reviews.json",
          transmittals: "transmittals.json",
          supersessions: "supersessions.json",
          issues: bcfParts,
          auditCsv: "audit/audit-log.csv",
          auditJson: "audit/audit-log.json",
        },
        checksums: [...zip.sums],
      };
      return JSON.stringify(manifest, null, 1);
    },
    generatedAt,
  );
  zip.addLazy("SHA256SUMS", () => sha256sums(zip.sums), generatedAt);

  const stored = await zip.end();
  progress(true);
  await progressChain;
  return { key: stored.key, size: stored.size, sha256: stored.sha256, counts: manifestCounts ?? counts() };
}

function readme(
  t: ReturnType<typeof tFor>,
  d: { project: { code: string; name: string }; requester: string | null; generatedAt: string; scope: string; counts: ProjectExportCounts },
): string {
  const c = d.counts;
  return (
    [
      t("portability:readme.title"),
      "",
      t("portability:readme.project", { code: d.project.code, name: d.project.name }),
      t("portability:readme.created", { at: d.generatedAt, user: d.requester ?? "—" }),
      d.scope === "full" ? t("portability:readme.scopeFull") : t("portability:readme.scopeVisible"),
      t("portability:readme.counts", { files: c.files, versions: c.versions, bytes: c.bytes, issues: c.issues }),
      "",
      t("portability:readme.purpose", { schema: PROJECT_EXPORT_SCHEMA }),
      "",
      t("portability:readme.contents"),
      `  manifest.json            ${t("portability:readme.manifest")}`,
      `  SHA256SUMS               ${t("portability:readme.sums")}`,
      `  project.json             ${t("portability:readme.projectJson")}`,
      `  folders.json             ${t("portability:readme.folders")}`,
      `  files.json               ${t("portability:readme.filesJson")}`,
      `  files/                   ${t("portability:readme.files")}`,
      `  members.json             ${t("portability:readme.members")}`,
      `  reviews.json             ${t("portability:readme.reviews")}`,
      `  transmittals.json        ${t("portability:readme.transmittals")}`,
      `  supersessions.json       ${t("portability:readme.supersessions")}`,
      `  issues/*.bcfzip          ${t("portability:readme.issues")}`,
      `  audit/audit-log.csv|json ${t("portability:readme.audit")}`,
      "",
      t("portability:readme.check"),
    ].join("\r\n") + "\r\n"
  );
}

async function finish(deps: ExportJobDeps, row: ExportRow, r: BuildResult): Promise<void> {
  const { db } = deps;
  const now = new Date();
  await db
    .update(projectExports)
    .set({
      status: "done",
      finishedAt: now,
      storageKey: r.key,
      size: r.size,
      sha256: r.sha256,
      counts: r.counts,
      filesDone: r.counts.versions - r.counts.problems,
      bytesDone: r.counts.bytes,
      expiresAt: new Date(now.getTime() + deps.limits.retentionDays * DAY_MS),
    })
    .where(eq(projectExports.id, row.id));
  await audit(db, {
    projectId: row.projectId,
    userId: row.requestedBy,
    action: "project.exported",
    targetType: "project_export",
    targetId: row.id,
    details: { scope: row.scope, counts: r.counts, size: r.size, sha256: r.sha256, schema: PROJECT_EXPORT_SCHEMA },
  });
  if (row.requestedBy)
    await notify(db, [row.requestedBy], {
      projectId: row.projectId,
      kind: "project_export",
      title: msg("portability:notifications.exportReady"),
      body: msg("portability:notifications.exportReadyBody", { files: r.counts.files, versions: r.counts.versions, issues: r.counts.issues }),
      link: settingsLink(row.projectId),
    });
}

/** Deletes the files of exports past their download period; the rows stay ("expired"). */
export async function sweepProjectExports(db: Db, storage: Storage, now = new Date()): Promise<number> {
  const due = await db
    .select({ id: projectExports.id, key: projectExports.storageKey })
    .from(projectExports)
    .where(and(eq(projectExports.status, "done"), lt(projectExports.expiresAt, now)));
  if (!due.length) return 0;
  for (const d of due) if (d.key) await storage.remove(d.key).catch(() => undefined);
  await db
    .update(projectExports)
    .set({ status: "expired", storageKey: null })
    .where(inArray(projectExports.id, due.map((d) => d.id)));
  return due.length;
}

/** Hourly clean-up of expired exports and of uploads of finished restores (index.ts). */
export function startPortabilityCleanup(db: Db, storage: Storage, opts: { log?: (m: string, e?: unknown) => void } = {}): () => void {
  const run = () => void sweepProjectExports(db, storage).catch((e) => opts.log?.("project export clean-up failed", e));
  const first = setTimeout(run, 45_000);
  const timer = setInterval(run, 60 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
