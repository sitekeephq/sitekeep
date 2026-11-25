import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  savedSearchParams,
  searchParamsFromQuery,
  searchParamsToQuery,
  type DocSearchParams,
  type SavedSearchDto,
  type SavedSearchShareDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { audit } from "../../core/platform/audit.js";
import { isUuid, projectAccess, requireProjectAdmin, userNames, type ProjectAccess } from "../../core/security/access.js";
import { badRequest, forbidden, notFound } from "../../core/platform/http.js";
import type { Db } from "../../db/index.js";
import { companies, projectCompanies, projectMembers, savedSearchShares, savedSearches } from "../../db/schema.js";
import { msg } from "../../i18n/index.js";

type Row = typeof savedSearches.$inferSelect;

const nameSchema = z.string().trim().min(1).max(120);
const inputSchema = z.object({ name: nameSchema, params: z.record(z.string(), z.unknown()).default({}) });
const patchSchema = z.object({ name: nameSchema.optional(), params: z.record(z.string(), z.unknown()).optional() });
const sharesSchema = z.object({
  shares: z
    .array(z.object({ subjectType: z.enum(["user", "company", "project"]), subjectId: z.string().uuid() }))
    .max(200),
});

/** Stored parameters: normalised through the query string form (unknown keys and values dropped). */
function normalise(params: Record<string, unknown>): DocSearchParams {
  const query: Record<string, string> = {};
  const raw = params as DocSearchParams;
  try {
    for (const [k, v] of searchParamsToQuery(raw).entries()) query[k] = v;
  } catch {
    throw badRequest(msg("documents:errors.savedSearchNameRequired"));
  }
  return savedSearchParams(searchParamsFromQuery(query));
}

/**
 * Saved document searches (docs/features/DOCUMENT_SEARCH.md). Everyone keeps their own; a project
 * administrator shares one with members, companies on the project or the whole project. A saved
 * search stores parameters only, so running a shared one shows what the runner may see.
 */
export async function savedSearchRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.get<{ Params: { pid: string } }>("/projects/:pid/saved-searches", async (req): Promise<SavedSearchDto[]> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const shared = sql`${savedSearches.id} in (select ${savedSearchShares.searchId} from ${savedSearchShares} where
      (${savedSearchShares.subjectType} = 'user' and ${savedSearchShares.subjectId} = ${a.user.id})
      or (${savedSearchShares.subjectType} = 'project' and ${savedSearchShares.subjectId} = ${a.project.id})
      ${a.principal.companyId ? sql`or (${savedSearchShares.subjectType} = 'company' and ${savedSearchShares.subjectId} = ${a.principal.companyId})` : sql``})`;
    const rows = await db
      .select()
      .from(savedSearches)
      .where(and(eq(savedSearches.projectId, a.project.id), or(eq(savedSearches.ownerId, a.user.id), shared)))
      .orderBy(asc(savedSearches.name));
    return toDtos(db, a, rows);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/saved-searches", async (req): Promise<SavedSearchDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const body = inputSchema.safeParse(req.body ?? {});
    if (!body.success) throw badRequest(msg("documents:errors.savedSearchNameRequired"));
    const [row] = await db
      .insert(savedSearches)
      .values({ projectId: a.project.id, ownerId: a.user.id, name: body.data.name, params: normalise(body.data.params) })
      .returning();
    return (await toDtos(db, a, [row!]))[0]!;
  });

  api.patch<{ Params: { pid: string; id: string } }>("/projects/:pid/saved-searches/:id", async (req): Promise<SavedSearchDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadEditable(db, a, req.params.id);
    const body = patchSchema.safeParse(req.body ?? {});
    if (!body.success) throw badRequest(msg("documents:errors.savedSearchNameRequired"));
    const [next] = await db
      .update(savedSearches)
      .set({
        ...(body.data.name !== undefined && { name: body.data.name }),
        ...(body.data.params !== undefined && { params: normalise(body.data.params) }),
        updatedAt: new Date(),
      })
      .where(eq(savedSearches.id, row.id))
      .returning();
    return (await toDtos(db, a, [next!]))[0]!;
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/saved-searches/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const row = await loadEditable(db, a, req.params.id);
    await db.delete(savedSearches).where(eq(savedSearches.id, row.id));
    return { ok: true };
  });

  /** Replaces who the search is shared with (project administrators). */
  api.put<{ Params: { pid: string; id: string } }>("/projects/:pid/saved-searches/:id/shares", async (req): Promise<SavedSearchDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const row = await loadVisible(db, a, req.params.id);
    const body = sharesSchema.parse(req.body ?? {});
    const shares = uniqueShares(body.shares);
    await checkSubjects(db, a, shares);
    await db.transaction(async (tx) => {
      await tx.delete(savedSearchShares).where(eq(savedSearchShares.searchId, row.id));
      if (shares.length) await tx.insert(savedSearchShares).values(shares.map((s) => ({ searchId: row.id, ...s })));
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "saved_search.shared",
      targetType: "saved_search",
      targetId: row.id,
      details: { name: row.name, shares: shares.map((s) => `${s.subjectType}:${s.subjectId}`) },
    });
    return (await toDtos(db, a, [row]))[0]!;
  });
}

function uniqueShares(list: { subjectType: SavedSearchShareDto["subjectType"]; subjectId: string }[]) {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.subjectType}:${s.subjectId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Shares go to members of the project, companies on it, or the project itself. */
async function checkSubjects(db: Db, a: ProjectAccess, shares: { subjectType: string; subjectId: string }[]) {
  const bad = () => badRequest(msg("documents:errors.savedSearchShareSubject"));
  const userIds = shares.filter((s) => s.subjectType === "user").map((s) => s.subjectId);
  const companyIds = shares.filter((s) => s.subjectType === "company").map((s) => s.subjectId);
  if (shares.some((s) => s.subjectType === "project" && s.subjectId !== a.project.id)) throw bad();
  if (userIds.length) {
    const rows = await db
      .select({ id: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, a.project.id), inArray(projectMembers.userId, userIds)));
    if (rows.length !== new Set(userIds).size) throw bad();
  }
  if (companyIds.length) {
    const rows = await db
      .select({ id: projectCompanies.companyId })
      .from(projectCompanies)
      .where(and(eq(projectCompanies.projectId, a.project.id), inArray(projectCompanies.companyId, companyIds)));
    if (rows.length !== new Set(companyIds).size) throw bad();
  }
}

/** A search the caller can see (own or shared with them); 404 otherwise. */
async function loadVisible(db: Db, a: ProjectAccess, id: string): Promise<Row> {
  const nf = () => notFound(msg("documents:entities.savedSearch"));
  if (!isUuid(id)) throw nf();
  const [row] = await db
    .select()
    .from(savedSearches)
    .where(and(eq(savedSearches.id, id), eq(savedSearches.projectId, a.project.id)));
  if (!row) throw nf();
  if (row.ownerId === a.user.id || a.isProjectAdmin) return row;
  const shares = await db.select().from(savedSearchShares).where(eq(savedSearchShares.searchId, row.id));
  const mine = shares.some(
    (s) =>
      (s.subjectType === "user" && s.subjectId === a.user.id) ||
      (s.subjectType === "project" && s.subjectId === a.project.id) ||
      (s.subjectType === "company" && s.subjectId === a.principal.companyId),
  );
  if (!mine) throw nf();
  return row;
}

/** The owner changes and deletes a search; a project administrator too. Others: 403 (or 404 when not visible). */
async function loadEditable(db: Db, a: ProjectAccess, id: string): Promise<Row> {
  const row = await loadVisible(db, a, id);
  if (row.ownerId !== a.user.id && !a.isProjectAdmin) throw forbidden();
  return row;
}

async function toDtos(db: Db, a: ProjectAccess, rows: Row[]): Promise<SavedSearchDto[]> {
  if (!rows.length) return [];
  const shares = await db
    .select()
    .from(savedSearchShares)
    .where(inArray(savedSearchShares.searchId, rows.map((r) => r.id)));
  const userIds = shares.filter((s) => s.subjectType === "user").map((s) => s.subjectId);
  const companyIds = [...new Set(shares.filter((s) => s.subjectType === "company").map((s) => s.subjectId))];
  const names = await userNames(db, [...rows.map((r) => r.ownerId), ...userIds]);
  const companyNames = companyIds.length
    ? new Map(
        (await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds))).map((c) => [c.id, c.name]),
      )
    : new Map<string, string>();
  return rows.map((r) => {
    const mine = r.ownerId === a.user.id;
    // Who else a search is shared with is shown to its owner and to project administrators only.
    const list: SavedSearchShareDto[] =
      mine || a.isProjectAdmin
        ? shares
            .filter((s) => s.searchId === r.id)
            .map((s) => ({
              subjectType: s.subjectType,
              subjectId: s.subjectId,
              subjectName: s.subjectType === "user" ? names.get(s.subjectId) : s.subjectType === "company" ? companyNames.get(s.subjectId) : a.project.name,
            }))
        : [];
    return {
      id: r.id,
      name: r.name,
      params: r.params,
      ownerId: r.ownerId,
      ownerName: names.get(r.ownerId),
      mine,
      shares: list,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}
