import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseCsvTable } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { publicBaseUrl } from "../oauth/config.js";
import { decodeText } from "../core/formats/text.js";
import { readXlsx } from "../core/formats/xlsx.js";
import { FolderTree, projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { badRequest, forbidden, notFound } from "../core/platform/http.js";
import { msg, requestLanguage } from "../i18n/index.js";
import {
  builtInTemplates,
  createProjectFromTemplate,
  dryRunProjectSetup,
  exportProjectTemplate,
  materializeFolders,
  previewProjectTemplate,
  templateSummaries,
} from "../projects/project-templates.js";
import { toFolderDto } from "../modules/documents/public.js";
import { toProjectDto } from "../projects/dto.js";

const languageQuery = z.string().regex(/^[a-z]{2}$/);

/** `?language=` when it is a language code, else the requester's language. */
function templateLanguage(req: FastifyRequest<{ Querystring: { language?: string } }>): string {
  const q = languageQuery.safeParse(req.query.language);
  return q.success ? q.data : requestLanguage(req);
}

export async function templateRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;
  /**
   * Built-in project templates with slots, editable dimensions, counts and v2 parts; per-language
   * names in `?language=` (the project language), else the requester's language.
   */
  api.get<{ Querystring: { language?: string } }>("/templates", async (req) => templateSummaries(templateLanguage(req)));

  /** The template JSON itself, per-language values resolved as for the list. */
  api.get<{ Params: { id: string }; Querystring: { language?: string } }>("/templates/:id", async (req) => {
    const t = builtInTemplates(templateLanguage(req)).get(req.params.id);
    if (!t) throw notFound(msg("templates:entities.template"));
    return t;
  });

  /** Validates a template (built-in id or JSON) with an optional slot mapping; returns counts and the tree. */
  api.post("/templates/preview", async (req) => previewProjectTemplate(db, req.body, requestLanguage(req)));

  /**
   * The set-up wizard's dry run (docs/features/PROJECT_SETUP_WIZARD.md): the preview with the wizard's
   * choices, the project code and the people's accounts checked. Writes nothing. Same permission as
   * creating a project.
   */
  api.post("/projects/setup/preview", async (req) => {
    if (!req.user!.isAdmin) throw forbidden(msg("templates:errors.adminRequired"));
    return dryRunProjectSetup(db, req.body, requestLanguage(req));
  });

  /**
   * People of the wizard from a CSV or Excel file: the first sheet (or the CSV, in any common
   * encoding) as a table of strings. The wizard matches the columns (people-import.ts in shared).
   */
  api.post("/projects/setup/people-file", async (req) => {
    if (!req.user!.isAdmin) throw forbidden(msg("templates:errors.adminRequired"));
    const body = z
      .object({ fileName: z.string().trim().min(1).max(255), content: z.string().min(1).max(4_000_000) })
      .parse(req.body);
    const data = Buffer.from(body.content, "base64");
    const lang = requestLanguage(req);
    let table: string[][];
    if (/\.xlsx$/i.test(body.fileName)) {
      try {
        table = readXlsx(data, lang);
      } catch {
        throw badRequest(msg("templates:errors.peopleFileUnreadable"));
      }
    } else if (/\.(csv|txt|tsv)$/i.test(body.fileName)) table = parseCsvTable(decodeText(data));
    else throw badRequest(msg("templates:errors.peopleFileType"));
    return { table: table.slice(0, 1001).map((row) => row.slice(0, 20).map((cell) => String(cell ?? "").slice(0, 500))) };
  });

  /**
   * Creates a project with folders, grants, naming, attributes, workflows, task teams and the
   * wizard's people in one transaction; the v2 parts are applied after it and reported.
   */
  api.post("/projects/from-template", async (req) => {
    if (!req.user!.isAdmin) throw forbidden(msg("templates:errors.adminRequired"));
    const r = await createProjectFromTemplate(db, req.user!, req.body, requestLanguage(req), {
      mailer: deps.mailer,
      baseUrl: publicBaseUrl(deps.oauth, req),
    });
    return { ...toProjectDto(r.project, true), warnings: r.warnings, counts: r.counts, parts: r.parts, people: r.people };
  });

  /** The project's structure as a template JSON (no files, records or people). */
  api.get<{ Params: { pid: string } }>("/projects/:pid/export-template", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const template = await exportProjectTemplate(db, a.project.id, requestLanguage(req));
    const file = `${a.project.code.replace(/[^A-Za-z0-9_-]+/g, "_")}-sablon.json`;
    reply.header("content-disposition", `attachment; filename="${file}"`);
    return template;
  });

  /** Creates on-demand (virtual) folders along a path, e.g. before the first upload. */
  api.post<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/materialize", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = z.object({ path: z.array(z.string().min(1).max(200)).min(1).max(12) }).parse(req.body);
    const r = await materializeFolders(db, a, req.params.fid, body.path);
    const tree = await FolderTree.load(db, a.project.id);
    return { folder: toFolderDto(tree, a.principal, r.folderId), created: r.created };
  });
}
