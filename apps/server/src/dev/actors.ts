/**
 * Demo companies (short codes), demo users and their project memberships for seed data and
 * scenarios. Everything is created through the normal admin routes; demo users get a random
 * password that is never shown (they act only through the in-process bridge).
 */
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { companies, folders, projectMembers, projects, users } from "../db/schema.js";
import type { DevContext } from "./context.js";
import { DEMO_COMPANIES } from "./random.js";

export interface Actor {
  companyId: string;
  code: string;
  name: string;
  userId: string;
  userName: string;
  role: string;
}

export interface Actors {
  /** Yüklenici: writes letters, RFIs, submittals, starts reviews. */
  contractor: Actor;
  /** Müşavir: answers RFIs, reviews submittals and documents. */
  consultant: Actor;
  /** İdare: sends incoming letters, approves at the end. */
  client: Actor;
  /** Tasarımcı (optional). */
  designer: Actor;
  all: Actor[];
}

type CompanyRow = typeof companies.$inferSelect;

const demoEmail = (code: string) => `demo.${code.toLowerCase()}@ornek.test`;

async function ensureCompany(ctx: DevContext, c: { name: string; code: string }): Promise<CompanyRow> {
  const [byCode] = await ctx.db.select().from(companies).where(eq(companies.code, c.code));
  if (byCode) return byCode;
  const [byName] = await ctx.db.select().from(companies).where(eq(companies.name, c.name));
  if (byName) return byName;
  return ctx.call<CompanyRow>("POST", "/companies", { name: c.name, code: c.code });
}

/** The demo companies (İdare, Yüklenici, Müşavir, Tasarımcı), created once; code → id. */
export async function ensureDemoCompanies(ctx: DevContext): Promise<Record<string, CompanyRow>> {
  const out: Record<string, CompanyRow> = {};
  for (const code of ["YUK", "MSV", "IDR", "TSR"]) out[code] = await ensureCompany(ctx, DEMO_COMPANIES.find((d) => d.code === code)!);
  return out;
}

/** Finds companies by code or name (case-insensitive). */
export async function resolveCompanies(ctx: DevContext, refs: string[]): Promise<CompanyRow[]> {
  const out: CompanyRow[] = [];
  for (const ref of refs) {
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(sql`lower(${companies.code}) = lower(${ref}) or lower(${companies.name}) = lower(${ref})`);
    if (!row) throw new Error(`Firma bulunamadı: ${ref}`);
    out.push(row);
  }
  return out;
}

/** A member of the project representing the company; creates a demo user and membership when none. */
async function memberFor(ctx: DevContext, projectId: string, c: CompanyRow, personName?: string): Promise<{ userId: string; userName: string }> {
  const [m] = await ctx.db
    .select({ userId: projectMembers.userId, name: users.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.companyId, c.id), eq(users.disabled, false), eq(users.isAdmin, false)))
    .limit(1);
  if (m) return { userId: m.userId, userName: m.name };
  const email = demoEmail(c.code ?? c.id.slice(0, 6));
  let [u] = await ctx.db.select().from(users).where(eq(users.email, email));
  if (!u) {
    const created = await ctx.call<{ id: string }>("POST", "/users", {
      email,
      name: personName ?? `Demo ${c.code ?? c.name}`,
      password: randomBytes(24).toString("base64url"),
      companyId: c.id,
    });
    [u] = await ctx.db.select().from(users).where(eq(users.id, created.id));
  }
  const [already] = await ctx.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u!.id)));
  if (!already) await ctx.call("POST", `/projects/${projectId}/members`, { email, companyId: c.id, isProjectAdmin: false });
  return { userId: u!.id, userName: u!.name };
}

/**
 * The parties of a seed or scenario: given company refs (codes / names), else the demo companies
 * (İdare, Yüklenici, Müşavir, Tasarımcı). Each gets one acting member of the project.
 */
export async function ensureActors(ctx: DevContext, projectId: string, refs?: string[]): Promise<Actors> {
  const people: Record<string, string> = {
    IDR: "Ayşe Demir (Demo)",
    YUK: "Mehmet Kaya (Demo)",
    MSV: "Can Öztürk (Demo)",
    TSR: "Zeynep Arslan (Demo)",
  };
  let rows: CompanyRow[];
  let roles: string[];
  if (refs?.length) {
    rows = await resolveCompanies(ctx, refs);
    if (rows.length < 3) throw new Error("En az üç firma verin: yüklenici, müşavir, idare (sırayla).");
    roles = ["Yüklenici", "Müşavir", "İdare", "Tasarımcı", "Alt Yüklenici"];
  } else {
    const demo = await ensureDemoCompanies(ctx);
    rows = ["YUK", "MSV", "IDR", "TSR"].map((c) => demo[c]!);
    roles = ["Yüklenici", "Müşavir", "İdare", "Tasarımcı"];
  }
  const all: Actor[] = [];
  for (const [i, c] of rows.entries()) {
    const m = await memberFor(ctx, projectId, c, people[c.code ?? ""]);
    all.push({ companyId: c.id, code: c.code ?? c.name, name: c.name, userId: m.userId, userName: m.userName, role: roles[i] ?? "Firma" });
  }
  return { contractor: all[0]!, consultant: all[1]!, client: all[2]!, designer: all[3] ?? all[0]!, all };
}

/**
 * A folder for generated files directly under the project root ("Geliştirici Örnek Dosyaları"),
 * without a naming standard; the given companies may edit in it.
 */
export async function ensureSeedFolder(ctx: DevContext, projectId: string, companyIds: string[], name = "Geliştirici Örnek Dosyaları"): Promise<string> {
  const [p] = await ctx.db.select({ root: projects.rootFolderId }).from(projects).where(eq(projects.id, projectId));
  const root = p!.root!;
  const [existing] = await ctx.db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.projectId, projectId), eq(folders.parentId, root), eq(folders.name, name), sql`${folders.deletedAt} is null`));
  const id = existing?.id ?? (await ctx.call<{ id: string }>("POST", `/projects/${projectId}/folders`, { parentId: root, name })).id;
  if (companyIds.length)
    await ctx.call("PUT", `/projects/${projectId}/folders/${id}/permissions`, {
      entries: companyIds.map((cid) => ({ subjectType: "company", subjectId: cid, level: "edit" })),
      mode: "replace",
    });
  return id;
}

/** A sub-folder (created once). */
export async function ensureSubFolder(ctx: DevContext, projectId: string, parentId: string, name: string): Promise<string> {
  const [existing] = await ctx.db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.projectId, projectId), eq(folders.parentId, parentId), eq(folders.name, name), sql`${folders.deletedAt} is null`));
  return existing?.id ?? (await ctx.call<{ id: string }>("POST", `/projects/${projectId}/folders`, { parentId, name })).id;
}
