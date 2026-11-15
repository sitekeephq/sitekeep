/**
 * ISO 19650 task teams (ISO-5, docs/features/TASK_TEAMS.md). Teams themselves are project roles
 * of kind 'task_team' (CRUD and membership: /projects/:pid/roles); these routes add:
 *   PUT  /projects/:pid/folders/:fid/owner-team   project administrators; audit "folder.owner_team_set"
 *   POST /projects/:pid/cde/teams/seed            project administrators: a team for every company
 *                                                 that has none (members joined), owner teams on
 *                                                 WIP folders made from template slots
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app/deps.js";
import { FolderTree, projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, notFound } from "../core/platform/http.js";
import { folders, projectRoles } from "../db/schema.js";
import { msg } from "../i18n/index.js";
import { toFolderDto } from "../modules/documents/folders.js";
import { cdeStateOf } from "./state.js";
import { assignWipOwnerTeams, ensureCompanyTeams } from "./teams.js";

export async function taskTeamRoutes(api: FastifyInstance, { db }: AppDeps) {
  api.put<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/owner-team", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ teamId: z.string().uuid().nullable() }).parse(req.body);
    const tree = await FolderTree.load(db, a.project.id);
    const folder = tree.get(req.params.fid);
    let teamName: string | null = null;
    if (body.teamId) {
      if (!folder.parentId || cdeStateOf(tree, folder.id) !== "wip") throw badRequest(msg("cde:teams.errors.notWip"));
      const [team] = await db
        .select({ id: projectRoles.id, name: projectRoles.name })
        .from(projectRoles)
        .where(and(eq(projectRoles.id, body.teamId), eq(projectRoles.projectId, a.project.id), eq(projectRoles.kind, "task_team")));
      if (!team) throw notFound(msg("cde:teams.entities.team"));
      teamName = team.name;
    }
    await db.update(folders).set({ ownerTeamId: body.teamId }).where(eq(folders.id, folder.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.owner_team_set",
      targetType: "folder",
      targetId: folder.id,
      details: { name: folder.name, teamId: body.teamId, teamName, previousTeamId: folder.ownerTeamId ?? null },
    });
    const fresh = await FolderTree.load(db, a.project.id);
    return toFolderDto(fresh, a.principal, folder.id);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/cde/teams/seed", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const { teams, created } = await ensureCompanyTeams(db, a.project.id);
    const foldersOwned = await assignWipOwnerTeams(db, a.project.id, teams);
    if (created || foldersOwned)
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "cde.teams_seeded",
        targetType: "project",
        targetId: a.project.id,
        details: { created, foldersOwned },
      });
    return { created, foldersOwned };
  });
}
