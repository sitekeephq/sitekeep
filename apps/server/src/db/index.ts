import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Installed modules' migrations (docs/modules/README.md), each with its own journal table. Loaded
 * lazily so the database layer does not import the module list at start-up.
 */
async function moduleMigrations(): Promise<{ migrationsFolder: string; migrationsTable: string }[]> {
  // Every loaded module's tables, licensed or not: data stays when a licence lapses.
  const { loadedModules } = await import("../app/modules.js");
  return loadedModules.flatMap((m) => (m.migrations ? [{ migrationsFolder: m.migrations, migrationsTable: `__drizzle_migrations_${m.id}` }] : []));
}

/**
 * Opens the database and applies migrations (the core's, then each installed module's).
 * - `postgres://…` → PostgreSQL (recommended for production)
 * - a directory path → embedded PGlite stored on disk (single-server installs)
 * - `memory://` → in-memory PGlite (tests)
 */
export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new pg.default.Pool({ connectionString: url });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    for (const m of await moduleMigrations()) await migrate(db, m);
    return { db: db as unknown as Db, kind: "postgres", close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  let client;
  if (url === "memory://") {
    client = new PGlite();
  } else {
    mkdirSync(url, { recursive: true });
    client = new PGlite(url);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  for (const m of await moduleMigrations()) await migrate(db, m);
  return { db: db as unknown as Db, kind: "pglite", close: () => client.close() };
}

export { schema };
