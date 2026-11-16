/**
 * Re-seals the audit chain (docs/features/AUDIT_LOG.md#re-seal): moves the IP address, user agent and
 * e-mail of rows chained before migration 0049 into audit_personal, recomputes the chain from the
 * first such row, archives every replaced hash and records the checkpoint row `audit.resealed`.
 *
 *   npm run audit:reseal -w @sitekeep/server            # DATABASE_URL, or DATA_DIR/db (PGlite)
 *   node dist/scripts/audit-reseal.js                   # in the server image
 *
 * Needs the installation's secret key (CDE_SECRET_KEY or DATA_DIR/secret.key). Record the printed
 * old and new head hashes outside the server. Exit code 0: done (or nothing to do); 1: refused or
 * failed (nothing changed). Stop the server first when the database is an embedded PGlite.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { openDb } from "../db/index.js";
import { loadSecretKey } from "../core/platform/secrets.js";
import { setAuditPersonalKey } from "../core/platform/audit.js";
import { resealAuditChain } from "../audit/personal.js";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const dbUrl = process.env.DATABASE_URL || path.join(dataDir, "db");
let code = 1;
try {
  if (!process.env.CDE_SECRET_KEY && !existsSync(path.join(dataDir, "secret.key")))
    throw new Error("No secret key: set CDE_SECRET_KEY or DATA_DIR to the server's data directory.");
  setAuditPersonalKey(loadSecretKey(dataDir));
  const handle = await openDb(dbUrl);
  try {
    const r = await resealAuditChain(handle.db);
    console.log(JSON.stringify(r, null, 2));
    if (r.resealed)
      console.log(`Re-sealed rows ${r.fromId}–${r.oldHead!.id}: ${r.personalMoved} personal records moved. Old head ${r.oldHead!.hash}, new head ${r.newHeadHash}.`);
    else console.log("Nothing to re-seal: no chained row holds personal values.");
    code = 0;
  } finally {
    await handle.close();
  }
} catch (err) {
  console.error(err);
}
process.exit(code);
