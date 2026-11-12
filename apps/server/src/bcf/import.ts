/**
 * .bcfzip import: parse (untrusted, see unzip.ts / xml.ts / image.ts), preview (new / update /
 * unchanged / conflict per topic GUID, value mappings with suggestions) and commit.
 *
 * Idempotent by GUID: topics map to issues by issues.guid, comments by issue_comments.guid and
 * viewpoints by their GUID. Comments and viewpoints are only ever added; topic fields are updated
 * when the file changed since the last import and the issue did not ("update"), or when the caller
 * chose to overwrite a conflict.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, max } from "drizzle-orm";
import {
  bcfToViewpoint,
  can,
  dueDateFromBcf,
  isBcfGuid,
  suggestIssuePriority,
  suggestIssueStatus,
  type BcfImportMapping,
  type BcfImportPreview,
  type BcfImportResult,
  type BcfImportState,
  type BcfViewpoint,
  type IssueImportInfo,
  type IssuePriority,
  type IssueStatus,
  type IssueViewpoint,
} from "@sitekeep/shared";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import { fileVersions, files, issueComments, issueRelatedTopics, issueViewpoints, issues, projectMembers, users } from "../db/schema.js";
import { guidFrom, readMarkup, readProject, readVersion, readVisinfo, type ParsedMarkup } from "./bcf-xml.js";
import { sanitizeSnapshot, toDataUrl, type CleanImage } from "./image.js";
import { primaryViewpointGuid } from "./topics.js";
import { BcfZipError, readBcfZip } from "./unzip.js";
import { BcfFormatError, BcfUnsafeXmlError } from "./xml.js";
import { DEFAULT_LANGUAGE, msg, render, tFor, type Msg, type MsgKey } from "../i18n/index.js";

export const MAX_TOPICS = 2000;

export interface ParsedViewpoint {
  guid: string;
  index: number;
  vis: BcfViewpoint | null;
  snapshot: CleanImage | null;
}

export interface ParsedTopic {
  folder: string;
  markup: ParsedMarkup;
  viewpoints: ParsedViewpoint[];
  warnings: string[];
}

export interface ParsedBcf {
  version: string;
  projectName: string | null;
  topics: ParsedTopic[];
  warnings: string[];
}

class BcfInputError extends Error {
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LANGUAGE, msg));
    this.name = "BcfInputError";
  }
}

/** Errors that mean "this is not a usable .bcfzip" (400). */
export function isBcfInputError(e: unknown): boolean {
  return e instanceof BcfZipError || e instanceof BcfFormatError || e instanceof BcfInputError || (e instanceof Error && e.name === "BcfInputError");
}

/** The reader's text of a parse error (a Msg when the error carries one). */
export function bcfErrorMsg(e: unknown): Msg | string {
  const m = (e as { msg?: unknown }).msg;
  return m && typeof m === "object" ? (m as Msg) : e instanceof Error ? e.message : String(e);
}

/** GUID seeds of non-standard GUIDs: fixed Turkish words, so derived GUIDs stay stable across imports. */
const GUID_KIND_LABELS: Record<string, MsgKey> = {
  sorun: "bcf:guidKinds.issue", // i18n-ok: GUID seed
  "ilgili sorun": "bcf:guidKinds.relatedIssue", // i18n-ok: GUID seed
  görünüm: "bcf:guidKinds.viewpoint", // i18n-ok: GUID seed
  yorum: "bcf:guidKinds.comment", // i18n-ok: GUID seed
};

/** GUID as stored: lower case; a non-standard one becomes a stable derived GUID. */
function normGuid(raw: string, kind: string, warnings: string[], lang: string): string {
  const g = raw.trim().toLowerCase();
  if (isBcfGuid(g)) return g;
  const label = GUID_KIND_LABELS[kind] ? render(lang, msg(GUID_KIND_LABELS[kind])) : kind;
  warnings.push(render(lang, msg("bcf:warnings.nonStandardGuid", { kind: label, guid: raw.slice(0, 60) })));
  return guidFrom(`${kind}:${raw.trim()}`);
}

/** Parses a .bcfzip; warnings are written in `lang` (the importer's language). */
export async function parseBcfPackage(buf: Buffer, lang = DEFAULT_LANGUAGE): Promise<ParsedBcf> {
  const t = tFor(lang);
  const { files: entries, skipped } = await readBcfZip(buf);
  const warnings: string[] = [];
  const markups = [...entries.keys()].filter((n) => /(^|\/)markup\.bcf$/i.test(n));
  if (!markups.length) throw new BcfInputError(msg("bcf:errors.noMarkup"));
  if (markups.length > MAX_TOPICS) throw new BcfInputError(msg("bcf:errors.tooManyTopics", { max: MAX_TOPICS }));
  // Topic folders sit at the root, or inside one wrapper folder.
  const dirOf = (n: string) => (n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : "");
  const base = dirOf(dirOf(markups[0]!));
  const at = (name: string) => entries.get(base ? `${base}/${name}` : name);

  let version = "";
  const versionFile = at("bcf.version");
  if (versionFile) {
    try {
      version = readVersion(versionFile);
    } catch (e) {
      warnings.push(t("bcf:warnings.versionUnreadable", { detail: bcfErrorMsg(e) }));
    }
  } else warnings.push(t("bcf:warnings.noVersion"));
  if (!version) version = "2.1";
  if (!/^(2\.0|2\.1|3\.0)/.test(version)) warnings.push(t("bcf:warnings.unsupportedVersion", { version }));

  let projectName: string | null = null;
  const projectFile = at("project.bcfp");
  if (projectFile) {
    try {
      projectName = readProject(projectFile).name;
    } catch {
      warnings.push(t("bcf:warnings.projectUnreadable"));
    }
  }
  const ignored = skipped.filter((n) => !/\.(xsd|xml)$/i.test(n));
  if (ignored.length) warnings.push(t("bcf:warnings.extraFiles", { count: ignored.length, example: ignored[0] }));

  const topics: ParsedTopic[] = [];
  const seen = new Set<string>();
  for (const m of markups.sort()) {
    const folder = dirOf(m);
    if (dirOf(folder) !== base) {
      warnings.push(t("bcf:warnings.unexpectedFolder", { name: m }));
      continue;
    }
    const tw: string[] = [];
    let markup: ParsedMarkup;
    try {
      markup = readMarkup(entries.get(m)!, m, lang);
    } catch (e) {
      if (e instanceof BcfUnsafeXmlError || !(e instanceof BcfFormatError)) throw e;
      warnings.push(t("bcf:warnings.markupUnreadable", { name: m, detail: e.msg }));
      continue;
    }
    tw.push(...markup.warnings);
    markup.topic.guid = normGuid(markup.topic.guid, "sorun", tw, lang); // i18n-ok: GUID seed
    if (seen.has(markup.topic.guid)) {
      warnings.push(t("bcf:warnings.duplicateGuid", { guid: markup.topic.guid }));
      continue;
    }
    seen.add(markup.topic.guid);
    markup.topic.related_topics = markup.topic.related_topics
      .filter((r) => r.related_topic_guid)
      .map((r) => ({ related_topic_guid: normGuid(r.related_topic_guid, "ilgili sorun", tw, lang) })); // i18n-ok: GUID seed

    const inFolder = (name: string | undefined): Buffer | undefined => {
      if (!name) return undefined;
      if (name.includes("/") || name.includes("\\") || name.includes("..")) {
        tw.push(t("bcf:warnings.outsideReference", { name: name.slice(0, 80) }));
        return undefined;
      }
      return entries.get(`${folder}/${name}`);
    };
    // 2.0 / 2.1 files may list no viewpoints but still carry the default viewpoint.bcfv / snapshot.png.
    const listed = markup.viewpoints.length ? markup.viewpoints : inFolder("viewpoint.bcfv") || inFolder("snapshot.png") ? [{ guid: "", viewpoint: inFolder("viewpoint.bcfv") ? "viewpoint.bcfv" : undefined, snapshot: inFolder("snapshot.png") ? "snapshot.png" : undefined }] : [];
    const viewpoints: ParsedViewpoint[] = [];
    const vpSeen = new Set<string>();
    for (const [i, entry] of listed.entries()) {
      let vis: BcfViewpoint | null = null;
      const vb = inFolder(entry.viewpoint);
      if (entry.viewpoint && !vb) tw.push(t("bcf:warnings.viewpointMissing", { name: entry.viewpoint }));
      if (vb) {
        try {
          const r = readVisinfo(vb, `${folder}/${entry.viewpoint}`, lang);
          vis = r.viewpoint;
          tw.push(...r.warnings);
        } catch (e) {
          if (e instanceof BcfUnsafeXmlError) throw e;
          tw.push(t("bcf:warnings.viewpointUnreadable", { name: entry.viewpoint, detail: bcfErrorMsg(e) }));
        }
      }
      let snapshot: CleanImage | null = null;
      const sb = inFolder(entry.snapshot);
      if (sb) {
        try {
          snapshot = sanitizeSnapshot(sb);
        } catch (e) {
          tw.push(t("bcf:warnings.imageSkipped", { name: entry.snapshot, detail: bcfErrorMsg(e) }));
        }
      }
      if (!vis && !snapshot) continue;
      const rawGuid = entry.guid || vis?.guid || `${markup.topic.guid}:${i}`;
      const guid = normGuid(rawGuid, "görünüm", tw, lang); // i18n-ok: GUID seed
      if (vpSeen.has(guid)) continue;
      vpSeen.add(guid);
      if (vis) vis.guid = guid;
      viewpoints.push({ guid, index: entry.index ?? i, vis, snapshot });
    }
    viewpoints.sort((a, b) => a.index - b.index);
    for (const c of markup.comments) {
      c.guid = normGuid(c.guid, "yorum", tw, lang);
      if (c.viewpoint_guid) c.viewpoint_guid = isBcfGuid(c.viewpoint_guid) ? c.viewpoint_guid.toLowerCase() : guidFrom(`görünüm:${c.viewpoint_guid.trim()}`); // i18n-ok: GUID seed
    }
    topics.push({ folder, markup, viewpoints, warnings: tw });
  }
  if (!topics.length) throw new BcfInputError(msg("bcf:errors.noReadableTopics", { details: warnings.slice(0, 3).join(" ") }));
  return { version, projectName, topics, warnings };
}

// ------------------------------------------------------------------ project context

interface Member {
  userId: string;
  email: string;
  name: string;
}

interface ModelVersion {
  versionId: string;
  fileName: string;
  projectGuid: string | null;
  isLatest: boolean;
}

async function projectMembersOf(db: Db, projectId: string): Promise<Member[]> {
  return db
    .select({ userId: users.id, email: users.email, name: users.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
}

/** IFC versions the caller may open (view permission on the folder). */
async function visibleModels(db: Db, a: ProjectAccess): Promise<ModelVersion[]> {
  const tree = await FolderTree.load(db, a.project.id);
  const rows = await db
    .select({ versionId: fileVersions.id, version: fileVersions.version, summary: fileVersions.ifcSummary, name: files.name, current: files.currentVersion, folderId: files.folderId })
    .from(files)
    .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
    .where(and(eq(files.projectId, a.project.id), isNull(files.deletedAt)));
  return rows
    .filter((r) => /\.ifc$/i.test(r.name) && tree.byId.has(r.folderId) && can(tree.permission(a.principal, r.folderId).level, "view"))
    .map((r) => ({ versionId: r.versionId, fileName: r.name, projectGuid: r.summary?.projectGuid ?? null, isLatest: r.version === r.current }));
}

export function fileKey(f: { filename?: string | null; ifc_project?: string | null; reference?: string | null }): string {
  return [f.filename ?? "", f.ifc_project ?? "", f.reference ?? ""].join("|").toLowerCase();
}

function suggestModel(f: { filename?: string | null; ifc_project?: string | null; reference?: string | null }, models: ModelVersion[]): ModelVersion | null {
  const ref = f.reference?.trim().toLowerCase();
  if (ref) {
    const byRef = models.find((m) => m.versionId === ref);
    if (byRef) return byRef;
  }
  const latest = models.filter((m) => m.isLatest);
  if (f.ifc_project) {
    const byGuid = latest.find((m) => m.projectGuid === f.ifc_project);
    if (byGuid) return byGuid;
  }
  const name = f.filename?.trim().toLowerCase();
  if (name) {
    const stem = name.replace(/\.ifc$/i, "");
    const byName = latest.find((m) => m.fileName.toLowerCase() === name || m.fileName.toLowerCase().replace(/\.ifc$/i, "") === stem);
    if (byName) return byName;
  }
  return null;
}

const emailKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

interface Existing {
  id: string;
  number: number;
  guid: string;
  updatedAt: Date;
  createdBy: string;
  assigneeUserId: string | null;
  importedFrom: IssueImportInfo | null;
}

function time(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/** new / update / unchanged / conflict for one topic (see the module comment). */
export function topicState(t: ParsedTopic, e: Existing | undefined): BcfImportState {
  if (!e) return "new";
  const incoming = t.markup.topic.modified_date || t.markup.topic.creation_date;
  const imp = e.importedFrom;
  if (imp) {
    const a = time(incoming);
    const b = time(imp.topicModified);
    const incomingChanged = a !== null && b !== null ? Math.abs(a - b) > 999 : (incoming ?? "") !== (imp.topicModified ?? "");
    if (!incomingChanged) return "unchanged";
    const importedAt = time(imp.importedAt) ?? 0;
    return e.updatedAt.getTime() > importedAt + 1000 ? "conflict" : "update";
  }
  // Never imported: an issue of ours exported earlier. Newer in the file → update, otherwise ours stays.
  const a = time(incoming);
  return a !== null && a > e.updatedAt.getTime() + 1000 ? "update" : "unchanged";
}

async function existingByGuid(db: Db, projectId: string, guids: string[]): Promise<Map<string, Existing>> {
  if (!guids.length) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      number: issues.number,
      guid: issues.guid,
      updatedAt: issues.updatedAt,
      createdBy: issues.createdBy,
      assigneeUserId: issues.assigneeUserId,
      importedFrom: issues.importedFrom,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.guid, guids)));
  return new Map(rows.map((r) => [r.guid, r]));
}

const canEditIssue = (a: ProjectAccess, e: Existing) => a.isProjectAdmin || e.createdBy === a.user.id || e.assigneeUserId === a.user.id;

// ------------------------------------------------------------------ preview

export async function previewImport(db: Db, a: ProjectAccess, pkg: ParsedBcf, fileName?: string, lang = DEFAULT_LANGUAGE): Promise<BcfImportPreview> {
  const existing = await existingByGuid(db, a.project.id, pkg.topics.map((t) => t.markup.topic.guid));
  const members = await projectMembersOf(db, a.project.id);
  const models = await visibleModels(db, a);
  const memberByEmail = new Map(members.map((m) => [emailKey(m.email), m]));

  const count = <K extends string>(map: Map<K, number>, k: K | null | undefined) => {
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  };
  const statuses = new Map<string, number>();
  const types = new Map<string, number>();
  const priorities = new Map<string, number>();
  const emails = new Map<string, number>();
  const fileRows = new Map<string, { f: ParsedMarkup["files"][number]; count: number }>();

  const topics = pkg.topics.map((t) => {
    const tp = t.markup.topic;
    count(statuses, tp.topic_status || "(boş)"); // i18n-ok: mapping key shared with the web app
    count(types, tp.topic_type || "(boş)"); // i18n-ok: mapping key shared with the web app
    count(priorities, tp.priority || "(boş)"); // i18n-ok: mapping key shared with the web app
    for (const e of [tp.creation_author, tp.modified_author, tp.assigned_to, ...t.markup.comments.map((c) => c.author)]) count(emails, emailKey(e) || null);
    for (const f of t.markup.files) {
      const k = fileKey(f);
      const row = fileRows.get(k);
      if (row) row.count++;
      else fileRows.set(k, { f, count: 1 });
    }
    const e = existing.get(tp.guid);
    const state = topicState(t, e);
    return {
      guid: tp.guid,
      title: tp.title || render(lang, msg("bcf:labels.untitled")),
      topicStatus: tp.topic_status,
      topicType: tp.topic_type,
      priority: tp.priority ?? null,
      assignedTo: tp.assigned_to ?? null,
      state,
      ...(e && { existingIssueId: e.id, existingNumber: e.number }),
      ...(e && !canEditIssue(a, e) && state !== "unchanged" && { readOnly: true }),
      comments: t.markup.comments.length,
      viewpoints: t.viewpoints.length,
      snapshots: t.viewpoints.filter((v) => v.snapshot).length,
      warnings: t.warnings,
    };
  });

  return {
    version: pkg.version,
    fileName,
    projectName: pkg.projectName,
    topics,
    statuses: [...statuses].map(([value, n]) => ({ value, count: n, suggested: suggestIssueStatus(value) })),
    types: [...types].map(([value, n]) => ({ value, count: n, suggested: value === "(boş)" /* i18n-ok: mapping key */ ? null : value.slice(0, 100) })),
    priorities: [...priorities].map(([value, n]) => ({ value, count: n, suggested: suggestIssuePriority(value) })),
    users: [...emails].map(([email, n]) => {
      const m = memberByEmail.get(email);
      return { email, count: n, suggestedUserId: m?.userId ?? null, name: m?.name ?? null };
    }),
    files: [...fileRows].map(([key, { f, count: n }]) => {
      const m = suggestModel(f, models);
      return { key, filename: f.filename ?? null, ifcProject: f.ifc_project ?? null, count: n, suggestedVersionId: m?.versionId ?? null, label: m?.fileName ?? null };
    }),
    warnings: pkg.warnings,
  };
}

// ------------------------------------------------------------------ commit

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, n) : null;
};

const validDate = (s: string | null | undefined) => {
  const t = time(s);
  return t === null ? null : new Date(t);
};

export async function commitImport(
  db: Db,
  a: ProjectAccess,
  pkg: ParsedBcf,
  mapping: BcfImportMapping,
  fileName?: string,
  lang = DEFAULT_LANGUAGE,
): Promise<BcfImportResult> {
  const tr = tFor(lang);
  const members = await projectMembersOf(db, a.project.id);
  const memberIds = new Set(members.map((m) => m.userId));
  const memberByEmail = new Map(members.map((m) => [emailKey(m.email), m.userId]));
  const models = await visibleModels(db, a);
  const visibleVersions = new Set(models.map((m) => m.versionId));
  const existing = await existingByGuid(db, a.project.id, pkg.topics.map((t) => t.markup.topic.guid));
  const only = mapping.topics?.length ? new Set(mapping.topics.map((g) => g.toLowerCase())) : null;
  const overwrite = mapping.conflicts === "overwrite";

  const userFor = (email: string | null | undefined): string | null => {
    const k = emailKey(email);
    if (!k) return null;
    if (mapping.users && k in mapping.users) {
      const id = mapping.users[k];
      return id && memberIds.has(id) ? id : null;
    }
    return memberByEmail.get(k) ?? null;
  };
  const statusFor = (v: string): IssueStatus => mapping.statuses?.[v || "(boş)"] ?? suggestIssueStatus(v); // i18n-ok: mapping key
  const priorityFor = (v: string | null | undefined): IssuePriority => mapping.priorities?.[v || "(boş)"] ?? suggestIssuePriority(v); // i18n-ok: mapping key
  const typeFor = (v: string): string | null => {
    const k = v || "(boş)"; // i18n-ok: mapping key
    if (mapping.types && k in mapping.types) return clip(mapping.types[k], 100);
    return clip(v, 100);
  };
  const versionFor = (f: ParsedMarkup["files"][number]): string | null => {
    const k = fileKey(f);
    if (mapping.files && k in mapping.files) {
      const id = mapping.files[k];
      return id && visibleVersions.has(id) ? id : null;
    }
    return suggestModel(f, models)?.versionId ?? null;
  };

  const result: BcfImportResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, comments: 0, viewpoints: 0, issues: [], warnings: [...pkg.warnings] };
  const now = new Date();

  for (const t of pkg.topics) {
    const tp = t.markup.topic;
    if (only && !only.has(tp.guid)) continue;
    const e = existing.get(tp.guid);
    const state = topicState(t, e);
    const mayEdit = !e || canEditIssue(a, e);
    const writeFields = mayEdit && (state === "new" || state === "update" || (state === "conflict" && overwrite));

    const fileMap = t.markup.files.map((f) => ({ f, versionId: versionFor(f) }));
    const versionIds = [...new Set(fileMap.map((x) => x.versionId).filter((v): v is string => !!v))];
    const unmatchedAssignee = tp.assigned_to && !userFor(tp.assigned_to) ? tp.assigned_to : undefined;
    const info: IssueImportInfo = {
      source: "bcf",
      version: pkg.version,
      ...(fileName && { fileName: fileName.slice(0, 200) }),
      importedAt: now.toISOString(),
      importedBy: a.user.id,
      topicModified: tp.modified_date || tp.creation_date || undefined,
      creationAuthor: tp.creation_author || undefined,
      ...(tp.modified_author && { modifiedAuthor: tp.modified_author }),
      ...(unmatchedAssignee && { assignedTo: unmatchedAssignee }),
      topicStatus: tp.topic_status || undefined,
      topicType: tp.topic_type || undefined,
      ...(tp.priority && { priority: tp.priority }),
      ...(tp.server_assigned_id && { serverAssignedId: tp.server_assigned_id }),
      files: fileMap.map(({ f, versionId }) => ({
        filename: f.filename ?? undefined,
        ifcProject: f.ifc_project ?? undefined,
        reference: f.reference ?? undefined,
        date: f.date ?? undefined,
        fileVersionId: versionId,
      })),
      ...(tp.document_references?.length && {
        documentReferences: tp.document_references.map((d) => ({ guid: d.guid, url: d.url ?? undefined, description: d.description ?? undefined })),
      }),
    };
    const fields = {
      title: clip(tp.title, 300) ?? tr("bcf:labels.untitled"),
      description: clip(tp.description, 10000),
      status: statusFor(tp.topic_status),
      priority: priorityFor(tp.priority),
      type: typeFor(tp.topic_type),
      assigneeUserId: userFor(tp.assigned_to),
      dueDate: dueDateFromBcf(tp.due_date),
      labels: [...new Set(tp.labels.map((l) => l.trim().slice(0, 100)).filter(Boolean))].slice(0, 50),
      stage: clip(tp.stage, 100),
      referenceLinks: tp.reference_links.map((l) => l.trim().slice(0, 2000)).filter(Boolean).slice(0, 50),
    };
    const viewpoints: IssueViewpoint[] = t.viewpoints.map((v) => {
      const snapshot = v.snapshot ? toDataUrl(v.snapshot) : undefined;
      return bcfToViewpoint(v.vis ?? { guid: v.guid }, { fileVersionIds: versionIds, snapshot });
    });

    const outcome = await db.transaction(async (tx) => {
      let issueId: string;
      let number: number;
      let changed = false;
      let primaryGuid: string | null = null;
      if (!e) {
        const [m] = await tx.select({ n: max(issues.number) }).from(issues).where(eq(issues.projectId, a.project.id));
        const id = randomUUID();
        const [row] = await tx
          .insert(issues)
          .values({
            id,
            projectId: a.project.id,
            number: (m?.n ?? 0) + 1,
            guid: tp.guid,
            ...fields,
            viewpoint: viewpoints[0] ?? null,
            createdBy: userFor(tp.creation_author) ?? a.user.id,
            createdAt: validDate(tp.creation_date) ?? now,
            updatedAt: now,
            modifiedBy: a.user.id,
            importedFrom: info,
          })
          .returning({ id: issues.id, number: issues.number });
        issueId = row!.id;
        number = row!.number;
        primaryGuid = viewpoints[0]?.guid ?? null;
        changed = true;
      } else {
        issueId = e.id;
        number = e.number;
        if (writeFields) {
          await tx.update(issues).set({ ...fields, updatedAt: now, modifiedBy: a.user.id, importedFrom: info }).where(eq(issues.id, e.id));
          changed = true;
        }
      }

      // Viewpoints: added by GUID, never replaced (BCF viewpoints are immutable).
      const [current] = await tx.select({ viewpoint: issues.viewpoint, id: issues.id }).from(issues).where(eq(issues.id, issueId));
      const have = new Set<string>();
      if (current?.viewpoint) have.add(primaryViewpointGuid(current));
      const extraRows = await tx.select({ guid: issueViewpoints.guid, idx: issueViewpoints.idx }).from(issueViewpoints).where(eq(issueViewpoints.issueId, issueId));
      extraRows.forEach((r) => have.add(r.guid));
      let nextIdx = Math.max(0, ...extraRows.map((r) => r.idx)) + 1;
      let addedVp = 0;
      for (const vp of viewpoints) {
        const g = vp.guid!;
        if (have.has(g) || g === primaryGuid) continue;
        have.add(g);
        if (!current?.viewpoint) {
          await tx.update(issues).set({ viewpoint: vp }).where(eq(issues.id, issueId));
          current!.viewpoint = vp;
        } else {
          await tx.insert(issueViewpoints).values({ issueId, guid: g, idx: nextIdx++, viewpoint: vp, createdBy: a.user.id });
        }
        addedVp++;
      }
      if (!e) addedVp += primaryGuid ? 1 : 0;

      // Comments: added by GUID; an existing one takes the file's text only when topic fields are written.
      const commentRows = await tx.select({ id: issueComments.id, guid: issueComments.guid, body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
      const byGuid = new Map(commentRows.map((c) => [c.guid, c]));
      let addedComments = 0;
      const added = new Set<string>();
      for (const c of t.markup.comments) {
        if (added.has(c.guid)) continue;
        const body = (c.comment ?? "").trim().slice(0, 10000);
        const old = byGuid.get(c.guid);
        if (old) {
          if (writeFields && body && old.body !== body) {
            await tx
              .update(issueComments)
              .set({ body, modifiedAt: validDate(c.modified_date) ?? now, modifiedBy: userFor(c.modified_author) })
              .where(eq(issueComments.id, old.id));
            changed = true;
          }
          continue;
        }
        // A BCF comment may be only a viewpoint reference; ours need a text.
        const text = body || (c.viewpoint_guid ? tr("bcf:labels.viewpointComment") : "");
        if (!text) continue;
        const author = userFor(c.author);
        await tx.insert(issueComments).values({
          issueId,
          guid: c.guid,
          authorId: author ?? a.user.id,
          importedAuthor: author ? null : clip(c.author, 200),
          body: text,
          createdAt: validDate(c.date) ?? now,
          viewpointGuid: c.viewpoint_guid ?? null,
          modifiedAt: validDate(c.modified_date),
          modifiedBy: userFor(c.modified_author),
        });
        added.add(c.guid);
        addedComments++;
      }

      const relatedGuids = tp.related_topics.map((r) => r.related_topic_guid).filter((g) => g !== tp.guid);
      if (relatedGuids.length) {
        await tx
          .insert(issueRelatedTopics)
          .values(relatedGuids.map((g) => ({ issueId, relatedGuid: g })))
          .onConflictDoNothing();
      }
      if (e && !writeFields && (addedComments || addedVp)) {
        // New comments / viewpoints from an unchanged topic are a sync, not a local change: move
        // importedAt along so the next import does not see a conflict. A kept conflict or an
        // update the caller may not write stays pending.
        const set: Partial<typeof issues.$inferInsert> = { updatedAt: now };
        if (state === "unchanged") set.importedFrom = e.importedFrom ? { ...e.importedFrom, importedAt: now.toISOString() } : info;
        await tx.update(issues).set(set).where(eq(issues.id, issueId));
        changed = true;
      }
      return { issueId, number, addedComments, addedVp, changed };
    });

    result.comments += outcome.addedComments;
    result.viewpoints += outcome.addedVp;
    let finalState: BcfImportState | "skipped" = state;
    if (state === "new") result.created++;
    else if (writeFields) result.updated++;
    else if (state === "unchanged") result.unchanged++;
    else {
      finalState = "skipped";
      result.skipped++;
      result.warnings.push(
        mayEdit
          ? tr("bcf:warnings.conflictKept", { number: outcome.number, title: fields.title })
          : tr("bcf:warnings.noEditRight", { number: outcome.number, title: fields.title }),
      );
    }
    result.issues.push({ guid: tp.guid, issueId: outcome.issueId, number: outcome.number, state: finalState });
  }

  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "issue.bcf_imported",
    targetType: "project",
    targetId: a.project.id,
    details: { fileName, version: pkg.version, created: result.created, updated: result.updated, unchanged: result.unchanged, skipped: result.skipped, comments: result.comments, viewpoints: result.viewpoints },
  });
  return result;
}
