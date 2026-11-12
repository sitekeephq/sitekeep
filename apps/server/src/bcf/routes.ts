/**
 * BCF .bcfzip import / export (docs/features/BCF.md):
 *   GET  /projects/:pid/bcf/export?version=2.1|3.0&ids=…&status=…&assignedToMe=1&snapshots=0 → .bcfzip download
 *   POST /projects/:pid/bcf/export {version, issueIds?, status?, assignedToMe?, snapshots?} → JSON (link, base64 when small)
 *   POST /projects/:pid/bcf/import/preview   multipart "file" | JSON {fileName, data(base64)}  → BcfImportPreview
 *   POST /projects/:pid/bcf/import           same + "mapping" (JSON)                           → BcfImportResult
 * Export reads like the issue list (every project member). Import needs the Sorunlar module and a
 * write token; existing issues follow the issue edit rule (creator, assignee, project admin).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BCF_DEFAULT_VERSION, BCF_VERSIONS, type BcfExportInfo, type BcfImportMapping, type BcfVersion } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { isUuid, projectAccess, type ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { issues, projectMembers, users } from "../db/schema.js";
import { HttpError, badRequest } from "../core/platform/http.js";
import { requireModule } from "../projects/modules.js";
import { bcfFileName, buildBcfZip } from "./export.js";
import { bcfErrorMsg, commitImport, isBcfInputError, parseBcfPackage, previewImport } from "./import.js";
import { BCF_ZIP_LIMITS } from "./unzip.js";
import { msg, requestLanguage } from "../i18n/index.js";

/** Exports up to this size come back inline (base64) from POST …/bcf/export. */
export const BCF_INLINE_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_ISSUES = 2000;

const statusSchema = z.enum(["open", "in_progress", "in_review", "closed"]);
const versionSchema = z.enum(BCF_VERSIONS as [BcfVersion, ...BcfVersion[]]).default(BCF_DEFAULT_VERSION);

const exportSchema = z.object({
  version: versionSchema,
  issueIds: z.array(z.string().uuid()).max(MAX_EXPORT_ISSUES).optional(),
  status: statusSchema.optional(),
  assignedToMe: z.boolean().optional(),
  /** false: leave the snapshot images out (smaller files for MCP clients). */
  snapshots: z.boolean().optional(),
  /** false: only the link, never base64. */
  inline: z.boolean().optional(),
});

const mappingSchema: z.ZodType<BcfImportMapping> = z.object({
  statuses: z.record(z.string().max(200), statusSchema).optional(),
  types: z.record(z.string().max(200), z.string().max(100).nullable()).optional(),
  priorities: z.record(z.string().max(200), z.enum(["low", "normal", "high", "critical"])).optional(),
  users: z.record(z.string().max(320), z.string().uuid().nullable()).optional(),
  files: z.record(z.string().max(2000), z.string().uuid().nullable()).optional(),
  conflicts: z.enum(["keep", "overwrite"]).optional(),
  topics: z.array(z.string().max(100)).max(5000).optional(),
});

export async function bcfRoutes(api: FastifyInstance, { db, storage }: AppDeps) {
  async function selectIssues(a: ProjectAccess, q: { issueIds?: string[]; status?: string; assignedToMe?: boolean }) {
    const ids = q.issueIds?.filter(isUuid);
    if (q.issueIds && !ids?.length) throw badRequest(msg("bcf:errors.noIssuesSelected"));
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.projectId, a.project.id),
          ids ? inArray(issues.id, ids) : undefined,
          q.status ? eq(issues.status, q.status as z.infer<typeof statusSchema>) : undefined,
          q.assignedToMe ? eq(issues.assigneeUserId, a.user.id) : undefined,
        ),
      )
      .orderBy(asc(issues.number));
    if (!rows.length) throw badRequest(msg("bcf:errors.noIssuesToExport"));
    if (rows.length > MAX_EXPORT_ISSUES) throw badRequest(msg("bcf:errors.tooManyIssues", { max: MAX_EXPORT_ISSUES }));
    return rows;
  }

  async function exportZip(a: ProjectAccess, q: z.infer<typeof exportSchema>, lang: string) {
    const rows = await selectIssues(a, q);
    const members = await db
      .select({ email: users.email })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, a.project.id));
    const out = await buildBcfZip({ db, storage }, a.project, rows, q.version, members.map((m) => m.email), { snapshots: q.snapshots !== false, lang });
    const fileName = bcfFileName(a.project.code, q.version, rows.length, rows[0]?.number);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "issue.bcf_exported",
      targetType: "project",
      targetId: a.project.id,
      details: { version: q.version, topics: out.topics, size: out.zip.length },
    });
    return { ...out, fileName, rows };
  }

  api.get<{ Params: { pid: string }; Querystring: Record<string, string | undefined> }>("/projects/:pid/bcf/export", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const q = exportSchema.parse({
      version: req.query.version || undefined,
      issueIds: req.query.ids ? req.query.ids.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      status: req.query.status || undefined,
      assignedToMe: req.query.assignedToMe === "1" || undefined,
      snapshots: req.query.snapshots === "0" ? false : undefined,
    });
    const out = await exportZip(a, q, requestLanguage(req));
    return sendZip(reply, out.zip, out.fileName, out.warnings);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/bcf/export", async (req): Promise<BcfExportInfo> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const q = exportSchema.parse(req.body ?? {});
    const out = await exportZip(a, q, requestLanguage(req));
    const params = new URLSearchParams({ version: q.version });
    if (q.issueIds) params.set("ids", out.rows.map((r) => r.id).join(","));
    if (q.status) params.set("status", q.status);
    if (q.assignedToMe) params.set("assignedToMe", "1");
    if (q.snapshots === false) params.set("snapshots", "0");
    return {
      fileName: out.fileName,
      version: q.version,
      topics: out.topics,
      size: out.zip.length,
      downloadUrl: `/api/v1/projects/${a.project.id}/bcf/export?${params.toString()}`,
      ...(q.inline !== false && out.zip.length <= BCF_INLINE_BYTES && { base64: out.zip.toString("base64") }),
      warnings: out.warnings,
    };
  });

  /** The uploaded .bcfzip (multipart "file" or JSON base64) and the mapping (multipart field or JSON). */
  async function upload(req: FastifyRequest): Promise<{ fileName: string; data: Buffer; mapping: BcfImportMapping }> {
    let fileName = "";
    let data: Buffer | null = null;
    let mappingRaw: unknown = undefined;
    if (req.isMultipart()) {
      try {
        for await (const part of req.parts({ limits: { fileSize: BCF_ZIP_LIMITS.zipBytes, files: 1, fieldSize: 1024 * 1024 } })) {
          if (part.type === "field") {
            if (part.fieldname === "mapping" && typeof part.value === "string") mappingRaw = JSON.parse(part.value);
            continue;
          }
          if (data) {
            part.file.resume();
            continue;
          }
          fileName = (part.filename ?? "").slice(0, 200);
          data = await part.toBuffer();
        }
      } catch (e) {
        if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE" || (e as { statusCode?: number }).statusCode === 413) throw tooBig();
        if (e instanceof SyntaxError) throw badRequest(msg("bcf:errors.mappingNotJson"));
        throw e;
      }
    } else {
      const body = z
        .object({ fileName: z.string().max(200).optional(), data: z.string().min(1), mapping: z.unknown().optional() })
        .parse(req.body ?? {});
      fileName = body.fileName ?? "";
      data = Buffer.from(body.data, "base64");
      mappingRaw = body.mapping;
      if (data.length > BCF_ZIP_LIMITS.zipBytes) throw tooBig();
    }
    if (!data?.length) throw badRequest(msg("bcf:errors.noFile"));
    return { fileName, data, mapping: mappingRaw === undefined ? {} : mappingSchema.parse(mappingRaw) };
  }

  async function parse(data: Buffer, lang: string) {
    try {
      return await parseBcfPackage(data, lang);
    } catch (e) {
      if (isBcfInputError(e)) throw badRequest(bcfErrorMsg(e));
      throw e;
    }
  }

  // JSON bodies carry the file as base64: allow a little more than the zip limit.
  const bodyLimit = Math.ceil(BCF_ZIP_LIMITS.zipBytes * 1.4);

  api.post<{ Params: { pid: string } }>("/projects/:pid/bcf/import/preview", { bodyLimit }, async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "issues");
    const { fileName, data } = await upload(req);
    const lang = requestLanguage(req);
    return previewImport(db, a, await parse(data, lang), fileName, lang);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/bcf/import", { bodyLimit }, async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireModule(a, "issues");
    const { fileName, data, mapping } = await upload(req);
    const lang = requestLanguage(req);
    return commitImport(db, a, await parse(data, lang), mapping, fileName, lang);
  });
}

function tooBig() {
  return new HttpError(413, "too_large", msg("bcf:errors.fileTooLarge", { mb: Math.round(BCF_ZIP_LIMITS.zipBytes / 1048576) }));
}

function sendZip(reply: FastifyReply, zip: Buffer, name: string, warnings: string[]) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header("Content-Type", "application/zip");
  reply.header("Cache-Control", "private, no-store");
  // Warnings travel in a header for API clients (the web shows them after a POST export).
  if (warnings.length) reply.header("X-BCF-Warnings", encodeURIComponent(warnings.join(" | ").slice(0, 1500)));
  return reply.send(zip);
}
