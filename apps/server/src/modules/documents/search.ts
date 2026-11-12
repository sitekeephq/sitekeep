import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { can, foldTr, type SearchResultDto } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, userNames } from "../../core/security/access.js";
import { attributeDefinitions, fileVersions, files, versionTexts } from "../../db/schema.js";
import { badRequest, notFound } from "../../core/platform/http.js";
import { msg } from "../../i18n/index.js";
import { toFileDto } from "./files.js";

/** Rows read from the database before permission filtering. */
const SCAN_LIMIT = 5000;

/**
 * SQL side of foldTr(): Turkish I letters become "i" before lower(), so matching does not
 * depend on the database collation (PGlite runs with the C locale).
 */
const fold = (expr: SQL) => sql`lower(translate(${expr}, 'İIıŞĞÜÖÇ', 'iiişğüöç'))`; // i18n-ok: Turkish case folding
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

type Query = Record<string, string | string[] | undefined>;

/**
 * GET /projects/:pid/search?q=&folderId=&ext=pdf,ifc&attr.<name>=<value>&limit=
 * - q: part of the file name, of any attribute value or of the latest version's text (office,
 *   sheet, drawing, PDF; case-insensitive, Turkish I aware). Text hits carry a short snippet.
 * - folderId: only that folder and its subfolders
 * - attr.<name>: list/date/number attributes match exactly, text attributes by substring
 * Returns only files the caller can view, with their folder path.
 */
export async function searchRoutes(api: FastifyInstance, { db }: AppDeps) {
  /** About 160 characters of text around the first match (fold() keeps positions: translate/lower are 1:1). */
  async function textSnippets(versionIds: string[], folded: string): Promise<Map<string, string>> {
    if (!versionIds.length) return new Map();
    const at = sql`strpos(${fold(sql`${versionTexts.content}`)}, ${folded})`;
    const rows = await db
      .select({
        versionId: versionTexts.versionId,
        pos: sql<number>`${at}`,
        excerpt: sql<string>`substr(${versionTexts.content}, greatest(${at} - 60, 1), ${folded.length + 120})`,
      })
      .from(versionTexts)
      .where(and(inArray(versionTexts.versionId, versionIds), sql`${at} > 0`));
    return new Map(
      rows.map((r) => {
        const t = r.excerpt.replace(/\s+/g, " ").trim();
        return [r.versionId, `${Number(r.pos) > 61 ? "…" : ""}${t}…`];
      }),
    );
  }

  api.get<{ Params: { pid: string }; Querystring: Query }>("/projects/:pid/search", async (req): Promise<SearchResultDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const query = req.query;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
    const q = one(query.q);
    const limit = Math.min(Math.max(Number(one(query.limit)) || 200, 1), 1000);

    const where: (SQL | undefined)[] = [eq(files.projectId, a.project.id), isNull(files.deletedAt)];

    const folderId = one(query.folderId);
    if (folderId) {
      if (!isUuid(folderId) || !tree.byId.has(folderId) || !tree.visible(a.principal, folderId)) throw notFound(msg("documents:entities.folder"));
      where.push(inArray(files.folderId, [folderId, ...tree.descendants(folderId)]));
    }

    if (q) {
      if (q.length > 200) throw badRequest(msg("documents:errors.searchTooLong"));
      const pattern = `%${likeEscape(foldTr(q))}%`;
      where.push(
        or(
          sql`${fold(sql`${files.name}`)} like ${pattern}`,
          sql`exists (select 1 from jsonb_each_text(${files.attributes}) as kv(key, value) where ${fold(sql`kv.value`)} like ${pattern})`,
          sql`exists (select 1 from ${versionTexts} where ${versionTexts.versionId} = ${fileVersions.id} and ${fold(sql`${versionTexts.content}`)} like ${pattern})`,
        ),
      );
    }

    const exts = one(query.ext)
      .split(",")
      .map((e) => e.trim().replace(/^\*?\./, "").toLowerCase())
      .filter(Boolean);
    if (exts.length) where.push(or(...exts.map((e) => sql`lower(${files.name}) like ${`%.${likeEscape(e)}`}`)));

    const attrFilters = Object.entries(query)
      .filter(([k]) => k.startsWith("attr.") && k.length > 5)
      .map(([k, v]) => [k.slice(5), one(v)] as const)
      .filter(([, v]) => v);
    if (attrFilters.length) {
      const defs = await db
        .select({ name: attributeDefinitions.name, type: attributeDefinitions.type })
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.projectId, a.project.id));
      const types = new Map(defs.map((d) => [d.name, d.type]));
      for (const [name, value] of attrFilters) {
        const field = fold(sql`${files.attributes} ->> ${name}::text`);
        const exact = ["list", "date", "number"].includes(types.get(name) ?? "text");
        where.push(
          exact ? sql`${field} = ${foldTr(value)}` : sql`${field} like ${`%${likeEscape(foldTr(value))}%`}`,
        );
      }
    }

    const rows = await db
      .select()
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(...where))
      .orderBy(asc(files.name))
      .limit(SCAN_LIMIT);

    const visible = rows.filter((r) => {
      if (!tree.byId.has(r.files.folderId)) return false;
      const perm = tree.permission(a.principal, r.files.folderId);
      // Upload-only users see just their own files, as in the folder listing.
      return can(perm.level, "view") || (perm.canUpload && r.files.createdBy === a.user.id);
    });
    const page = visible.slice(0, limit);
    const names = await userNames(db, page.map((r) => r.file_versions.uploadedBy));
    const snippets = q ? await textSnippets(page.map((r) => r.file_versions.id), foldTr(q)) : new Map<string, string>();
    return {
      results: page
        .map((r) => ({
          ...toFileDto(r.files, r.file_versions, names),
          ...(snippets.has(r.file_versions.id) && { snippet: snippets.get(r.file_versions.id) }),
          folderPath: tree
            .ancestry(r.files.folderId)
            .map((id) => tree.get(id).name)
            .join(" / "),
        }))
        .sort((x, y) => x.name.localeCompare(y.name, "tr") || x.folderPath.localeCompare(y.folderPath, "tr")),
      truncated: visible.length > limit || rows.length === SCAN_LIMIT,
    };
  });
}
