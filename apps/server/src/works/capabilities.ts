/** Capabilities Manage (works) offers other modules (sdk/capabilities.ts). */
import { and, eq, inArray } from "drizzle-orm";
import { provideCapability } from "../sdk/capabilities.js";
import { works } from "../db/schema.js";

export function worksCapabilities(): void {
  provideCapability("manage.workExists", async (db, projectId, workId) => {
    const [w] = await db.select({ id: works.id }).from(works).where(and(eq(works.id, workId), eq(works.projectId, projectId)));
    return !!w;
  });
  provideCapability("manage.workLabels", async (db, workIds) =>
    workIds.length ? db.select({ id: works.id, number: works.number, title: works.title }).from(works).where(inArray(works.id, workIds)) : [],
  );
}
