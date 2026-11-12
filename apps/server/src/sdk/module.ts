/**
 * Server module contract (docs/modules/README.md). A module (ee/<id>, later its own package) adds
 * migrations, routes, report datasets, reminders and task sources to the core through one object.
 * The core loads modules by package name in app/modules.ts and never imports their code.
 */
import type { FastifyInstance } from "fastify";
import type { MyTaskDto } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import type { Db } from "../db/index.js";
import type { AuthUser } from "../core/security/access.js";
import type { DevContext } from "../dev/context.js";
import type { JobQueue } from "../jobs/queue.js";

/** "Görevlerim": open workflow steps of the module's records waiting for `user` in `projects`. */
export type TaskSource = (db: Db, user: AuthUser, projects: { id: string; code: string; name: string }[], now: number) => Promise<MyTaskDto[]>;

/** A developer tool (cde_dev_*, CDE_DEV_TOOLS=1): arguments already validated by @sitekeep/cde-tools. */
export type DevRunner = (ctx: DevContext, args: Record<string, unknown>) => Promise<unknown>;

/** Reminders sent by one run. */
export interface ReminderCounts {
  dueSoon: number;
  overdue: number;
}

export interface ServerModule {
  /** Product id: "cost", "manage" … (docs/product/SITEKEEP_SURUMLER_VE_MODULLER.md). */
  id: string;
  /**
   * The module's Drizzle migrations folder (absolute). Applied after the core's, with their own
   * journal table drizzle.__drizzle_migrations_<id>.
   */
  migrations?: string;
  /**
   * The module's texts (absolute folder): `<language>/<namespace>.json`, merged into the core's
   * namespaces at start-up (i18n/index.ts registerLocaleFolder). Its English files give the keys
   * their types through the module's own `SiteKeep.ServerResources` declaration.
   */
  locales?: string;
  /** Registers the module's HTTP routes under /api/v1. */
  routes?(api: FastifyInstance, deps: ResolvedDeps): Promise<void>;
  /** Registers routes outside /api/v1 (own authentication: MCP endpoint, WOPI host). */
  rootRoutes?(app: FastifyInstance, deps: ResolvedDeps): Promise<void>;
  /**
   * Background work started with the server after the job queue (schedulers, interrupted jobs);
   * returns the function that stops it on shutdown (index.ts). Not called in tests.
   */
  start?(ctx: { db: Db; jobs: JobQueue; log(message: string, error?: unknown): void }): Promise<() => void>;
  /** Developer tools the module answers (dev/routes.ts), by MCP tool name. */
  devTools?: Record<string, DevRunner>;
  /** Called by the daily / periodic reminder run (workflow/reminders.ts). */
  reminders?(db: Db, now: Date): Promise<ReminderCounts>;
  /** Contributes to the user's task list (workflow/routes/notifications.ts). */
  taskSources?: TaskSource[];
  /** The module's tables, by export name: for developer tools (demo data, load scripts), not for features. */
  tables?: Record<string, unknown>;
}

export function defineServerModule(m: ServerModule): ServerModule {
  return m;
}
