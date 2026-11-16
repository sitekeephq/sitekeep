import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app/deps.js";
import { FolderTree, projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { forbidden, notFound } from "../core/platform/http.js";
import { msg, requestLanguage } from "../i18n/index.js";
import {
  builtInTemplates,
  createProjectFromTemplate,
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

export async function templateRoutes(api: FastifyInstance, { db }: AppDeps) {
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

  /** Creates a project with folders, grants, naming, attributes and workflows in one transaction. */
  api.post("/projects/from-template", async (req) => {
    if (!req.user!.isAdmin) throw forbidden(msg("templates:errors.adminRequired"));
    const r = await createProjectFromTemplate(db, req.user!, req.body, requestLanguage(req));
    return { ...toProjectDto(r.project, true), warnings: r.warnings, counts: r.counts, parts: r.parts };
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
