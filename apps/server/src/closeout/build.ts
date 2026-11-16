/**
 * The close-out archive job (ISO 19650-2 §5.8.1, docs/features/CLOSEOUT_ARCHIVE.md): streams the
 * ZIP straight into the storage under DATA_DIR (never whole in memory), hashing every file as it
 * goes, then adds the manifest, the audit log, the chain check, README.txt and SHA256SUMS.
 */
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { and, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import { ZipFile } from "yazl";
import { CLOSEOUT_MANIFEST_SCHEMA, splitExtension, type AuditVerifyDto, type CloseoutManifestEntry, type CloseoutOptions } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { auditLog, closeoutArchives, projects, users } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { audit } from "../core/platform/audit.js";
import { FolderTree, projectAccess, type AuthUser } from "../core/security/access.js";
import { CSV_BOM, csvLine } from "../docintel/export.js";
import { auditCsvLines } from "../audit/csv.js";
import { verifyAuditChain } from "../audit/query.js";
import { DEFAULT_LANGUAGE, msg, render, supportedLanguage, tFor } from "../i18n/index.js";
import { packageVersion } from "../admin/status.js";
import type { CloseoutLimits } from "./config.js";
import { describeEntries, planEntries, type ManifestEntry, type PlannedEntry } from "./collect.js";

export const CLOSEOUT_JOB = "closeout_archive";

/** Already compressed formats are stored as they are (as the bulk download does). */
const STORED = new Set(["zip", "ifczip", "7z", "rar", "gz", "png", "jpg", "jpeg", "mp4", "docx", "xlsx", "pptx", "rvz", "frag"]);
const PROGRESS_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CloseoutJobDeps {
  db: Db;
  storage: Storage;
  limits: CloseoutLimits;
  log?: (m: string, e?: unknown) => void;
}

type ArchiveRow = typeof closeoutArchives.$inferSelect;

/** Free bytes on the disk that holds the storage; null when it cannot be read (another driver). */
export async function storageFreeBytes(storage: Storage): Promise<number | null> {
  try {
    const s = await statfs(path.dirname(storage.localPath("closeout")));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Refuses an archive over the size limit or without room on the disk (the message says why). */
export async function checkRoom(storage: Storage, limits: CloseoutLimits, bytes: number) {
  if (limits.maxBytes !== null && bytes > limits.maxBytes)
    return msg("closeout:errors.tooLarge", { size: gb(bytes), max: gb(limits.maxBytes) });
  const free = await storageFreeBytes(storage);
  // The ZIP is at most the files plus a little (headers, manifest): ask for 5 % more and the reserve.
  if (free !== null && free < bytes * 1.05 + limits.minFreeBytes)
    return msg("closeout:errors.noDiskSpace", { size: gb(bytes), free: gb(free), reserve: gb(limits.minFreeBytes) });
  return null;
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

/** Runs one archive (job payload: archiveId, lang). Errors mark the archive failed and fail the job. */
export async function runCloseoutJob(deps: CloseoutJobDeps, payload: Record<string, unknown>): Promise<void> {
  const { db, storage } = deps;
  const archiveId = String(payload.archiveId);
  const lang = supportedLanguage(typeof payload.lang === "string" ? payload.lang : null) ?? DEFAULT_LANGUAGE;
  const [row] = await db.select().from(closeoutArchives).where(eq(closeoutArchives.id, archiveId));
  if (!row || (row.status !== "queued" && row.status !== "running")) return;
  await db
    .update(closeoutArchives)
    .set({ status: "running", startedAt: new Date(), filesDone: 0, bytesDone: 0, error: null })
    .where(eq(closeoutArchives.id, archiveId));
  let storedKey: string | null = null;
  try {
    const result = await build(deps, row, lang);
    storedKey = result.key;
    await finish(deps, row, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (storedKey) await storage.remove(storedKey).catch(() => undefined);
    await db
      .update(closeoutArchives)
      .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date(), storageKey: null })
      .where(eq(closeoutArchives.id, archiveId));
    throw err;
  }
}

interface BuildResult {
  key: string;
  size: number;
  sha256: string;
  files: number;
  bytes: number;
  problems: number;
  chain: Pick<AuditVerifyDto, "ok" | "checked" | "head" | "broken">;
}

async function build(deps: CloseoutJobDeps, row: ArchiveRow, lang: string): Promise<BuildResult> {
  const { db, storage } = deps;
  const t = tFor(lang);
  const options = row.options;
  const [project] = await db.select().from(projects).where(eq(projects.id, row.projectId));
  if (!project) throw new Error("project not found");
  const [requester] = row.requestedBy ? await db.select().from(users).where(eq(users.id, row.requestedBy)) : [];

  const { tree, entries } = await planEntries(db, project.id, options);
  const bytesTotal = entries.reduce((n, e) => n + e.version.size, 0);
  await db.update(closeoutArchives).set({ filesTotal: entries.length, bytesTotal }).where(eq(closeoutArchives.id, row.id));
  const refusal = await checkRoom(storage, deps.limits, bytesTotal);
  if (refusal) throw new Error(render(lang, refusal));

  // The audit chain at the time of the archive; the exported log ends at its head.
  const verify = await verifyAuditChain(db);
  const chain = { ok: verify.ok, checked: verify.checked, head: verify.head, broken: verify.broken };
  const described = await describeEntries(db, project.id, tree, entries);

  const zip = new ZipFile();
  const out = zip.outputStream as Readable;
  const stored = storage.put(out, `closeout/${project.id}`);
  // Keeps the promise from rejecting unobserved while the files are read.
  stored.catch(() => undefined);

  // Files: present ones streamed and hashed; missing ones only listed.
  const integrity = new Map<string, CloseoutManifestEntry["integrity"]>();
  const sums: [string, string][] = [];
  // The size on disk, not the stored one: a file whose bytes changed is archived and reported, not fatal.
  const present: { e: PlannedEntry; size: number }[] = [];
  for (const e of entries) {
    const size = await storage.size(e.version.storageKey).catch(() => null);
    if (size !== null) present.push({ e, size });
    else integrity.set(e.version.id, "missing");
  }

  let filesDone = 0;
  let bytesDone = 0;
  let lastProgress = 0;
  let progressChain: Promise<unknown> = Promise.resolve();
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    const values = { filesDone, bytesDone };
    progressChain = progressChain.then(() => db.update(closeoutArchives).set(values).where(eq(closeoutArchives.id, row.id))).catch(() => undefined);
  };

  const filesRead = new Promise<void>((resolve) => {
    let left = present.length;
    if (!left) resolve();
    for (const { e, size } of present) {
      const ext = splitExtension(e.file.name).extension.toLowerCase();
      zip.addReadStreamLazy(e.path, { mtime: e.version.uploadedAt, compress: !STORED.has(ext), size }, (cb) => {
        const hash = createHash("sha256");
        const source = storage.get(e.version.storageKey);
        const meter = new Transform({
          transform(chunk: Buffer, _enc, done) {
            hash.update(chunk);
            bytesDone += chunk.length;
            progress();
            done(null, chunk);
          },
          flush(done) {
            const digest = hash.digest("hex");
            integrity.set(e.version.id, digest === e.version.sha256 ? "ok" : "mismatch");
            sums.push([digest, e.path]);
            filesDone++;
            progress();
            done();
            if (--left === 0) resolve();
          },
        });
        // yazl does not listen for read errors; unhandled, one would take the whole server down.
        source.on("error", (err) => out.destroy(err));
        cb(null, source.pipe(meter));
      });
    }
  });
  await Promise.race([filesRead, stored.then(() => Promise.reject(new Error("archive ended before its files were read")))]);

  const manifest: CloseoutManifestEntry[] = described.map((d: ManifestEntry) => ({ ...d, integrity: integrity.get(d.versionId) ?? "missing" }));
  const problems = manifest.filter((m) => m.integrity !== "ok");
  const generatedAt = new Date().toISOString();

  const extra: [string, Buffer][] = [];
  const add = (name: string, text: string) => extra.push([name, Buffer.from(text, "utf8")]);
  add(
    "manifest.json",
    JSON.stringify(
      {
        schema: CLOSEOUT_MANIFEST_SCHEMA,
        generatedAt,
        generator: { product: "SiteKeep", version: packageVersion() },
        standard: "ISO 19650-2:2018 5.8.1",
        project: { id: project.id, code: project.code, name: project.name },
        requestedBy: requester ? { id: requester.id, name: requester.name } : null,
        options: { includeShared: options.includeShared, versions: options.versions },
        counts: { files: new Set(manifest.map((m) => m.fileId)).size, versions: manifest.length, bytes: bytesTotal, problems: problems.length },
        auditChain: chain,
        entries: manifest,
      },
      null,
      2,
    ),
  );
  add("manifest.csv", manifestCsv(manifest, t));

  // The project's audit log up to the head the check saw (no IP address or user agent).
  const viewer = requester ? await viewerOf(db, project.id, requester) : undefined;
  const where = and(eq(auditLog.projectId, project.id), chain.head ? lte(auditLog.id, chain.head.id) : undefined);
  let auditCsv = "";
  for await (const line of auditCsvLines(db, where, t, { client: false, viewer })) auditCsv += line;
  add("audit/audit-log.csv", auditCsv);
  add("audit/audit-verify.json", JSON.stringify({ checkedAt: generatedAt, ...verify }, null, 2));
  add(
    "README.txt",
    readme(t, {
      project,
      requester: requester?.name ?? null,
      generatedAt,
      options,
      files: new Set(manifest.map((m) => m.fileId)).size,
      versions: manifest.length,
      bytes: bytesTotal,
      chain,
      problems,
    }),
  );

  for (const [name, buf] of extra) {
    zip.addBuffer(buf, name, { mtime: new Date(generatedAt) });
    sums.push([createHash("sha256").update(buf).digest("hex"), name]);
  }
  sums.sort((a, b) => a[1].localeCompare(b[1]));
  zip.addBuffer(Buffer.from(sums.map(([h, p]) => `${h}  ${p}\n`).join(""), "utf8"), "SHA256SUMS", { mtime: new Date(generatedAt) });
  zip.end();
  const result = await stored;
  progress(true);
  await progressChain;
  return { key: result.key, size: result.size, sha256: result.sha256, files: manifest.length, bytes: bytesTotal, problems: problems.length, chain };
}

/** The requester's view of the audit log: rows about another task team's WIP keep no names (ISO-5). */
async function viewerOf(db: Db, projectId: string, u: typeof users.$inferSelect) {
  const user: AuthUser = { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, companyId: u.companyId };
  try {
    const a = await projectAccess(db, projectId, user);
    return { tree: await FolderTree.load(db, projectId), principal: a.principal };
  } catch {
    return undefined;
  }
}

const CSV_COLUMNS = [
  "path",
  "documentCode",
  "containerId",
  "fileId",
  "versionId",
  "version",
  "latest",
  "revision",
  "suitability",
  "cdeState",
  "cdeStatus",
  "size",
  "sha256",
  "integrity",
  "uploadedBy",
  "uploadedAt",
  "approvals",
  "supersededBy",
  "supersedes",
  "namingStandard",
  "namingResult",
] as const;

function manifestCsv(entries: CloseoutManifestEntry[], t: ReturnType<typeof tFor>): string {
  const yes = t("closeout:manifestCsv.yes");
  const no = t("closeout:manifestCsv.no");
  const refs = (list: CloseoutManifestEntry["supersedes"]) => list.map((r) => r.path ?? `${r.fileId} V${r.version}`).join(" | ");
  let out = CSV_BOM + csvLine(CSV_COLUMNS.map((c) => t(`closeout:manifestCsv.columns.${c}`)));
  for (const e of entries) {
    const approvals = e.approvals
      .map((a) =>
        [
          `${a.review}${a.workflow ? ` (${a.workflow})` : ""}`,
          a.outcomeLabel ?? a.outcome ?? "",
          a.decidedAt ?? "",
          a.steps.map((s) => `${s.step}: ${s.by ?? "?"} ${s.outcome} ${s.at}`).join(", "),
        ]
          .filter(Boolean)
          .join(" / "),
      )
      .join(" | ");
    const cells: Record<(typeof CSV_COLUMNS)[number], string | number> = {
      path: e.path,
      documentCode: e.documentCode ?? "",
      containerId: e.containerId,
      fileId: e.fileId,
      versionId: e.versionId,
      version: e.version,
      latest: e.latest ? yes : no,
      revision: e.revision ?? "",
      suitability: e.suitability ?? "",
      cdeState: e.cdeState,
      cdeStatus: e.cdeStatus ?? "",
      size: e.size,
      sha256: e.sha256,
      integrity: e.integrity,
      uploadedBy: e.uploadedBy ?? "",
      uploadedAt: e.uploadedAt,
      approvals,
      supersededBy: refs(e.supersededBy),
      supersedes: refs(e.supersedes),
      namingStandard: e.naming?.standard ?? "",
      namingResult: e.naming ? (e.naming.ok ? yes : `${no}: ${e.naming.errors.join("; ")}`) : "",
    };
    out += csvLine(CSV_COLUMNS.map((c) => cells[c]));
  }
  return out;
}

function readme(
  t: ReturnType<typeof tFor>,
  d: {
    project: typeof projects.$inferSelect;
    requester: string | null;
    generatedAt: string;
    options: CloseoutOptions;
    files: number;
    versions: number;
    bytes: number;
    chain: BuildResult["chain"];
    problems: CloseoutManifestEntry[];
  },
): string {
  const scope = d.options.includeShared ? t("closeout:readme.scopeWithShared") : t("closeout:readme.scope");
  const versions = d.options.versions === "all" ? t("closeout:readme.versionsAll") : t("closeout:readme.versionsLatest");
  const chain = d.chain.ok ? t("closeout:readme.chainOk", { count: d.chain.checked }) : t("closeout:readme.chainBroken", { id: d.chain.broken?.id ?? "?", reason: d.chain.broken?.reason ?? "?" });
  const lines = [
    t("closeout:readme.title"),
    "",
    t("closeout:readme.project", { code: d.project.code, name: d.project.name }),
    t("closeout:readme.created", { at: d.generatedAt, user: d.requester ?? "—" }),
    t("closeout:readme.scopeLine", { scope, versions }),
    t("closeout:readme.counts", { files: d.files, versions: d.versions, bytes: d.bytes }),
    "",
    t("closeout:readme.purpose"),
    "",
    t("closeout:readme.contents"),
    `  files/                   ${t("closeout:readme.files")}`,
    `  manifest.json            ${t("closeout:readme.manifestJson", { schema: CLOSEOUT_MANIFEST_SCHEMA })}`,
    `  manifest.csv             ${t("closeout:readme.manifestCsv")}`,
    `  audit/audit-log.csv      ${t("closeout:readme.auditCsv", { id: d.chain.head?.id ?? "—" })}`,
    `  audit/audit-verify.json  ${t("closeout:readme.auditVerify")}`,
    `  SHA256SUMS               ${t("closeout:readme.sums")}`,
    "",
    t("closeout:readme.chain", { result: chain }),
    d.chain.head ? t("closeout:readme.head", { id: d.chain.head.id, hash: d.chain.head.hash, at: d.chain.head.at }) : t("closeout:readme.noHead"),
    t("closeout:readme.recordHead"),
    "",
    t("closeout:readme.check"),
  ];
  if (d.problems.length) {
    lines.push("", t("closeout:readme.problems", { count: d.problems.length }));
    for (const p of d.problems) lines.push(`  - ${p.path} (${t(`closeout:readme.integrity.${p.integrity === "mismatch" ? "mismatch" : "missing"}`)})`);
  }
  return lines.join("\r\n") + "\r\n";
}

async function finish(deps: CloseoutJobDeps, row: ArchiveRow, r: BuildResult): Promise<void> {
  const { db } = deps;
  const now = new Date();
  await db
    .update(closeoutArchives)
    .set({
      status: "done",
      finishedAt: now,
      storageKey: r.key,
      size: r.size,
      sha256: r.sha256,
      auditChain: r.chain,
      problems: r.problems,
      filesDone: r.files - r.problems,
      bytesDone: r.bytes,
      expiresAt: new Date(now.getTime() + deps.limits.retentionDays * DAY_MS),
    })
    .where(eq(closeoutArchives.id, row.id));
  await audit(db, {
    projectId: row.projectId,
    userId: row.requestedBy,
    action: "project.closeout_archive_created",
    targetType: "closeout_archive",
    targetId: row.id,
    details: {
      options: row.options,
      versions: r.files,
      bytes: r.bytes,
      size: r.size,
      sha256: r.sha256,
      problems: r.problems,
      auditHead: r.chain.head ? { id: r.chain.head.id, hash: r.chain.head.hash } : null,
      auditChainOk: r.chain.ok,
    },
  });
  // "Close the project afterwards": only after a complete archive.
  if (row.options.closeProject && r.problems === 0) await closeProject(db, row.projectId, row.requestedBy, row.id);
}

/** Marks the project closed (read-only) and records `project.closed`; false when it already was. */
export async function closeProject(db: Db, projectId: string, userId: string | null, archiveId: string): Promise<boolean> {
  const done = await db
    .update(projects)
    .set({ closedAt: new Date(), closedBy: userId })
    .where(and(eq(projects.id, projectId), isNull(projects.closedAt)))
    .returning({ id: projects.id });
  if (!done.length) return false;
  await audit(db, { projectId, userId, action: "project.closed", targetType: "project", targetId: projectId, details: { archiveId } });
  return true;
}

/** Deletes the files of archives past their download period; the rows stay ("expired"). */
export async function sweepCloseoutArchives(db: Db, storage: Storage, now = new Date()): Promise<number> {
  const due = await db
    .select({ id: closeoutArchives.id, key: closeoutArchives.storageKey })
    .from(closeoutArchives)
    .where(and(eq(closeoutArchives.status, "done"), lt(closeoutArchives.expiresAt, now)));
  if (!due.length) return 0;
  for (const d of due) if (d.key) await storage.remove(d.key).catch(() => undefined);
  await db
    .update(closeoutArchives)
    .set({ status: "expired", storageKey: null })
    .where(inArray(closeoutArchives.id, due.map((d) => d.id)));
  return due.length;
}

/** Hourly clean-up of expired archives (index.ts). */
export function startCloseoutCleanup(db: Db, storage: Storage, opts: { log?: (m: string, e?: unknown) => void } = {}): () => void {
  const run = () => void sweepCloseoutArchives(db, storage).catch((e) => opts.log?.("close-out archive clean-up failed", e));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, 60 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
