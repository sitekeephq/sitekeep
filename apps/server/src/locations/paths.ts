import { asc, eq } from "drizzle-orm";
import { locationPath } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { locations } from "../db/schema.js";

/** Builds display paths for every location in a project without depending on HTTP routes. */
export async function locationPaths(db: Db, projectId: string): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(locations)
    .where(eq(locations.projectId, projectId))
    .orderBy(asc(locations.sortOrder), asc(locations.name));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(rows.map((row) => [row.id, locationPath(byId, row.id)]));
}
