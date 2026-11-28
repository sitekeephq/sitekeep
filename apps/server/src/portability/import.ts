/**
 * Restore of a full project export as a NEW project (docs/features/PROJECT_EXPORT.md#restore). The
 * uploaded package is read from the storage (random access, entry by entry: nothing is held whole in
 * memory but the metadata parts) in two passes:
 *   1. verify: SHA256SUMS, manifest.json and every entry are checked against each other and every
 *      entry is hashed; any mismatch, missing or unlisted entry refuses the package before anything
 *      is written;
 *   2. import: project, folders (states, permissions), naming standards, CDE settings, members (by
 *      e-mail; unknown people are listed in the report, never created), roles and task teams, files
 *      with every version and their codes, document codes, ISO-12 supersession links and the issues
 *      (BCF 3.0, through the BCF import). Ids are new; nothing existing is changed.
 * A restore that fails after the project was created leaves it deleted (archived, code freed).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, eq, inArray, sql } from "drizzle-orm";
import yauzl from "yauzl";
import {
  PROJECT_EXPORT_SCHEMA,
  type ExportFileEntry,
  type ExportFolderEntry,
  type ProjectExportManifest,
  type ProjectImportReport,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import {
  cdeSupersessions,
  companies,
  documentCodes,
  fileVersions,
  files,
  folderGrants,
  folderSettings,
  folders,
  memberRoles,
  namingStandards,
  projectCdeSettings,
  projectImports,
  projectMembers,
  projectRoles,
  projects,
  users,
} from "../db/schema.js";
import type { LocalCopy, Storage } from "../core/platform/storage.js";
import type { JobQueue } from "../jobs/queue.js";
import { audit } from "../core/platform/audit.js";
import { projectAccess, type AuthUser } from "../core/security/access.js";
import { ensureCdeSettings } from "../cde/settings.js";
import { normalizeDocumentCode } from "../cde/document-code.js";
import { isModelFile } from "../files/model-formats.js";
import { queueVersionWork } from "../files/new-version.js";
import { commitImport, fileKey, parseBcfPackage } from "../bcf/import.js";
import { BCF_ZIP_LIMITS, unsafeEntryName } from "../bcf/unzip.js";
import { DEFAULT_LANGUAGE, msg, render, supportedLanguage, tFor, type Msg } from "../i18n/index.js";
import { notify } from "../workflow/service.js";
import { chunks } from "../closeout/collect.js";
import { parseSha256sums } from "./zip.js";

export const PROJECT_IMPORT_JOB = "project_import";

/** Limits for an untrusted package (the files themselves are only streamed, never held). */
export const IMPORT_LIMITS = {
  entries: 2_000_000,
  /** One metadata part (JSON, SHA256SUMS) read into memory. */
  partBytes: 512 * 1024 * 1024,
};

const PROGRESS_MS = 1000;

/** A refused package: the reason is shown on the restore row (in the requester's language). */
export class PackageError extends Error {
  constructor(readonly reason: Msg) {
    super(render(DEFAULT_LANGUAGE, reason));
    this.name = "PackageError";
  }
}

export interface ImportJobDeps {
  db: Db;
  storage: Storage;
  jobs: JobQueue;
}

type ImportRow = typeof projectImports.$inferSelect;

// ---- Reading the package ----------------------------------------------------------------------

/** The package opened for random access: entries by name, each readable as a stream. */
export class PackageReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    readonly entries: Map<string, yauzl.Entry>,
  ) {}

  static open(file: string): Promise<PackageReader> {
    return new Promise((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true, strictFileNames: true }, (err, zip) => {
        if (err || !zip) return reject(new PackageError(msg("portability:import.notZip", { detail: err?.message ?? "" })));
        const entries = new Map<string, yauzl.Entry>();
        let failed = false;
        const fail = (e: Error) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(e instanceof PackageError ? e : new PackageError(msg("portability:import.notZip", { detail: e.message })));
        };
        zip.on("error", fail);
        zip.on("entry", (entry: yauzl.Entry) => {
          const name = entry.fileName;
          if (entries.size >= IMPORT_LIMITS.entries) return fail(new PackageError(msg("portability:import.tooManyEntries", { max: IMPORT_LIMITS.entries })));
          if (unsafeEntryName(name)) return fail(new PackageError(msg("portability:import.unsafePath", { name: name.slice(0, 200) })));
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) return fail(new PackageError(msg("portability:import.unsafePath", { name })));
          if (!name.endsWith("/")) {
            if (entries.has(name)) return fail(new PackageError(msg("portability:import.duplicateEntry", { name })));
            entries.set(name, entry);
          }
          zip.readEntry();
        });
        zip.on("end", () => {
          if (!failed) resolve(new PackageReader(zip, entries));
        });
        zip.readEntry();
      });
    });
  }

  stream(name: string): Promise<Readable> {
    const entry = this.entries.get(name);
    if (!entry) return Promise.reject(new PackageError(msg("portability:import.missingEntry", { name })));
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error("read failed")) : resolve(s)));
    });
  }

  /** A whole entry in memory (metadata parts), with a size limit. */
  async buffer(name: string, limit = IMPORT_LIMITS.partBytes): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) throw new PackageError(msg("portability:import.missingEntry", { name }));
    if (entry.uncompressedSize > limit) throw new PackageError(msg("portability:import.partTooLarge", { name }));
    const chunksIn: Buffer[] = [];
    let n = 0;
    for await (const c of await this.stream(name)) {
      n += (c as Buffer).length;
      if (n > limit) throw new PackageError(msg("portability:import.partTooLarge", { name }));
      chunksIn.push(c as Buffer);
    }
    return Buffer.concat(chunksIn);
  }

  async json<T>(name: string): Promise<T> {
    try {
      return JSON.parse((await this.buffer(name)).toString("utf8")) as T;
    } catch (e) {
      if (e instanceof PackageError) throw e;
      throw new PackageError(msg("portability:import.badJson", { name }));
    }
  }

  async sha256(name: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const c of await this.stream(name)) hash.update(c as Buffer);
    return hash.digest("hex");
  }

  close(): void {
    this.zip.close();
  }
}

/**
 * Pass 1: the package is complete and unchanged. SHA256SUMS lists every entry but itself, the
 * manifest's checksum list agrees with it, and every entry hashes to its listed value.
 */
export async function verifyPackage(pkg: PackageReader, onProgress?: (done: number, total: number) => void): Promise<ProjectExportManifest> {
  if (!pkg.entries.has("SHA256SUMS")) throw new PackageError(msg("portability:import.missingEntry", { name: "SHA256SUMS" }));
  if (!pkg.entries.has("manifest.json")) throw new PackageError(msg("portability:import.missingEntry", { name: "manifest.json" }));
  const sums = parseSha256sums((await pkg.buffer("SHA256SUMS")).toString("utf8"));
  if (!sums) throw new PackageError(msg("portability:import.badSums"));
  const manifestSum = sums.get("manifest.json");
  if (!manifestSum || manifestSum !== (await pkg.sha256("manifest.json"))) throw new PackageError(msg("portability:import.checksumMismatch", { name: "manifest.json" }));
  const manifest = await pkg.json<ProjectExportManifest>("manifest.json");
  if (manifest?.schema !== PROJECT_EXPORT_SCHEMA) throw new PackageError(msg("portability:import.wrongSchema", { schema: String(manifest?.schema ?? "?"), expected: PROJECT_EXPORT_SCHEMA }));
  // Entries and both lists name the same files.
  for (const name of pkg.entries.keys()) if (name !== "SHA256SUMS" && !sums.has(name)) throw new PackageError(msg("portability:import.unlistedEntry", { name }));
  for (const name of sums.keys()) if (!pkg.entries.has(name)) throw new PackageError(msg("portability:import.missingEntry", { name }));
  const listed = new Map((manifest.checksums ?? []).map((c) => [c.path, c.sha256]));
  for (const [name, hash] of sums) {
    if (name === "manifest.json") continue;
    if (listed.get(name) !== hash) throw new PackageError(msg("portability:import.checksumMismatch", { name }));
  }
  if (listed.size !== sums.size - 1) throw new PackageError(msg("portability:import.badSums"));
  // Every entry hashed (streamed).
  const names = [...sums.keys()].filter((n) => n !== "manifest.json");
  let done = 0;
  for (const name of names) {
    if ((await pkg.sha256(name)) !== sums.get(name)) throw new PackageError(msg("portability:import.checksumMismatch", { name }));
    onProgress?.(++done, names.length);
  }
  return manifest;
}

// ---- The job -----------------------------------------------------------------------------------

/** Runs one restore (job payload: importId, lang). Errors mark it failed and fail the job. */
export async function runImportJob(deps: ImportJobDeps, payload: Record<string, unknown>): Promise<void> {
  const { db, storage } = deps;
  const importId = String(payload.importId);
  const lang = supportedLanguage(typeof payload.lang === "string" ? payload.lang : null) ?? DEFAULT_LANGUAGE;
  const [row] = await db.select().from(projectImports).where(eq(projectImports.id, importId));
  if (!row || (row.status !== "queued" && row.status !== "running")) return;
  await db
    .update(projectImports)
    .set({ status: "running", startedAt: new Date(), phase: "verify", filesDone: 0, error: null })
    .where(eq(projectImports.id, importId));
  let pkg: PackageReader | null = null;
  let upload: LocalCopy | null = null;
  let projectId: string | null = null;
  try {
    if (!row.uploadKey) throw new PackageError(msg("portability:import.uploadGone"));
    upload = await storage.acquireLocal(row.uploadKey);
    pkg = await PackageReader.open(upload.path);
    const progress = throttle(async (done: number, total: number) => {
      await db.update(projectImports).set({ filesDone: done, filesTotal: total }).where(eq(projectImports.id, importId));
    });
    const manifest = await verifyPackage(pkg, progress);
    await progress.flush();
    await db.update(projectImports).set({ phase: "import", filesDone: 0 }).where(eq(projectImports.id, importId));
    const result = await restore(deps, row, pkg, manifest, lang, (id) => (projectId = id));
    await db
      .update(projectImports)
      .set({ status: "done", finishedAt: new Date(), projectId: result.projectId, report: result.report, phase: null })
      .where(eq(projectImports.id, importId));
    await audit(db, {
      projectId: result.projectId,
      userId: row.requestedBy,
      action: "project.imported",
      targetType: "project_import",
      targetId: row.id,
      details: {
        source: result.report.source,
        counts: result.report.counts,
        unknownUsers: result.report.unknownUsers.length,
        unknownCompanies: result.report.unknownCompanies.length,
        skippedGrants: result.report.skippedGrants,
        package: { fileName: row.fileName, size: row.size, sha256: row.sha256 },
      },
    });
    if (row.requestedBy)
      await notify(db, [row.requestedBy], {
        projectId: result.projectId,
        kind: "project_import",
        title: msg("portability:notifications.importReady"),
        body: msg("portability:notifications.importReadyBody", { code: row.code, unknown: result.report.unknownUsers.length }),
        link: `/projects/${result.projectId}`,
      });
  } catch (err) {
    const message = err instanceof PackageError ? render(lang, err.reason) : err instanceof Error ? err.message : String(err);
    // A half-restored project is deleted (archived: hidden, code freed); the package is kept for a retry.
    if (projectId) await db.update(projects).set({ archived: true }).where(eq(projects.id, projectId)).catch(() => undefined);
    await db
      .update(projectImports)
      .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date(), phase: null })
      .where(eq(projectImports.id, importId));
    if (row.requestedBy)
      await notify(db, [row.requestedBy], { projectId: null, kind: "project_import", title: msg("portability:notifications.importFailed"), body: message.slice(0, 500), link: "/admin/projects" }).catch(
        () => undefined,
      );
    throw err;
  } finally {
    pkg?.close();
    await upload?.release().catch(() => {});
  }
  // The package is not needed any more once the project exists.
  if (row.uploadKey) {
    await storage.remove(row.uploadKey).catch(() => undefined);
    await db.update(projectImports).set({ uploadKey: null }).where(eq(projectImports.id, importId));
  }
}

function throttle(fn: (done: number, total: number) => Promise<void>) {
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let pending: [number, number] | null = null;
  const run = (done: number, total: number) => {
    pending = [done, total];
    const now = Date.now();
    if (now - last < PROGRESS_MS) return;
    last = now;
    const [d, t] = pending;
    pending = null;
    chain = chain.then(() => fn(d, t)).catch(() => undefined);
  };
  return Object.assign(run, {
    flush: async () => {
      if (pending) {
        const [d, t] = pending;
        pending = null;
        chain = chain.then(() => fn(d, t)).catch(() => undefined);
      }
      await chain;
    },
  });
}

interface MembersPart {
  companies: { id: string; name: string; code: string | null }[];
  members: { userId: string; email: string | null; name: string | null; companyId: string | null; isProjectAdmin: boolean; roleIds: string[] }[];
  roles: { id: string; name: string; description: string | null; color: string | null; kind: "role" | "task_team"; companyId: string | null; code: string | null; isLead: boolean }[];
}

interface ProjectPart {
  code: string;
  name: string;
  description: string | null;
  settings: Record<string, unknown>;
  cdeSettings: {
    enforceTransitions: boolean;
    codeScheme: string;
    suitabilityCodes: unknown;
    revisionRules: unknown;
    archiveFolderId: string | null;
    containerStandardId: string | null;
    wipPolicy: string;
    adminSeesWip: boolean;
  } | null;
  namingStandards: { id: string; definition: unknown }[];
}

const emailKey = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/** Pass 2: writes the new project. `created` gets its id as soon as it exists (clean-up on failure). */
async function restore(
  deps: ImportJobDeps,
  row: ImportRow,
  pkg: PackageReader,
  manifest: ProjectExportManifest,
  lang: string,
  created: (projectId: string) => void,
): Promise<{ projectId: string; report: ProjectImportReport }> {
  const { db, storage, jobs } = deps;
  const t = tFor(lang);
  const c = manifest.contents;
  const projectJson = await pkg.json<ProjectPart>(c.project);
  const { folders: folderList } = await pkg.json<{ folders: ExportFolderEntry[] }>(c.folders);
  const { files: fileList } = await pkg.json<{ files: ExportFileEntry[] }>(c.files);
  const membersJson = await pkg.json<MembersPart>(c.members);
  const { supersessions } = await pkg.json<{ supersessions: { versionId: string; supersededVersionId: string }[] }>(c.supersessions);
  if (!Array.isArray(folderList) || !Array.isArray(fileList) || !Array.isArray(membersJson?.members)) throw new PackageError(msg("portability:import.badJson", { name: c.folders }));

  const [importer] = row.requestedBy ? await db.select().from(users).where(eq(users.id, row.requestedBy)) : [];
  if (!importer?.isAdmin) throw new Error(t("portability:errors.importAdminOnly"));
  const report: ProjectImportReport = {
    source: {
      projectId: manifest.project.id,
      code: manifest.project.code,
      name: manifest.project.name,
      schema: manifest.schema,
      generatedAt: manifest.generatedAt,
      scope: manifest.scope,
      generator: `${manifest.generator?.product ?? "?"} ${manifest.generator?.version ?? ""}`.trim(),
    },
    counts: { folders: 0, files: 0, versions: 0, bytes: 0, issues: 0, members: 0, roles: 0, grants: 0, supersessions: 0 },
    unknownUsers: [],
    unknownCompanies: [],
    skippedGrants: 0,
    missingVersions: [],
    warnings: [],
  };

  // People by e-mail (never created) and companies by code, then name.
  const people = new Map<string, { email: string; name: string | null }>();
  const addPerson = (email: string | null | undefined, name: string | null | undefined) => {
    const k = emailKey(email);
    if (k && !people.has(k)) people.set(k, { email: email!.trim(), name: name ?? null });
  };
  for (const m of membersJson.members) addPerson(m.email, m.name);
  for (const f of fileList) {
    addPerson(f.createdBy?.email, f.createdBy?.name);
    for (const v of f.versions) addPerson(v.uploadedByEmail, v.uploadedBy);
  }
  const userByEmail = new Map<string, string>();
  for (const part of chunks([...people.keys()])) {
    const found = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(sql`lower(${users.email})`, part));
    for (const u of found) userByEmail.set(emailKey(u.email), u.id);
  }
  for (const [k, p] of people) if (!userByEmail.has(k)) report.unknownUsers.push({ email: p.email, name: p.name });
  const userFor = (email: string | null | undefined) => userByEmail.get(emailKey(email)) ?? null;
  const oldUserToNew = new Map<string, string>();
  for (const m of membersJson.members) {
    const id = userFor(m.email);
    if (id) oldUserToNew.set(m.userId, id);
  }

  const allCompanies = await db.select().from(companies);
  const companyMap = new Map<string, string>();
  for (const co of membersJson.companies ?? []) {
    const hit =
      (co.code ? allCompanies.find((x) => x.code && x.code.toLowerCase() === co.code!.toLowerCase()) : undefined) ??
      allCompanies.find((x) => x.name.trim().toLowerCase() === co.name.trim().toLowerCase());
    if (hit) companyMap.set(co.id, hit.id);
    else report.unknownCompanies.push({ name: co.name, code: co.code });
  }
  const companyFor = (id: string | null | undefined) => (id ? (companyMap.get(id) ?? null) : null);

  // The project, its root folder and the importer as project administrator.
  const code = row.code;
  const [taken] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.code, code), eq(projects.archived, false)));
  if (taken) throw new Error(t("projects:errors.codeTaken", { code }));
  const root = folderList.find((f) => f.parentId === null);
  const project = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({
        code,
        name: row.name ?? projectJson.name ?? manifest.project.name,
        description: projectJson.description ?? null,
        settings: (projectJson.settings ?? {}) as typeof projects.$inferInsert.settings,
        createdBy: importer.id,
      })
      .returning();
    const [r] = await tx
      .insert(folders)
      .values({ projectId: p!.id, parentId: null, name: root?.name ?? manifest.project.name, description: root?.description ?? null, state: (root?.state ?? null) as never, createdBy: importer.id })
      .returning();
    const [updated] = await tx.update(projects).set({ rootFolderId: r!.id }).where(eq(projects.id, p!.id)).returning();
    await tx.insert(projectMembers).values({ projectId: p!.id, userId: importer.id, companyId: importer.companyId, isProjectAdmin: true });
    return { project: updated!, rootId: r!.id };
  });
  const pid = project.project.id;
  created(pid);

  // Naming standards, roles and task teams, members.
  const standardMap = new Map<string, string>();
  for (const s of projectJson.namingStandards ?? []) {
    const [n] = await db.insert(namingStandards).values({ projectId: pid, definition: s.definition as never }).returning({ id: namingStandards.id });
    standardMap.set(s.id, n!.id);
  }
  const roleMap = new Map<string, string>();
  for (const r of membersJson.roles ?? []) {
    const [n] = await db
      .insert(projectRoles)
      .values({ projectId: pid, name: r.name, description: r.description, color: r.color, kind: r.kind, companyId: companyFor(r.companyId), code: r.code, isLead: r.isLead })
      .returning({ id: projectRoles.id });
    roleMap.set(r.id, n!.id);
    report.counts.roles++;
  }
  for (const m of membersJson.members) {
    const uid = oldUserToNew.get(m.userId);
    if (!uid) continue;
    if (uid === importer.id) {
      await db.update(projectMembers).set({ companyId: companyFor(m.companyId) ?? importer.companyId }).where(and(eq(projectMembers.projectId, pid), eq(projectMembers.userId, uid)));
    } else {
      const [u] = await db.select({ companyId: users.companyId }).from(users).where(eq(users.id, uid));
      await db.insert(projectMembers).values({ projectId: pid, userId: uid, companyId: companyFor(m.companyId) ?? u?.companyId ?? null, isProjectAdmin: m.isProjectAdmin }).onConflictDoNothing();
    }
    const held = (m.roleIds ?? []).map((r) => roleMap.get(r)).filter((x): x is string => !!x);
    if (held.length) await db.insert(memberRoles).values(held.map((roleId) => ({ projectId: pid, userId: uid, roleId }))).onConflictDoNothing();
    report.counts.members++;
  }

  // Folders, parents first, with their permissions and settings.
  const folderMap = new Map<string, string>();
  if (root) folderMap.set(root.id, project.rootId);
  const grantsOf = (f: ExportFolderEntry, folderId: string) =>
    (f.grants ?? []).flatMap((g) => {
      const subjectId = g.subjectType === "user" ? oldUserToNew.get(g.subjectId) : g.subjectType === "company" ? companyMap.get(g.subjectId) : roleMap.get(g.subjectId);
      if (!subjectId) {
        report.skippedGrants++;
        return [];
      }
      return [{ folderId, subjectType: g.subjectType, subjectId, level: g.level as never }];
    });
  for (const f of folderList) {
    let id = folderMap.get(f.id);
    if (!id) {
      const parent = (f.parentId && folderMap.get(f.parentId)) || project.rootId;
      const [n] = await db
        .insert(folders)
        .values({
          projectId: pid,
          parentId: parent,
          name: f.name,
          description: f.description,
          state: f.state as never,
          stateLabel: f.stateLabel,
          namingStandardId: f.namingStandardId ? (standardMap.get(f.namingStandardId) ?? null) : null,
          ownerTeamId: f.ownerTeamId ? (roleMap.get(f.ownerTeamId) ?? null) : null,
          createdBy: importer.id,
          createdAt: dateOr(f.createdAt),
        })
        .returning({ id: folders.id });
      id = n!.id;
      folderMap.set(f.id, id);
      report.counts.folders++;
    } else {
      await db
        .update(folders)
        .set({ namingStandardId: f.namingStandardId ? (standardMap.get(f.namingStandardId) ?? null) : null, stateLabel: f.stateLabel })
        .where(eq(folders.id, id));
    }
    const grants = grantsOf(f, id);
    if (grants.length) {
      await db.insert(folderGrants).values(grants).onConflictDoNothing();
      report.counts.grants += grants.length;
    }
    if (f.requireApprovedReview) await db.insert(folderSettings).values({ folderId: id, requireApprovedReview: true }).onConflictDoNothing();
  }

  // CDE settings (the WIP rule, codes, enforcement) with their folder and standard remapped.
  await ensureCdeSettings(db, pid);
  const cs = projectJson.cdeSettings;
  if (cs) {
    await db
      .update(projectCdeSettings)
      .set({
        // The transition table and its workflows are not part of the package: enforcing it on an
        // empty table would block uploads. The report says to set it up again.
        enforceTransitions: false,
        codeScheme: cs.codeScheme as never,
        suitabilityCodes: cs.suitabilityCodes as never,
        revisionRules: cs.revisionRules as never,
        archiveFolderId: cs.archiveFolderId ? (folderMap.get(cs.archiveFolderId) ?? null) : null,
        containerStandardId: cs.containerStandardId ? (standardMap.get(cs.containerStandardId) ?? null) : null,
        wipPolicy: cs.wipPolicy as never,
        adminSeesWip: cs.adminSeesWip,
      })
      .where(eq(projectCdeSettings.projectId, pid));
    if (cs.enforceTransitions) report.warnings.push(t("portability:import.transitionsOff"));
  }

  // Files and every version: bytes streamed from the package into the storage.
  const containerMap = new Map<string, string>();
  const versionMap = new Map<string, string>();
  const totalVersions = fileList.reduce((n, f) => n + f.versions.length, 0);
  await db.update(projectImports).set({ filesTotal: totalVersions, filesDone: 0, projectId: pid }).where(eq(projectImports.id, row.id));
  const progress = throttle(async (done) => {
    await db.update(projectImports).set({ filesDone: done }).where(eq(projectImports.id, row.id));
  });
  let done = 0;
  const work: { name: string; versionId: string }[] = [];
  for (const f of fileList) {
    const folderId = folderMap.get(f.folderId);
    if (!folderId) {
      report.warnings.push(t("portability:import.fileWithoutFolder", { name: f.name }));
      continue;
    }
    const present = f.versions.filter((v) => v.integrity !== "missing" && pkg.entries.has(v.path));
    for (const v of f.versions.filter((x) => !present.includes(x))) report.missingVersions.push({ path: v.path ?? null, fileId: f.id, version: v.version });
    done += f.versions.length - present.length;
    if (!present.length) continue;
    const containerId = containerMap.get(f.containerId) ?? randomUUID();
    containerMap.set(f.containerId, containerId);
    const current = present.some((v) => v.version === f.currentVersion) ? f.currentVersion : Math.max(...present.map((v) => v.version));
    const [file] = await db
      .insert(files)
      .values({
        projectId: pid,
        folderId,
        name: f.name,
        description: f.description,
        currentVersion: current,
        attributes: f.attributes ?? {},
        containerId,
        documentCode: f.documentCode,
        cdeStatus: f.cdeStatus as never,
        createdBy: userFor(f.createdBy?.email),
        createdAt: dateOr(f.createdAt),
      })
      .returning();
    report.counts.files++;
    for (const v of present.sort((a, b) => a.version - b.version)) {
      const obj = await storage.put(await pkg.stream(v.path), `projects/${pid}/files`);
      if (obj.sha256 !== v.sha256) report.warnings.push(t("portability:import.hashDiffers", { path: v.path }));
      const [nv] = await db
        .insert(fileVersions)
        .values({
          fileId: file!.id,
          version: v.version,
          storageKey: obj.key,
          size: obj.size,
          sha256: obj.sha256,
          uploadedBy: userFor(v.uploadedByEmail),
          uploadedAt: dateOr(v.uploadedAt),
          comment: v.comment,
          derivativeStatus: isModelFile(f.name) ? "pending" : "none",
          suitabilityCode: v.suitability,
          revisionCode: v.revision,
          codesSetBy: userFor(v.codesSetByEmail),
          codesSetAt: v.codesSetAt ? dateOr(v.codesSetAt) : null,
        })
        .returning({ id: fileVersions.id });
      versionMap.set(v.versionId, nv!.id);
      work.push({ name: f.name, versionId: nv!.id });
      report.counts.versions++;
      report.counts.bytes += obj.size;
      progress(++done, totalVersions);
    }
    if (f.documentCode)
      await db
        .insert(documentCodes)
        .values({ projectId: pid, codeNorm: normalizeDocumentCode(f.documentCode), containerId, firstFileId: file!.id })
        .onConflictDoNothing();
  }
  await progress.flush();

  // ISO-12 supersession links between restored versions.
  for (const s of supersessions ?? []) {
    const a = versionMap.get(s.versionId);
    const b = versionMap.get(s.supersededVersionId);
    if (!a || !b) continue;
    await db.insert(cdeSupersessions).values({ projectId: pid, versionId: a, supersededVersionId: b }).onConflictDoNothing();
    report.counts.supersessions++;
  }

  // Issues (BCF 3.0) through the BCF import: people by e-mail among the members, models by version.
  const user: AuthUser = { id: importer.id, email: importer.email, name: importer.name, isAdmin: importer.isAdmin, companyId: importer.companyId };
  const access = await projectAccess(db, pid, user);
  for (const part of c.issues ?? []) {
    const parsed = await parseBcfPackage(await pkg.buffer(part, BCF_ZIP_LIMITS.zipBytes), lang);
    const filesMapping: Record<string, string | null> = {};
    for (const topic of parsed.topics)
      for (const f of topic.markup.files) {
        const ref = f.reference?.trim().toLowerCase();
        filesMapping[fileKey(f)] = ref ? (versionMap.get(ref) ?? null) : null;
      }
    const r = await commitImport(db, access, parsed, { files: filesMapping }, part, lang);
    report.counts.issues += r.created + r.updated;
    report.warnings.push(...r.warnings);
  }

  // Background work of the restored versions (viewer derivatives, previews, search text).
  for (const w of work) await queueVersionWork(db, jobs, w.name, w.versionId);
  return { projectId: pid, report };
}

function dateOr(s: string | null | undefined): Date {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}
