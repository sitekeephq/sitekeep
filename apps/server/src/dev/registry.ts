/**
 * What the developer tools created, kept in system_settings ("dev.registry"; no migration):
 * the projects they created (test projects) and, per seed tag, the ids of every seeded record so a
 * seed is idempotent and can be removed again. Seeded works also carry data.devSeed = tag.
 *
 * A project counts as a test/demo project when its code ends with -DEMO or -TEST, or when the
 * developer tools created it. Destructive developer tools act only on those.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { getSetting, putSetting } from "../ai/settings.js";
import { HttpError, notFound } from "../core/platform/http.js";

export const REGISTRY_KEY = "dev.registry";
export const TEST_CODE_RE = /-(DEMO|TEST)$/i;

export interface DevSeedEntry {
  at: string;
  seed: number;
  params: Record<string, unknown>;
  /** Record ids by kind: works, issues, reviews, forms, files, schedules, users, companies… */
  records: Record<string, string[]>;
  counts: Record<string, number>;
}

export interface DevProjectEntry {
  createdByDev?: boolean;
  createdAt?: string;
  seeds?: Record<string, DevSeedEntry>;
}

export interface DevRegistry {
  projects: Record<string, DevProjectEntry>;
}

export async function readRegistry(db: Db): Promise<DevRegistry> {
  const r = await getSetting<DevRegistry>(db, REGISTRY_KEY, { projects: {} });
  return { projects: r?.projects ?? {} };
}

export async function updateRegistry(db: Db, userId: string | null, fn: (r: DevRegistry) => void): Promise<DevRegistry> {
  const r = await readRegistry(db);
  fn(r);
  await putSetting(db, REGISTRY_KEY, r, userId);
  return r;
}

export type ProjectRow = typeof projects.$inferSelect;

export async function loadProject(db: Db, projectId: string): Promise<ProjectRow> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw notFound("Proje");
  return p;
}

/** Finds a project by id or code. */
export async function findProject(db: Db, ref: string): Promise<ProjectRow> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref) ? (await db.select().from(projects).where(eq(projects.id, ref)))[0] : undefined;
  if (byId) return byId;
  const [byCode] = await db.select().from(projects).where(eq(projects.code, ref)).orderBy(projects.archived);
  if (!byCode) throw notFound(`Proje (${ref})`);
  return byCode;
}

export function isTestProject(p: Pick<ProjectRow, "id" | "code">, reg: DevRegistry): boolean {
  return TEST_CODE_RE.test(p.code) || !!reg.projects[p.id]?.createdByDev;
}

/** Destructive developer tools: only test/demo projects, and only with confirm: true. */
export async function requireTestProject(db: Db, p: ProjectRow, confirm: boolean | undefined, what: string): Promise<DevRegistry> {
  const reg = await readRegistry(db);
  if (!isTestProject(p, reg))
    throw new HttpError(
      403,
      "not_test_project",
      `"${p.code}" bir test/demo projesi değil. ${what} yalnız kodu -DEMO / -TEST ile biten ya da geliştirici araçlarının oluşturduğu projelerde çalışır.`,
    );
  if (confirm !== true) throw new HttpError(400, "confirm_required", `${what} geri alınamaz; onaylamak için confirm: true gönderin.`);
  return reg;
}
