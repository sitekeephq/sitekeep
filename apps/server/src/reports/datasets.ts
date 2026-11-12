/**
 * Semantic data layer for report dashboards.
 *
 * A dataset is a named, typed table that is loaded with the CALLER's permissions
 * (files only from folders they can view, activity only for project admins …). Report
 * queries never touch SQL; they filter and aggregate these rows (see engine.ts).
 *
 * Features add their own datasets with `reportDatasets.register(name, def)`, e.g. a
 * workflow branch registering `reviews` or `rfis`.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  REPORT_VALUE_LABELS_TR,
  can,
  splitExtension,
  type ReportDatasetDto,
  type ReportFieldType,
  type ReportModule,
  type ReportRow,
} from "@sitekeep/shared";
import { FolderTree, type ProjectAccess } from "../core/security/access.js";
import { DEFAULT_LANGUAGE, labelFor, msg, render, type Msg } from "../i18n/index.js";
import type { Db } from "../db/index.js";
import { auditLog, companies, fileVersions, files, issues, projectMembers, users } from "../db/schema.js";
import type { FieldSource } from "./engine.js";
import type { StampScope } from "./stamp.js";
import { loadingModule } from "../app/module-owner.js";
import { moduleIds } from "../app/module-ids.js";

/**
 * Texts of a dataset are shown in the report builder (in the reader's language) and written into
 * the AI builder's prompt (see prompt.ts): a Msg, or a plain string that is already final.
 */
export type DatasetText = string | Msg;

/** A value label of an @sitekeep/shared enum table, rendered in the reader's language (labelFor). */
export interface LabelRef {
  table: string;
  key: string;
}

/** Known values of a field from a shared label table: `labelValues("outcome", OUTCOME_LABELS_TR)`. */
export function labelValues(table: string, codes: Record<string, unknown>, prefix = ""): Record<string, LabelRef> {
  return Object.fromEntries(Object.keys(codes).map((code) => [code, { table, key: prefix + code }]));
}

export interface DatasetField {
  type: ReportFieldType;
  label: DatasetText;
  description?: DatasetText;
  /** Known values (code → label). */
  values?: Record<string, DatasetText | LabelRef>;
}

export interface DatasetDef extends FieldSource {
  label: DatasetText;
  description: DatasetText;
  /** Module family: templates, the module pages' "Rapor" shortcut and AI dataset routing. */
  module: ReportModule;
  /** Change-stamp scopes whose writes change the rows (live refresh, see stamp.ts). */
  sources: StampScope[];
  fields: Record<string, DatasetField>;
  /** Fields with this prefix are allowed too (e.g. `attributes.`). */
  dynamicPrefix?: string;
  dynamicType?: ReportFieldType;
  dynamicDescription?: DatasetText;
  /** Only project administrators may query this dataset. */
  adminOnly?: boolean;
  /** Extra access rule; return the reason to deny. */
  deny?(ctx: { access: ProjectAccess }): DatasetText | null;
  /** Loads every row the caller may see. */
  load(ctx: ReportContext): Promise<ReportRow[]>;
  /**
   * Loads the rows for one query instead of `load` (datasets scoped by required filters, e.g. one
   * IFC model). Not cached across queries.
   */
  loadFor?(ctx: ReportContext, spec: import("@sitekeep/shared").ReportQuerySpec): Promise<ReportRow[]>;
}

export class DatasetRegistry {
  private readonly all = new Map<string, DatasetDef>();
  /** The module that registered each dataset (app/module-owner.ts); the core's have none. */
  private readonly owners = new Map<string, string>();

  register(name: string, def: DatasetDef): void {
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(name)) throw new Error(`Invalid dataset name: ${name}`);
    if (this.all.has(name)) throw new Error(`Dataset already registered: ${name}`);
    this.all.set(name, def);
    const owner = loadingModule();
    if (owner) this.owners.set(name, owner);
  }

  /** Datasets whose module is on (a module that is off hides its datasets; their data stays). */
  private get defs(): Map<string, DatasetDef> {
    if (!this.owners.size) return this.all;
    const on = moduleIds();
    return new Map([...this.all].filter(([n]) => !this.owners.has(n) || on.includes(this.owners.get(n)!)));
  }

  get(name: string): DatasetDef | undefined {
    return this.defs.get(name);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  /** Datasets of a module family, in registration order. */
  ofModule(module: ReportModule): string[] {
    return [...this.defs.entries()].filter(([, d]) => d.module === module).map(([n]) => n);
  }

  /** Change-stamp scopes behind the given datasets (unknown names are ignored). */
  sourcesOf(names: Iterable<string>): StampScope[] {
    const out = new Set<StampScope>();
    const defs = this.defs;
    for (const n of names) for (const s of defs.get(n)?.sources ?? []) out.add(s);
    return [...out];
  }

  /**
   * Datasets visible to the caller, as a catalog for the UI (the reader's language) and the AI
   * prompt (PROMPT_LANGUAGE, see prompt.ts).
   */
  describe(ctx?: { access: ProjectAccess }, lang: string = DEFAULT_LANGUAGE): ReportDatasetDto[] {
    const text = (v: DatasetText) => render(lang, v);
    const value = (v: DatasetText | LabelRef) => (typeof v === "object" && "table" in v ? labelFor(lang, v.table, v.key) : text(v));
    const opt = (v: DatasetText | undefined) => (v === undefined ? undefined : text(v));
    return [...this.defs.entries()]
      .filter(([, d]) => !ctx || !d.adminOnly || ctx.access.isProjectAdmin)
      .map(([name, d]) => ({
        name,
        label: text(d.label),
        description: text(d.description),
        adminOnly: d.adminOnly || undefined,
        dynamicPrefix: d.dynamicPrefix,
        module: d.module,
        fields: Object.entries(d.fields).map(([fname, f]) => ({
          name: fname,
          type: f.type,
          label: text(f.label),
          description: opt(f.description),
          values: f.values ? Object.fromEntries(Object.entries(f.values).map(([code, v]) => [code, value(v)])) : undefined,
        })),
      }));
  }
}

// ---- Context ------------------------------------------------------------------------

export interface People {
  name(userId: string | null | undefined): string | null;
  /** Company the user represents in this project (falls back to their own company). */
  company(userId: string | null | undefined): string | null;
  companyName(companyId: string | null | undefined): string | null;
  /** Loads names of users that are no longer members. */
  ensure(userIds: (string | null | undefined)[]): Promise<void>;
}

export interface ReportContext {
  db: Db;
  access: ProjectAccess;
  now: Date;
  timeZone: string;
  /** The reader's language, for labels inside rows. */
  lang: string;
  tree(): Promise<FolderTree>;
  people(): Promise<People>;
  /** Rows of a dataset, loaded once per context. */
  rows(dataset: string, def: DatasetDef): Promise<ReportRow[]>;
  /** Shared intermediate data of several datasets (e.g. visible works with their workflow state), once per context. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export const REPORT_TIME_ZONE = process.env.REPORT_TZ || "Europe/Istanbul";

export function createReportContext(
  db: Db,
  access: ProjectAccess,
  opts: { now?: Date; timeZone?: string; lang?: string } = {},
): ReportContext {
  let tree: Promise<FolderTree> | null = null;
  let people: Promise<People> | null = null;
  const cache = new Map<string, Promise<ReportRow[]>>();
  const memos = new Map<string, Promise<unknown>>();
  const ctx: ReportContext = {
    db,
    access,
    now: opts.now ?? new Date(),
    timeZone: opts.timeZone ?? REPORT_TIME_ZONE,
    lang: opts.lang ?? DEFAULT_LANGUAGE,
    tree: () => (tree ??= FolderTree.load(db, access.project.id)),
    people: () => (people ??= loadPeople(db, access.project.id)),
    rows: (name, def) => {
      let p = cache.get(name);
      if (!p) cache.set(name, (p = def.load(ctx)));
      return p;
    },
    memo: <T>(key: string, load: () => Promise<T>) => {
      let p = memos.get(key) as Promise<T> | undefined;
      if (!p) memos.set(key, (p = load()));
      return p;
    },
  };
  return ctx;
}

async function loadPeople(db: Db, projectId: string): Promise<People> {
  const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const companyNames = new Map(companyRows.map((c) => [c.id, c.name]));
  const memberRows = await db
    .select({ id: users.id, name: users.name, memberCompany: projectMembers.companyId, userCompany: users.companyId })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  const names = new Map<string, string>();
  const companyOf = new Map<string, string | null>();
  for (const m of memberRows) {
    names.set(m.id, m.name);
    companyOf.set(m.id, m.memberCompany ?? m.userCompany);
  }
  return {
    name: (id) => (id ? names.get(id) ?? null : null),
    company: (id) => {
      const cid = id ? companyOf.get(id) : null;
      return cid ? companyNames.get(cid) ?? null : null;
    },
    companyName: (cid) => (cid ? companyNames.get(cid) ?? null : null),
    async ensure(ids) {
      const missing = [...new Set(ids.filter((x): x is string => !!x && !names.has(x)))];
      if (!missing.length) return;
      const rows = await db
        .select({ id: users.id, name: users.name, companyId: users.companyId })
        .from(users)
        .where(inArray(users.id, missing));
      for (const r of rows) {
        names.set(r.id, r.name);
        companyOf.set(r.id, r.companyId);
      }
    },
  };
}

// ---- Helpers for file-based datasets ------------------------------------------------

export interface FolderInfo {
  path: string;
  name: string;
  state: string | null;
}

export function folderInfo(tree: FolderTree, folderId: string, cache: Map<string, FolderInfo>): FolderInfo {
  let info = cache.get(folderId);
  if (!info) {
    const chain = tree.ancestry(folderId).map((id) => tree.get(id));
    const shown = chain.length > 1 ? chain.slice(1) : chain; // without the project root
    info = {
      path: shown.map((f) => f.name).join(" / "),
      name: chain[chain.length - 1]!.name,
      state: [...chain].reverse().find((f) => f.state)?.state ?? null,
    };
    cache.set(folderId, info);
  }
  return info;
}

/** Same rule as the file endpoints: view permission, or upload-only on one's own files. */
export function fileVisibility(tree: FolderTree, access: ProjectAccess) {
  const perms = new Map<string, ReturnType<FolderTree["permission"]>>();
  return (file: { folderId: string; createdBy: string | null }) => {
    if (!tree.byId.has(file.folderId)) return false;
    let p = perms.get(file.folderId);
    if (!p) perms.set(file.folderId, (p = tree.permission(access.principal, file.folderId)));
    if (can(p.level, "view")) return true;
    return p.canUpload && file.createdBy === access.user.id;
  };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const FOLDER_STATE = labelValues("reportValue", REPORT_VALUE_LABELS_TR.folderState!, "folderState.");
const ISSUE_STATUS = labelValues("reportValue", REPORT_VALUE_LABELS_TR.status!, "status.");
const ISSUE_PRIORITY = labelValues("reportValue", REPORT_VALUE_LABELS_TR.priority!, "priority.");
const DERIVATIVE = labelValues("reportValue", REPORT_VALUE_LABELS_TR.derivativeStatus!, "derivativeStatus.");

// ---- Built-in datasets --------------------------------------------------------------

export const reportDatasets = new DatasetRegistry();

reportDatasets.register("files", {
  label: msg("reports:datasets.files.label"),
  module: "documents",
  sources: ["files"],
  description: msg("reports:datasets.files.description"),
  fields: {
    id: { type: "string", label: msg("reports:datasets.files.fields.id") },
    name: { type: "string", label: msg("reports:datasets.files.fields.name") },
    extension: { type: "string", label: msg("reports:datasets.files.fields.extension"), description: msg("reports:datasets.files.hints.extension") },
    folder: { type: "string", label: msg("reports:datasets.files.fields.folder") },
    folderPath: { type: "string", label: msg("reports:datasets.files.fields.folderPath"), description: msg("reports:datasets.files.hints.folderPath") },
    folderState: { type: "string", label: msg("reports:datasets.files.fields.folderState"), values: FOLDER_STATE },
    currentVersion: { type: "number", label: msg("reports:datasets.files.fields.currentVersion") },
    size: { type: "number", label: msg("reports:datasets.files.fields.size"), description: msg("reports:datasets.files.hints.size") },
    uploader: { type: "string", label: msg("reports:datasets.files.fields.uploader") },
    uploaderCompany: { type: "string", label: msg("reports:datasets.files.fields.uploaderCompany") },
    uploadedAt: { type: "date", label: msg("reports:datasets.files.fields.uploadedAt") },
    createdBy: { type: "string", label: msg("reports:datasets.files.fields.createdBy") },
    createdAt: { type: "date", label: msg("reports:datasets.files.fields.createdAt") },
  },
  dynamicPrefix: "attributes.",
  dynamicType: "string",
  dynamicDescription: msg("reports:datasets.files.dynamicDescription"),
  async load(ctx) {
    const tree = await ctx.tree();
    const people = await ctx.people();
    const visible = fileVisibility(tree, ctx.access);
    const rows = await ctx.db
      .select()
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(eq(files.projectId, ctx.access.project.id), isNull(files.deletedAt)));
    const shown = rows.filter((r) => visible(r.files));
    await people.ensure(shown.flatMap((r) => [r.files.createdBy, r.file_versions.uploadedBy]));
    const folders = new Map<string, FolderInfo>();
    return shown.map(({ files: f, file_versions: v }) => {
      const fi = folderInfo(tree, f.folderId, folders);
      const row: ReportRow = {
        id: f.id,
        name: f.name,
        extension: splitExtension(f.name).extension.toLowerCase(),
        folder: fi.name,
        folderPath: fi.path,
        folderState: fi.state,
        currentVersion: f.currentVersion,
        size: v.size,
        uploader: people.name(v.uploadedBy),
        uploaderCompany: people.company(v.uploadedBy),
        uploadedAt: iso(v.uploadedAt),
        createdBy: people.name(f.createdBy),
        createdAt: iso(f.createdAt),
      };
      for (const [k, val] of Object.entries(f.attributes ?? {})) row[`attributes.${k}`] = val;
      return row;
    });
  },
});

reportDatasets.register("versions", {
  label: msg("reports:datasets.versions.label"),
  module: "documents",
  sources: ["files"],
  description: msg("reports:datasets.versions.description"),
  fields: {
    fileId: { type: "string", label: msg("reports:datasets.versions.fields.fileId") },
    file: { type: "string", label: msg("reports:datasets.versions.fields.file") },
    extension: { type: "string", label: msg("reports:datasets.versions.fields.extension") },
    folderPath: { type: "string", label: msg("reports:datasets.versions.fields.folderPath") },
    folderState: { type: "string", label: msg("reports:datasets.versions.fields.folderState"), values: FOLDER_STATE },
    version: { type: "number", label: msg("reports:datasets.versions.fields.version") },
    isLatest: { type: "boolean", label: msg("reports:datasets.versions.fields.isLatest") },
    uploader: { type: "string", label: msg("reports:datasets.versions.fields.uploader") },
    uploaderCompany: { type: "string", label: msg("reports:datasets.versions.fields.uploaderCompany") },
    uploadedAt: { type: "date", label: msg("reports:datasets.versions.fields.uploadedAt") },
    size: { type: "number", label: msg("reports:datasets.versions.fields.size") },
    derivativeStatus: { type: "string", label: msg("reports:datasets.versions.fields.derivativeStatus"), values: DERIVATIVE },
  },
  async load(ctx) {
    const tree = await ctx.tree();
    const people = await ctx.people();
    const visible = fileVisibility(tree, ctx.access);
    const rows = await ctx.db
      .select()
      .from(files)
      .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
      .where(and(eq(files.projectId, ctx.access.project.id), isNull(files.deletedAt)));
    const shown = rows.filter((r) => visible(r.files));
    await people.ensure(shown.map((r) => r.file_versions.uploadedBy));
    const folders = new Map<string, FolderInfo>();
    return shown.map(({ files: f, file_versions: v }) => {
      const fi = folderInfo(tree, f.folderId, folders);
      return {
        fileId: f.id,
        file: f.name,
        extension: splitExtension(f.name).extension.toLowerCase(),
        folderPath: fi.path,
        folderState: fi.state,
        version: v.version,
        isLatest: v.version === f.currentVersion,
        uploader: people.name(v.uploadedBy),
        uploaderCompany: people.company(v.uploadedBy),
        uploadedAt: iso(v.uploadedAt),
        size: v.size,
        derivativeStatus: v.derivativeStatus,
      };
    });
  },
});

reportDatasets.register("issues", {
  label: msg("reports:datasets.issues.label"),
  module: "issues",
  sources: ["issues", "members"],
  description: msg("reports:datasets.issues.description"),
  fields: {
    number: { type: "number", label: msg("reports:datasets.issues.fields.number") },
    title: { type: "string", label: msg("reports:datasets.issues.fields.title") },
    status: { type: "string", label: msg("reports:datasets.issues.fields.status"), values: ISSUE_STATUS },
    isOpen: { type: "boolean", label: msg("reports:datasets.issues.fields.isOpen"), description: msg("reports:datasets.issues.hints.isOpen") },
    priority: { type: "string", label: msg("reports:datasets.issues.fields.priority"), values: ISSUE_PRIORITY },
    type: { type: "string", label: msg("reports:datasets.issues.fields.type") },
    assignee: { type: "string", label: msg("reports:datasets.issues.fields.assignee") },
    assigneeCompany: { type: "string", label: msg("reports:datasets.issues.fields.assigneeCompany"), description: msg("reports:datasets.issues.hints.assigneeCompany") },
    createdBy: { type: "string", label: msg("reports:datasets.issues.fields.createdBy") },
    createdByCompany: { type: "string", label: msg("reports:datasets.issues.fields.createdByCompany") },
    dueDate: { type: "date", label: msg("reports:datasets.issues.fields.dueDate"), description: msg("reports:datasets.issues.hints.dueDate") },
    createdAt: { type: "date", label: msg("reports:datasets.issues.fields.createdAt") },
    updatedAt: { type: "date", label: msg("reports:datasets.issues.fields.updatedAt") },
    overdue: { type: "boolean", label: msg("reports:datasets.issues.fields.overdue"), description: msg("reports:datasets.issues.hints.overdue") },
    daysOverdue: { type: "number", label: msg("reports:datasets.issues.fields.daysOverdue"), description: msg("reports:datasets.issues.hints.daysOverdue") },
  },
  async load(ctx) {
    const people = await ctx.people();
    const rows = await ctx.db.select().from(issues).where(eq(issues.projectId, ctx.access.project.id));
    await people.ensure(rows.flatMap((r) => [r.createdBy, r.assigneeUserId]));
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: ctx.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ctx.now);
    const dayMs = 86_400_000;
    return rows.map((r) => {
      const open = r.status !== "closed";
      const overdue = open && !!r.dueDate && r.dueDate < today;
      return {
        number: r.number,
        title: r.title,
        status: r.status,
        isOpen: open,
        priority: r.priority,
        type: r.type,
        assignee: people.name(r.assigneeUserId),
        assigneeCompany: r.assigneeCompanyId ? people.companyName(r.assigneeCompanyId) : people.company(r.assigneeUserId),
        createdBy: people.name(r.createdBy),
        createdByCompany: people.company(r.createdBy),
        dueDate: r.dueDate,
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
        overdue,
        daysOverdue: overdue ? Math.round((Date.parse(today) - Date.parse(r.dueDate!)) / dayMs) : null,
      };
    });
  },
});

reportDatasets.register("activity", {
  label: msg("reports:datasets.activity.label"),
  module: "project",
  sources: ["activity"],
  description: msg("reports:datasets.activity.description"),
  adminOnly: true,
  fields: {
    action: {
      type: "string",
      label: msg("reports:datasets.activity.fields.action"),
      description: msg("reports:datasets.activity.hints.action"),
    },
    targetType: { type: "string", label: msg("reports:datasets.activity.fields.targetType"), description: msg("reports:datasets.activity.hints.targetType") },
    user: { type: "string", label: msg("reports:datasets.activity.fields.user") },
    userCompany: { type: "string", label: msg("reports:datasets.activity.fields.userCompany") },
    at: { type: "date", label: msg("reports:datasets.activity.fields.at") },
  },
  async load(ctx) {
    const people = await ctx.people();
    const rows = await ctx.db
      .select({ action: auditLog.action, targetType: auditLog.targetType, userId: auditLog.userId, at: auditLog.at })
      .from(auditLog)
      .where(eq(auditLog.projectId, ctx.access.project.id));
    await people.ensure(rows.map((r) => r.userId));
    return rows.map((r) => ({
      action: r.action,
      targetType: r.targetType,
      user: people.name(r.userId),
      userCompany: people.company(r.userId),
      at: iso(r.at),
    }));
  },
});

reportDatasets.register("members", {
  label: msg("reports:datasets.members.label"),
  module: "project",
  sources: ["members"],
  description: msg("reports:datasets.members.description"),
  fields: {
    name: { type: "string", label: msg("reports:datasets.members.fields.name") },
    company: { type: "string", label: msg("reports:datasets.members.fields.company") },
    projectAdmin: { type: "boolean", label: msg("reports:datasets.members.fields.projectAdmin") },
  },
  async load(ctx) {
    const rows = await ctx.db
      .select({
        name: users.name,
        memberCompany: projectMembers.companyId,
        userCompany: users.companyId,
        isProjectAdmin: projectMembers.isProjectAdmin,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, ctx.access.project.id));
    const people = await ctx.people();
    return rows.map((r) => ({
      name: r.name,
      company: people.companyName(r.memberCompany ?? r.userCompany),
      projectAdmin: r.isProjectAdmin,
    }));
  },
});

reportDatasets.register("models", {
  label: msg("reports:datasets.models.label"),
  module: "models",
  sources: ["files"],
  description: msg("reports:datasets.models.description"),
  fields: {
    fileId: { type: "string", label: msg("reports:datasets.models.fields.fileId") },
    file: { type: "string", label: msg("reports:datasets.models.fields.file") },
    folderPath: { type: "string", label: msg("reports:datasets.models.fields.folderPath") },
    version: { type: "number", label: msg("reports:datasets.models.fields.version") },
    isLatest: { type: "boolean", label: msg("reports:datasets.models.fields.isLatest") },
    uploadedAt: { type: "date", label: msg("reports:datasets.models.fields.uploadedAt") },
    uploader: { type: "string", label: msg("reports:datasets.models.fields.uploader") },
    uploaderCompany: { type: "string", label: msg("reports:datasets.models.fields.uploaderCompany") },
    derivativeStatus: { type: "string", label: msg("reports:datasets.models.fields.derivativeStatus"), values: DERIVATIVE },
    schema: { type: "string", label: msg("reports:datasets.models.fields.schema"), description: msg("reports:datasets.models.hints.schema") },
    elementCount: { type: "number", label: msg("reports:datasets.models.fields.elementCount") },
    ifcClass: { type: "string", label: msg("reports:datasets.models.fields.ifcClass"), description: msg("reports:datasets.models.hints.ifcClass") },
    classCount: { type: "number", label: msg("reports:datasets.models.fields.classCount") },
  },
  async load(ctx) {
    const tree = await ctx.tree();
    const people = await ctx.people();
    const visible = fileVisibility(tree, ctx.access);
    const rows = await ctx.db
      .select()
      .from(files)
      .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
      .where(and(eq(files.projectId, ctx.access.project.id), isNull(files.deletedAt)));
    const shown = rows.filter(
      (r) => splitExtension(r.files.name).extension.toLowerCase() === "ifc" && visible(r.files),
    );
    await people.ensure(shown.map((r) => r.file_versions.uploadedBy));
    const folders = new Map<string, FolderInfo>();
    const out: ReportRow[] = [];
    for (const { files: f, file_versions: v } of shown) {
      const base: ReportRow = {
        fileId: f.id,
        file: f.name,
        folderPath: folderInfo(tree, f.folderId, folders).path,
        version: v.version,
        isLatest: v.version === f.currentVersion,
        uploadedAt: iso(v.uploadedAt),
        uploader: people.name(v.uploadedBy),
        uploaderCompany: people.company(v.uploadedBy),
        derivativeStatus: v.derivativeStatus,
        schema: v.ifcSummary?.schema ?? null,
        elementCount: v.ifcSummary?.elementCount ?? null,
      };
      const classes = Object.entries(v.ifcSummary?.byClass ?? {});
      if (!classes.length) out.push({ ...base, ifcClass: null, classCount: 0 });
      for (const [cls, n] of classes) out.push({ ...base, ifcClass: cls, classCount: n });
    }
    return out;
  },
});
