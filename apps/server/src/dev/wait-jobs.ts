/** Waits until the job queue is empty (conversions, indexes): developer tools after uploads. */
import { count, inArray } from "drizzle-orm";
import type { DevContext } from "./context.js";

export async function waitForJobs(ctx: DevContext, timeoutMs = 180_000): Promise<boolean> {
  const { jobs: jobsTable } = await import("../db/schema.js");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await ctx.deps.jobs.drain();
    const [r] = await ctx.db
      .select({ n: count() })
      .from(jobsTable)
      .where(inArray(jobsTable.status, ["queued", "running"]));
    if (!Number(r?.n ?? 0)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((res) => setTimeout(res, 500));
  }
}
