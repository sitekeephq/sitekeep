/**
 * Points the YUK-TEST load-test records at one account so "Bana Düşenler" fills for that person.
 *
 *   npm run seed:load:mine
 *
 * Stop `npm run dev` first. PGlite allows one process.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, ne } from "drizzle-orm";
import { projectAccess, type AuthUser } from "../core/security/access.js";
import { openDb } from "../db/index.js";
import { companies, issues, projectMembers, users } from "../db/schema.js";
import { moduleTable } from "../app/modules.js";
import { workflowInstances } from "../db/schema-workflow.js";
import { works } from "../db/schema-works.js";

// Field's forms table (the script needs the Field module).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forms: any = moduleTable("field", "forms");
if (!forms) throw new Error("assign-ui-load needs the Field module (SITEKEEP_MODULES)");
import { projectToday } from "../workflow/routes/hub.js";

const EMAIL = (process.env.CDE_LOAD_USER ?? "admin@example.com").toLowerCase();
const PROJECT_ID = "6ac7da61-4046-425f-8e66-9437282933d8";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, "data"));
const dbUrl = process.env.DATABASE_URL || path.join(dataDir, "db");

const handle = await openDb(dbUrl);
const db = handle.db;
try {
  const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
  if (!user) throw new Error(`Kullanıcı yok: ${EMAIL}`);
  const [yuk] = await db.select().from(companies).where(eq(companies.code, "YUK"));
  if (!yuk) throw new Error("Yüklenici firması (YUK) yok.");

  const member = await db
    .update(projectMembers)
    .set({ companyId: yuk.id })
    .where(and(eq(projectMembers.projectId, PROJECT_ID), eq(projectMembers.userId, user.id)))
    .returning({ userId: projectMembers.userId });
  if (!member.length) throw new Error(`${EMAIL} bu projenin üyesi değil.`);

  const assignedWorks = await db
    .update(works)
    .set({ assigneeUserId: user.id })
    .where(eq(works.projectId, PROJECT_ID))
    .returning({ id: works.id });

  const assignedIssues = await db
    .update(issues)
    .set({ assigneeUserId: user.id })
    .where(and(eq(issues.projectId, PROJECT_ID), ne(issues.status, "closed")))
    .returning({ id: issues.id });

  const assignedForms = await db
    .update(forms)
    .set({ createdBy: user.id })
    .where(and(eq(forms.projectId, PROJECT_ID), eq(forms.status, "draft")))
    .returning({ id: forms.id });

  const running = await db
    .select()
    .from(workflowInstances)
    .where(and(eq(workflowInstances.projectId, PROJECT_ID), eq(workflowInstances.status, "running")));
  let steps = 0;
  for (const row of running) {
    const current = row.template.steps[row.stepIndex];
    if (!current) continue;
    if (current.assignees.some((a) => a.type === "user" && a.id === user.id)) continue;
    const nextSteps = row.template.steps.map((s, i) =>
      i === row.stepIndex ? { ...s, assignees: [...s.assignees, { type: "user" as const, id: user.id }] } : s,
    );
    await db.update(workflowInstances).set({ template: { ...row.template, steps: nextSteps } }).where(eq(workflowInstances.id, row.id));
    steps++;
  }

  const auth: AuthUser = { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin, companyId: user.companyId };
  const access = await projectAccess(db, PROJECT_ID, auth);
  const today = await projectToday(db, access);
  console.log(
    JSON.stringify(
      {
        ok: true,
        email: EMAIL,
        company: yuk.name,
        works: assignedWorks.length,
        issues: assignedIssues.length,
        draftForms: assignedForms.length,
        workflowSteps: steps,
        mine: today.counts.mine,
        groups: Object.fromEntries(Object.entries(today.mine).map(([k, rows]) => [k, rows.length])),
        overdue: today.counts.overdue,
        url: `http://localhost:5173/projects/${PROJECT_ID}/today`,
      },
      null,
      2,
    ),
  );
} finally {
  await handle.close();
}
