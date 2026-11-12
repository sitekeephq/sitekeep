import { and, asc, eq } from "drizzle-orm";
import type { LocationDto, LocationLinkKind } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { locationLinks, locations } from "../db/schema.js";
import { isUuid, type ProjectAccess } from "../core/security/access.js";
import { notFound } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

export type LocationRow = typeof locations.$inferSelect;

export function toLocationDto(r: LocationRow): LocationDto {
  return {
    id: r.id,
    projectId: r.projectId,
    parentId: r.parentId,
    name: r.name,
    code: r.code,
    type: r.type,
    kmStart: r.kmStart,
    kmEnd: r.kmEnd,
    sortOrder: r.sortOrder,
    ifcFileVersionId: r.ifcFileVersionId,
    ifcGlobalId: r.ifcGlobalId,
    ifcClass: r.ifcClass,
  };
}

export async function loadLocations(db: Db, projectId: string): Promise<LocationRow[]> {
  return db.select().from(locations).where(eq(locations.projectId, projectId)).orderBy(asc(locations.sortOrder), asc(locations.name));
}

/** The node and every node below it. */
export function subtreeIds(rows: readonly Pick<LocationRow, "id" | "parentId">[], rootId: string): string[] {
  const kids = new Map<string | null, string[]>();
  for (const r of rows) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const c of kids.get(id) ?? []) if (!out.includes(c)) walk(c);
  };
  walk(rootId);
  return out;
}

export async function requireLocation(db: Db, projectId: string, id: string): Promise<LocationRow> {
  if (!isUuid(id)) throw notFound(msg("locations:entities.location"));
  const [row] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.projectId, projectId)));
  if (!row) throw notFound(msg("locations:entities.location"));
  return row;
}

/** Sets (or clears with null) the location of an issue, form or file. Permission is checked by the caller. */
export async function setLocationLink(
  db: Db,
  a: ProjectAccess,
  kind: LocationLinkKind,
  targetId: string,
  locationId: string | null,
): Promise<void> {
  if (locationId) await requireLocation(db, a.project.id, locationId);
  await db.delete(locationLinks).where(and(eq(locationLinks.kind, kind), eq(locationLinks.targetId, targetId)));
  if (locationId)
    await db.insert(locationLinks).values({ projectId: a.project.id, kind, targetId, locationId, createdBy: a.user.id });
}
