import { and, eq } from "drizzle-orm";
import { DEFAULT_PROJECT_ROLES } from "@sitekeep/shared";
import type { Db } from "../../db/index.js";
import { folderGrants, memberRoles, projectMembers, projectRoles } from "../../db/schema.js";

/** Creates Görüntüleyici / Düzenleyici / Yönetici with root-folder grants when missing. */
export async function ensureDefaultProjectRoles(db: Db, projectId: string, rootFolderId: string | null) {
  const ids: Record<string, string> = {};
  for (const def of DEFAULT_PROJECT_ROLES) {
    await db
      .insert(projectRoles)
      .values({ projectId, name: def.name, description: def.description, color: def.color })
      .onConflictDoNothing({ target: [projectRoles.projectId, projectRoles.name] });
    const [row] = await db
      .select({ id: projectRoles.id })
      .from(projectRoles)
      .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.name, def.name)));
    const id = row!.id;
    ids[def.name] = id;
    if (!rootFolderId) continue;
    await db
      .insert(folderGrants)
      .values({ folderId: rootFolderId, subjectType: "role", subjectId: id, level: def.level })
      .onConflictDoUpdate({
        target: [folderGrants.folderId, folderGrants.subjectType, folderGrants.subjectId],
        set: { level: def.level },
      });
  }
  return ids;
}

/** Project creator / existing project admins get the Yönetici role. */
export async function ensureProjectAdminsHoldAdminRole(db: Db, projectId: string, adminRoleId: string) {
  const admins = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.isProjectAdmin, true)));
  if (!admins.length) return;
  await db
    .insert(memberRoles)
    .values(admins.map((a) => ({ projectId, userId: a.userId, roleId: adminRoleId })))
    .onConflictDoNothing();
}
