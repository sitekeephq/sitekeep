/**
 * Re-runs the CDE foundation backfill (src/cde/backfill.ts) against a database:
 *
 *   DATABASE_URL=postgres://… npx tsx src/scripts/cde-backfill.ts [batchSize]
 *
 * Opening the database applies pending migrations first (0042 includes the same backfill).
 */
import { runCdeBackfill } from "../cde/backfill.js";
import { openDb } from "../db/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const batchSize = Number(process.argv[2] ?? 1000) || 1000;
const handle = await openDb(databaseUrl);
try {
  const report = await runCdeBackfill(handle.db, { batchSize, log: (line) => console.log(line) });
  console.log(JSON.stringify(report));
} finally {
  await handle.close();
}
