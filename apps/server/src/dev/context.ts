/**
 * Shared plumbing of the developer tools: REST calls in-process as any user (through the request
 * bridge, so every call runs the normal route, validation and permission checks of that user).
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { CdeError, type CdeCall } from "@sitekeep/cde-tools";
import type { AuthUser } from "../core/security/access.js";
import type { ResolvedDeps } from "../app/deps.js";
import { users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { bridgedCall, bridgedGet, bridgedRaw, type RawCall } from "../core/platform/inprocess.js";

export interface DevContext {
  app: FastifyInstance;
  deps: ResolvedDeps;
  db: Db;
  /** The system administrator who called the tool. */
  admin: AuthUser;
  /** Web app address for links (e.g. http://localhost:5173). */
  webBase: string;
  /** REST call as the calling administrator. */
  call: CdeCall;
  /** Same, returning {status, body} instead of throwing. */
  raw: RawCall;
  /** REST call as another user (loaded by id). */
  as(userId: string): Promise<CdeCall>;
  rawAs(userId: string): Promise<RawCall>;
  /** Binary GET as a user (default the administrator). */
  getBinary(url: string, userId?: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>;
  /** Closes the bridge keys opened for this tool call. */
  close(): void;
}

export function createDevContext(app: FastifyInstance, deps: ResolvedDeps, admin: AuthUser, webBase = deps.webUrl): DevContext {
  const opened: { key: string; close(): void }[] = [];
  const keys = new Map<string, string>();
  const open = (u: Omit<AuthUser, "token">) => {
    const k = keys.get(u.id);
    if (k) return k;
    const h = deps.askBridge.openAs({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, companyId: u.companyId }, u.email);
    opened.push(h);
    keys.set(u.id, h.key);
    return h.key;
  };
  const keyFor = async (userId: string) => {
    const k = keys.get(userId);
    if (k) return k;
    const [u] = await deps.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new CdeError(`Kullanıcı bulunamadı: ${userId}`, 404);
    return open(u);
  };
  const adminKey = open(admin);
  return {
    app,
    deps,
    db: deps.db,
    admin,
    webBase,
    call: bridgedCall(app, adminKey),
    raw: bridgedRaw(app, adminKey),
    as: async (userId) => bridgedCall(app, await keyFor(userId)),
    rawAs: async (userId) => bridgedRaw(app, await keyFor(userId)),
    getBinary: async (url, userId) => bridgedGet(app, userId ? await keyFor(userId) : adminKey, url),
    close() {
      for (const h of opened) h.close();
      opened.length = 0;
      keys.clear();
    },
  };
}

/** Web link for an app path such as projectPath(pid, `works/${wid}`). */
export function link(ctx: Pick<DevContext, "webBase">, p: string): string {
  return `${ctx.webBase.replace(/\/+$/, "")}${p}`;
}
