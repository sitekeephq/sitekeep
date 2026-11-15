/**
 * Re-runs the CDE foundation backfill (src/cde/backfill.ts) against a database:
 *
 *   DATABASE_URL=postgres://… npx tsx src/scripts/cde-backfill.ts [batchSize]
 *
 * Then seeds ISO 19650 task teams (src/cde/teams.ts). Opening the database applies pending migrations first (0042 includes the same backfill).
 */
import { runCdeBackfill } from "../cde/backfill.js";
import { runDocumentCodeBackfill } from "../cde/document-code.js";
import { seedTaskTeams } from "../cde/teams.js";
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
  // ISO-3: document codes of existing files, first come first served (idempotent).
  console.log(JSON.stringify(await runDocumentCodeBackfill(handle.db, { batchSize, log: (line) => console.log(line) })));
  // ISO-5 task teams: one per company in projects that have none (also run at server start).
  console.log(JSON.stringify(await seedTaskTeams(handle.db, { batchSize, log: (line) => console.log(line) })));
} finally {
  await handle.close();
}
