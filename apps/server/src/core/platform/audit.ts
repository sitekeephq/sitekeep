/**
 * The audit log (docs/features/AUDIT_LOG.md): append-only and hash-chained in the database
 * (migration 0043_audit_chain). Rows written during a request carry the client's IP address and
 * user agent (D-9, docs/features/PRIVACY.md); background work writes them without.
 *
 * Personal values (P1-5, migration 0049_audit_personal) do not go into the chained row: the IP
 * address, the user agent and an e-mail address in `details.email` are written to audit_personal,
 * which can be deleted (retention, erasure of one person). The chained row keeps `personal_hash`, a
 * keyed hash of those values, and `details.emailHash` in place of the address, so the chain still
 * proves what happened and which personal record belonged to it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { auditLog } from "../../db/schema.js";

/** Who called, as far as the request tells (stored with audit rows, D-9). */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function clientInfo(req: FastifyRequest): ClientInfo {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: typeof ua === "string" ? ua.slice(0, 500) : null };
}

const requestClient = new AsyncLocalStorage<ClientInfo>();

/** Runs fn with the request's client, which audit rows written inside it carry (build-app.ts hook). */
export function withAuditClient<T>(client: ClientInfo, fn: () => T): T {
  return requestClient.run(client, fn);
}

// ---- Keyed hashes of personal values -----------------------------------------------------------

let personalKey: Buffer | null = null;
let personalKeyFromSecret = false;

/**
 * Derives the installation's audit key from its secret key (CDE_SECRET_KEY or DATA_DIR/secret.key,
 * core/platform/secrets.ts), so it is kept and backed up like the other secrets. Called by buildApp
 * and by the audit scripts.
 */
export function setAuditPersonalKey(secretKey: Buffer): void {
  personalKey = Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(0), "sitekeep.audit.personal.v1", 32));
  personalKeyFromSecret = true;
}

/** The key, when one was derived from the installation's secret (null: only a throwaway key). */
export function auditPersonalKey(): Buffer | null {
  return personalKeyFromSecret ? personalKey : null;
}

function key(): Buffer {
  // Without a secret (a test or script that never built the app) a per-process key: hashes still
  // chain, they just cannot be recomputed by another process.
  personalKey ??= randomBytes(32);
  return personalKey;
}

const hmac = (k: Buffer, text: string) => createHmac("sha256", k).update(text, "utf8").digest("hex");

/** Normalised e-mail address as stored in audit_personal. */
export const auditEmail = (email: string) => email.trim().toLowerCase();

/** `details.emailHash` of an address: the same address always gives the same hash (repeated failed logins). */
export function auditEmailHash(email: string, k: Buffer = key()): string {
  return hmac(k, `email\u0000${auditEmail(email)}`);
}

export interface AuditPersonalValues {
  ip: string | null;
  userAgent: string | null;
  email: string | null;
}

/** `personal_hash` of a row: binds its audit_personal record to the chained row. */
export function auditPersonalHash(p: AuditPersonalValues, k: Buffer = key()): string {
  return hmac(k, JSON.stringify(["v1", p.ip, p.userAgent, p.email]));
}

/**
 * Splits an event's details: a string `email` leaves the details for the personal part, its hash
 * stays (`emailHash`).
 */
export function splitPersonalDetails(
  details: Record<string, unknown> | null,
  k: Buffer = key(),
): { details: Record<string, unknown> | null; email: string | null } {
  if (!details || typeof details.email !== "string") return { details, email: null };
  const { email, ...rest } = details;
  const normalised = auditEmail(email as string);
  return { details: { ...rest, emailHash: auditEmailHash(normalised, k) }, email: normalised };
}

// ---- Writing --------------------------------------------------------------------------------------

export interface AuditEvent {
  projectId?: string | null;
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** A string `email` here is personal: it is kept in audit_personal, the row keeps `emailHash`. */
  details?: Record<string, unknown>;
  /** Defaults to the current request's client, if any. */
  client?: ClientInfo | null;
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  const client = e.client ?? requestClient.getStore() ?? null;
  const { details, email } = splitPersonalDetails(e.details ?? null);
  const personal: AuditPersonalValues = { ip: client?.ip ?? null, userAgent: client?.userAgent ?? null, email };
  // id, prev_hash and hash come from the chain trigger.
  if (!personal.ip && !personal.userAgent && !personal.email) {
    await db.insert(auditLog).values({
      projectId: e.projectId ?? null,
      userId: e.userId ?? null,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      details,
    });
    return;
  }
  // One statement: the chained row and its personal part are written together or not at all.
  await db.execute(sql`
    WITH a AS (
      INSERT INTO audit_log (project_id, user_id, action, target_type, target_id, details, personal_hash)
      VALUES (${e.projectId ?? null}::uuid, ${e.userId ?? null}::uuid, ${e.action}, ${e.targetType ?? null}, ${e.targetId ?? null},
        ${details === null ? null : JSON.stringify(details)}::jsonb, ${auditPersonalHash(personal)})
      RETURNING id, at, user_id
    )
    INSERT INTO audit_personal (audit_id, at, user_id, ip, user_agent, email)
    SELECT a.id, a.at, a.user_id, ${personal.ip}, ${personal.userAgent}, ${personal.email} FROM a`);
}
