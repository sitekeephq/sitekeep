import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { companies, memberRoles, projectMembers, projectRoles, users } from "../db/schema.js";
import type { RedactPerson } from "./redact.js";

/**
 * Project members as redaction entries: the full name and what replaces it, the first project role
 * and the company ("Proje Müdürü (Poyraz)"); members without a role are "Proje Üyesi".
 */
export async function projectPeople(db: Db, projectId: string): Promise<RedactPerson[]> {
  const rows = await db
    .select({ userId: users.id, name: users.name, company: companies.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .leftJoin(companies, eq(companies.id, sql`coalesce(${projectMembers.companyId}, ${users.companyId})`))
    .where(eq(projectMembers.projectId, projectId));
  if (!rows.length) return [];
  const roles = await db
    .select({ userId: memberRoles.userId, role: projectRoles.name })
    .from(memberRoles)
    .innerJoin(projectRoles, eq(projectRoles.id, memberRoles.roleId))
    .where(eq(memberRoles.projectId, projectId))
    .orderBy(asc(projectRoles.name));
  const roleOf = new Map<string, string>();
  for (const r of roles) if (!roleOf.has(r.userId)) roleOf.set(r.userId, r.role);
  return rows.map((r) => ({
    name: r.name,
    label: `${roleOf.get(r.userId) ?? "Proje Üyesi"}${r.company ? ` (${r.company})` : ""}`, // i18n-ok: redaction placeholder in text sent to the AI model
  }));
}
