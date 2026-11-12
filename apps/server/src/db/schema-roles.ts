/**
 * Project roles (teams) and their members. Re-exported from schema.ts; references to core
 * tables are lazy so the circular import between the two files is safe.
 *
 * A role is used as a folder-permission subject (folder_grants.subject_type = 'role') and as a
 * workflow step assignee ({ type: "role", id: roleId }).
 */
import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projectMembers, projects } from "./schema.js";

export const projectRoles = pgTable(
  "project_roles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Chip colour, #rrggbb. */
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_roles_name").on(t.projectId, t.name)],
);

/** A member may hold several roles; removing the member or the role removes the row. */
export const memberRoles = pgTable(
  "member_roles",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => projectRoles.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.userId] }),
    index("member_roles_member_idx").on(t.projectId, t.userId),
    foreignKey({
      name: "member_roles_member_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [projectMembers.projectId, projectMembers.userId],
    }).onDelete("cascade"),
  ],
);
