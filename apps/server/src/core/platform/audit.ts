/**
 * The audit log (docs/features/AUDIT_LOG.md): append-only and hash-chained in the database
 * (migration 0043_audit_chain). Rows written during a request carry the client's IP address and
 * user agent (D-9, docs/features/PRIVACY.md); background work writes them without.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";
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

export interface AuditEvent {
  projectId?: string | null;
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  /** Defaults to the current request's client, if any. */
  client?: ClientInfo | null;
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  const client = e.client ?? requestClient.getStore() ?? null;
  // id, prev_hash and hash come from the chain trigger.
  await db.insert(auditLog).values({
    projectId: e.projectId ?? null,
    userId: e.userId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    details: e.details ?? null,
    ip: client?.ip ?? null,
    userAgent: client?.userAgent ?? null,
  });
}
