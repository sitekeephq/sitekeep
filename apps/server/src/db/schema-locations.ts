/**
 * The location tree and location links of issues, forms and files (PKF/MBE priority #10).
 * Re-exported from schema.ts; references to core tables are lazy so the circular import is safe.
 */
import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  LocationLinkKind,
} from "@sitekeep/shared";
import { fileVersions, projects, users } from "./schema.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---- Locations ---------------------------------------------------------------------------------

export const locations = pgTable(
  "locations",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    /** Short code (e.g. SG1, L1SG); unique in the project when set. Used by CSV import and numbering. */
    code: text("code"),
    /** Free text: İstasyon, Bölge, Kat, Mahal, Tünel kesimi … */
    type: text("type"),
    /** Chainage range in km for linear assets. */
    kmStart: doublePrecision("km_start"),
    kmEnd: doublePrecision("km_end"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** IFC spatial element (IfcSite / IfcBuildingStorey / IfcSpace / IfcFacilityPart …). */
    ifcFileVersionId: uuid("ifc_file_version_id").references(() => fileVersions.id, { onDelete: "set null" }),
    ifcGlobalId: text("ifc_global_id"),
    ifcClass: text("ifc_class"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("locations_parent_idx").on(t.projectId, t.parentId),
    uniqueIndex("locations_code_unique").on(t.projectId, t.code).where(sql`code IS NOT NULL`),
    index("locations_ifc_idx").on(t.projectId, t.ifcGlobalId),
  ],
);

/** Location of an issue, form or file; one location per target. Leaves the issues table untouched. */
export const locationLinks = pgTable(
  "location_links",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LocationLinkKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("location_links_target").on(t.kind, t.targetId), index("location_links_location_idx").on(t.locationId)],
);

// ---- Form templates ----------------------------------------------------------------------------
