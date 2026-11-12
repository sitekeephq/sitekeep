import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AuthUser } from "../security/access.js";
import { BRIDGE_HEADER } from "./bridge.js";

// ---- Request-scoped bridge ------------------------------------------------------------------

/**
 * Lets the assistant call the REST API in-process as the asking user. A random key, valid only while
 * one question runs, maps to the caller's identity with a read-only, single-project token scope, so
 * enforceTokenScope() refuses writes and other projects exactly as for a restricted read token.
 */
export class AskBridge {
  private readonly users = new Map<string, AuthUser>();

  open(user: AuthUser, projectId: string, label: string): { key: string; close(): void } {
    const key = randomBytes(32).toString("base64url");
    this.users.set(key, {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      companyId: user.companyId,
      token: { id: `ask:${label}`, kind: "api", scope: "read", projectIds: [projectId] },
    });
    return { key, close: () => void this.users.delete(key) };
  }

  /**
   * Developer tools only (CDE_DEV_TOOLS=1): acts as a project member in-process with a session-like
   * identity, so seed data and scenarios go through the normal routes and permission checks of
   * that member. The key lives only while the developer tool runs.
   */
  openAs(user: Omit<AuthUser, "token">, label: string): { key: string; close(): void } {
    const key = randomBytes(32).toString("base64url");
    this.users.set(key, { ...user, token: { id: `dev:${label}`, kind: "session", scope: "write", projectIds: null } });
    return { key, close: () => void this.users.delete(key) };
  }

  /** undefined: not a bridged request; null: bridge header with an unknown or expired key. */
  lookup(req: FastifyRequest): AuthUser | null | undefined {
    const v = req.headers[BRIDGE_HEADER];
    if (v === undefined) return undefined;
    return (typeof v === "string" && this.users.get(v)) || null;
  }
}
