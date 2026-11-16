/**
 * Walks the audit log's hash chain (docs/features/AUDIT_LOG.md) and reports the first broken row:
 *
 *   npm run audit:verify -w @sitekeep/server            # DATABASE_URL, or DATA_DIR/db (PGlite)
 *   node dist/scripts/audit-verify.js                   # in the server image
 *
 * Exit code 0: the chain is intact; 2: a row breaks it; 1: the check could not run. An embedded
 * PGlite database can be opened by one process only: stop the server first (or use
 * GET /api/v1/admin/audit/verify while it runs).
 */
import path from "node:path";
import { openDb } from "../db/index.js";
import { verifyAuditChain } from "../audit/query.js";
import { existsSync } from "node:fs";
import { loadSecretKey } from "../core/platform/secrets.js";
import { setAuditPersonalKey } from "../core/platform/audit.js";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const dbUrl = process.env.DATABASE_URL || path.join(dataDir, "db");
// With the secret key at hand, personal records are checked against their hashes too (never creates a key).
if (process.env.CDE_SECRET_KEY || existsSync(path.join(dataDir, "secret.key"))) setAuditPersonalKey(loadSecretKey(dataDir));
let code = 1;
try {
  const handle = await openDb(dbUrl);
  try {
    const r = await verifyAuditChain(handle.db);
    console.log(JSON.stringify(r, null, 2));
    if (r.ok) console.log(`Audit chain intact: ${r.checked} rows checked, ${r.legacyRows} rows from before the chain.`);
    else console.error(`Audit chain broken at row ${r.broken!.id} (${r.broken!.reason}); ${r.checked} rows before it are intact.`);
    code = r.ok ? 0 : 2;
  } finally {
    await handle.close();
  }
} catch (err) {
  console.error(err);
}
process.exit(code);
