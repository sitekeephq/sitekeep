import type { Db } from "../../db/index.js";
import { auditLog } from "../../db/schema.js";

export interface AuditEvent {
  projectId?: string | null;
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await db.insert(auditLog).values({
    projectId: e.projectId ?? null,
    userId: e.userId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    details: e.details ?? null,
  });
}
