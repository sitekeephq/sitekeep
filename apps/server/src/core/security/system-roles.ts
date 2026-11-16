/**
 * System-level roles: the system administrator (users.is_admin) changes everything; the auditor
 * (users.is_auditor, docs/features/SECURITY_LOG.md#auditor) only reads the security log, the
 * Privacy Centre, every project's audit log and the chain check. The role gives no project or file
 * access: projectAccess() still needs a membership.
 */
import type { FastifyRequest } from "fastify";
import type { AuthUser } from "./access.js";
import { forbidden } from "../platform/http.js";
import { msg } from "../../i18n/index.js";

/** System administrator or auditor: may read the installation's security records. */
export function canReadSecurityRecords(user: Pick<AuthUser, "isAdmin" | "isAuditor"> | null | undefined): boolean {
  return !!user && (user.isAdmin || !!user.isAuditor);
}

/** Read routes of the security log, the audit log of all projects and the Privacy Centre. */
export function requireSecurityReader(req: FastifyRequest): void {
  if (!canReadSecurityRecords(req.user)) throw forbidden(msg("admin:errors.adminOrAuditorOnly"));
}
