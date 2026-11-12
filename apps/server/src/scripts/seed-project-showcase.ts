import path from "node:path";
import { and, desc, eq, max } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { openDb, type Db } from "../db/index.js";
import { moduleTable } from "../app/modules.js";
import {
  dashboards,
  dashboardVersions,
  fileVersions,
  files,
  folders,
  issues,
  locations,
  modelSets,
  projectMembers,
  projects,
  reviewFiles,
  reviews,
  showcaseBatches,
  showcaseRecords,
  specRegisters,
  users,
  workflowInstances,
  workflowTemplates,
  works,
  workTypes,
} from "../db/schema.js";
import { LocalStorage } from "../core/platform/storage.js";
import { ensureBuiltInTypes } from "../works/service.js";

const projectId = process.env.CDE_PROJECT_ID;
const databaseUrl = process.env.DATABASE_URL;
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const clean = process.argv.includes("--clean");
const BATCH_KEY = "autodesk-hybrid-showcase-v1";
const DEMO = "SiteKeep demo verisi — üretilmiş";

if (!projectId || !databaseUrl) {
  throw new Error("CDE_PROJECT_ID ve DATABASE_URL gerekli.");
}

const handle = await openDb(databaseUrl);
const storage = new LocalStorage(path.join(dataDir, "storage"));
try {
  if (clean) {
    await cleanBatch(handle.db, projectId);
    console.log(JSON.stringify({ ok: true, cleaned: BATCH_KEY, projectId }));
  } else {
    const result = await seed(handle.db);
    console.log(JSON.stringify({ ok: true, projectId, ...result }));
  }
} finally {
  await handle.close();
}

// Field's tables (the showcase needs the Field module).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const field = (name: string): any => {
  const t = moduleTable("field", name);
  if (!t) throw new Error("seed-project-showcase needs the Field module (SITEKEEP_MODULES)");
  return t;
};
const formTemplates = field("formTemplates");
const formTemplateVersions = field("formTemplateVersions");
const forms = field("forms");
// Planning's tables (the showcase needs the Planning module too).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planning = (name: string): any => {
  const t = moduleTable("planning", name);
  if (!t) throw new Error("seed-project-showcase needs the Planning module (SITEKEEP_MODULES)");
  return t;
};
const schedules = planning("schedules");
const scheduleActivities = planning("scheduleActivities");
const scheduleDependencies = planning("scheduleDependencies");

async function seed(db: Db) {
  const [existing] = await db
    .select()
    .from(showcaseBatches)
    .where(and(eq(showcaseBatches.projectId, projectId!), eq(showcaseBatches.key, BATCH_KEY)));
  if (existing) return { batchId: existing.id, created: 0, alreadyPresent: true };
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId!));
  if (!project || !project.rootFolderId) throw new Error(`Proje veya kök klasörü bulunamadı: ${projectId}`);
  const [member] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, project.id));
  const actorId = project.createdBy ?? member?.userId ?? (await db.select({ id: users.id }).from(users).limit(1))[0]?.id;
  if (!actorId) throw new Error("Showcase verisini oluşturacak kullanıcı bulunamadı.");

  const pdf = await demoPdf(project.name);
  const stored = await storage.putBytes(pdf, `projects/${project.id}/files`);
  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(showcaseBatches)
        .values({ projectId: project.id, key: BATCH_KEY, label: "Autodesk hibrit canlı sunum verisi", createdBy: actorId })
        .returning();
      let created = 0;
      const track = async (nativeType: string, nativeId: string) => {
        await tx.insert(showcaseRecords).values({ batchId: batch!.id, nativeType, nativeId });
        created++;
      };

      const [file] = await tx
        .insert(files)
        .values({
          projectId: project.id,
          folderId: project.rootFolderId!,
          name: "DEMO-Dikimevi-Natoyolu-Teknik-Sartname.pdf",
          attributes: { Kaynak: "DEMO", Açıklama: DEMO },
          createdBy: actorId,
        })
        .returning();
      const [version] = await tx
        .insert(fileVersions)
        .values({
          fileId: file!.id,
          version: 1,
          storageKey: stored.key,
          size: stored.size,
          sha256: stored.sha256,
          uploadedBy: actorId,
          comment: DEMO,
        })
        .returning();
      await track("file", file!.id);

      const [issueMax] = await tx.select({ n: max(issues.number) }).from(issues).where(eq(issues.projectId, project.id));
      const [issue] = await tx
        .insert(issues)
        .values({
          projectId: project.id,
          number: (issueMax?.n ?? 0) + 1,
          title: "DEMO-001 Peron katı kablo tavası çakışması",
          description: `${DEMO}. Model koordinasyon toplantısında tespit edilen örnek issue.`,
          status: "in_progress",
          priority: "high",
          type: "Tasarım koordinasyonu",
          dueDate: addDays(7),
          createdBy: actorId,
        })
        .returning();
      await track("issue", issue!.id);

      const [location] = await tx
        .insert(locations)
        .values({ projectId: project.id, name: "DEMO Dikimevi İstasyonu", code: "DEMO-DIK", type: "İstasyon", createdBy: actorId })
        .returning();
      await track("location", location!.id);

      const [template] = await tx
        .insert(workflowTemplates)
        .values({
          projectId: project.id,
          kind: "review",
          name: "DEMO Tasarım koordinasyon review akışı",
          steps: [
            {
              name: "DEMO koordinasyon kontrolü",
              assignees: [{ type: "user", id: actorId }],
              rule: "any",
              days: 7,
              outcomes: ["approved", "approved_with_comments", "revise_resubmit", "rejected"],
            },
          ],
          finalOutcomes: {},
          createdBy: actorId,
        })
        .returning();
      await track("workflow_template", template!.id);
      const [reviewMax] = await tx.select({ n: max(reviews.number) }).from(reviews).where(eq(reviews.projectId, project.id));
      const [review] = await tx
        .insert(reviews)
        .values({
          projectId: project.id,
          number: (reviewMax?.n ?? 0) + 1,
          code: "DEMO-REV-001",
          name: "DEMO Teknik şartname kontrolü",
          note: DEMO,
          createdBy: actorId,
        })
        .returning();
      await tx.insert(reviewFiles).values({
        reviewId: review!.id,
        fileId: file!.id,
        fileVersionId: version!.id,
        sourceFolderId: project.rootFolderId!,
      });
      await tx.insert(workflowInstances).values({
        projectId: project.id,
        kind: "review",
        templateId: template!.id,
        template: { templateId: template!.id, name: template!.name, steps: template!.steps, finalOutcomes: {} },
        subjectType: "review",
        subjectId: review!.id,
        status: "running",
        startedBy: actorId,
      });
      await track("review", review!.id);

      const [formTemplate] = (await tx
        .insert(formTemplates)
        .values({
          projectId: project.id,
          code: "DEMO",
          name: "DEMO Saha kalite kontrol formu",
          category: "Kalite",
          description: DEMO,
          numberPattern: "DEMO-FRM-{0000}",
          createdBy: actorId,
        })
        .returning()) as { id: string }[];
      const schema = {
        sections: [
          {
            id: "kontrol",
            title: "Saha kontrolü",
            items: [
              { id: "aciklama", type: "text" as const, label: "Kontrol açıklaması" },
              { id: "uygun", type: "yes_no" as const, label: "İmalat projeye uygun mu?" },
            ],
          },
        ],
      };
      const [formVersion] = (await tx
        .insert(formTemplateVersions)
        .values({ templateId: formTemplate!.id, version: 1, schema, usedAt: new Date(), createdBy: actorId })
        .returning()) as { id: string }[];
      const [form] = (await tx
        .insert(forms)
        .values({
          projectId: project.id,
          templateId: formTemplate!.id,
          templateVersionId: formVersion!.id,
          number: "DEMO-FRM-0001",
          numberKey: "DEMO-FRM",
          seq: 1,
          status: "submitted",
          formDate: new Date().toISOString().slice(0, 10),
          values: { aciklama: DEMO, uygun: "yes" },
          createdBy: actorId,
          submittedBy: actorId,
          submittedAt: new Date(),
        })
        .returning()) as { id: string }[];
      await track("form_template", formTemplate!.id);
      await track("form", form!.id);

      await ensureBuiltInTypes(tx, project.id);
      const [rfiType] = await tx.select().from(workTypes).where(and(eq(workTypes.projectId, project.id), eq(workTypes.category, "rfi")));
      if (rfiType) {
        const [workMax] = await tx.select({ n: max(works.seq) }).from(works).where(eq(works.typeId, rfiType.id));
        const seq = (workMax?.n ?? 0) + 1;
        const [work] = await tx
          .insert(works)
          .values({
            projectId: project.id,
            typeId: rfiType.id,
            number: `DEMO-RFI-${String(seq).padStart(4, "0")}`,
            seq,
            title: "DEMO İstasyon mekanik şaft detayı bilgi talebi",
            status: rfiType.statuses.find((x) => !x.closed && x.key !== "taslak")?.key ?? rfiType.statuses[0]!.key,
            fields: { aciklama: DEMO },
            dueDate: addDays(10),
            data: { demo: true },
            createdBy: actorId,
          })
          .returning();
        await track("work", work!.id);
      }

      const [schedule] = (await tx
        .insert(schedules)
        .values({
          projectId: project.id,
          seriesId: crypto.randomUUID(),
          name: "DEMO Dikimevi–Natoyolu ana iş programı",
          version: 1,
          sourceType: "csv",
          sourceName: "DEMO-program.csv",
          dataDate: new Date().toISOString().slice(0, 10),
          isBaseline: true,
          activityCount: 4,
          startDate: "2026-10-01",
          finishDate: "2027-02-28",
          createdBy: actorId,
        })
        .returning()) as { id: string }[];
      await tx.update(schedules).set({ seriesId: schedule!.id }).where(eq(schedules.id, schedule!.id));
      const activities = (await tx
        .insert(scheduleActivities)
        .values([
          activity(schedule!.id, "DEMO-A100", "Mobilizasyon ve saha kurulumu", "2026-10-01", "2026-10-20", 100, 0),
          activity(schedule!.id, "DEMO-A200", "İstasyon kazı ve iksa işleri", "2026-10-21", "2026-12-31", 35, 1, true),
          activity(schedule!.id, "DEMO-A300", "Kaba yapı imalatları", "2027-01-01", "2027-02-15", 0, 2, true),
          activity(schedule!.id, "DEMO-M400", "Kaba yapı tamamlanması", "2027-02-15", "2027-02-15", 0, 3, false, true),
        ])
        .returning()) as { id: string; code: string }[];
      for (let i = 0; i < activities.length - 1; i++) {
        await tx.insert(scheduleDependencies).values({ scheduleId: schedule!.id, predId: activities[i]!.id, succId: activities[i + 1]!.id, type: "FS" });
      }
      await track("schedule", schedule!.id);

      const [dashboard] = await tx
        .insert(dashboards)
        .values({
          projectId: project.id,
          ownerId: actorId,
          name: "DEMO Proje yönetim özeti",
          description: DEMO,
          sharing: "project",
          queries: [
            { id: "issues", spec: { dataset: "issues", groupBy: ["status"], metrics: [{ op: "count" }] } },
            { id: "models", spec: { dataset: "models", groupBy: ["derivativeStatus"], metrics: [{ op: "count" }] } },
          ],
          html: `<section><h1>DEMO Proje yönetim özeti</h1><p>${DEMO}</p><div id="issues"></div><div id="models"></div><script>CDE.table("#issues", d.issues, {title:"Issue durumu"}); CDE.table("#models", d.models, {title:"Model durumu"});</script></section>`,
        })
        .returning();
      await tx.insert(dashboardVersions).values({
        dashboardId: dashboard!.id,
        version: 1,
        name: dashboard!.name,
        description: dashboard!.description,
        queries: dashboard!.queries,
        html: dashboard!.html,
        sharing: dashboard!.sharing,
        createdBy: actorId,
      });
      await track("dashboard", dashboard!.id);

      const [spec] = await tx
        .insert(specRegisters)
        .values({
          projectId: project.id,
          versionId: version!.id,
          items: [
            {
              id: "S001",
              sectionCode: "01 33 00",
              sectionTitle: "Altmittal prosedürleri",
              page: 1,
              description: DEMO,
              excerpt: "Ürün teknik föyü ve uygunluk belgesi onaya sunulacaktır.",
              type: "TF",
              typeConfidence: 1,
              discipline: "GEN",
              keywords: ["teknik föy", "onaya sunulacaktır"],
            },
            {
              id: "S002",
              sectionCode: "03 30 00",
              sectionTitle: "Yerinde dökme beton",
              page: 1,
              description: DEMO,
              excerpt: "Karışım tasarımı ve deney raporları idareye sunulacaktır.",
              type: "DR",
              typeConfidence: 1,
              discipline: "YAP",
              keywords: ["deney raporu", "sunulacaktır"],
            },
          ],
          sectionCount: 2,
          pageCount: 1,
          usedAi: false,
          createdBy: actorId,
        })
        .returning();
      await track("spec_register", spec!.id);

      const ifcRows = await tx
        .select({ fileId: files.id, versionId: fileVersions.id })
        .from(files)
        .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
        .where(and(eq(files.projectId, project.id), eq(fileVersions.derivativeStatus, "ready")))
        .orderBy(desc(fileVersions.uploadedAt))
        .limit(10);
      const [set] = await tx
        .insert(modelSets)
        .values({
          projectId: project.id,
          name: "DEMO Mimari + Statik Federasyon",
          description: DEMO,
          items: ifcRows.map((x) => ({ fileId: x.fileId, versionId: x.versionId })),
          createdBy: actorId,
        })
        .returning();
      await track("model_set", set!.id);

      return { batchId: batch!.id, created, alreadyPresent: false };
    });
  } catch (error) {
    await storage.remove(stored.key);
    throw error;
  }
}

function activity(
  scheduleId: string,
  code: string,
  name: string,
  start: string,
  finish: string,
  percentComplete: number,
  sortIndex: number,
  critical = false,
  milestone = false,
) {
  return {
    scheduleId,
    code,
    externalId: code,
    wbsPath: "DEMO/Dikimevi",
    name,
    start,
    finish,
    baselineStart: start,
    baselineFinish: finish,
    percentComplete,
    durationDays: milestone ? 0 : Math.max(1, Math.round((Date.parse(finish) - Date.parse(start)) / 86_400_000)),
    critical,
    milestone,
    resource: "DEMO ekip",
    sortIndex,
  };
}

async function demoPdf(projectName: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("SiteKeep DEMO Technical Specification", { x: 55, y: 775, size: 18, font });
  page.drawText(projectName.replace(/[^\x20-\x7E]/g, " "), { x: 55, y: 745, size: 12, font });
  page.drawText("Generated presentation data. Not a contractual document.", { x: 55, y: 715, size: 10, font });
  return doc.save();
}

async function cleanBatch(db: Db, pid: string) {
  const [batch] = await db
    .select()
    .from(showcaseBatches)
    .where(and(eq(showcaseBatches.projectId, pid), eq(showcaseBatches.key, BATCH_KEY)));
  if (!batch) return;
  const records = await db.select().from(showcaseRecords).where(eq(showcaseRecords.batchId, batch.id));
  const ids = (type: string) => records.filter((x) => x.nativeType === type).map((x) => x.nativeId);
  const remove = async (type: string, table: Parameters<Db["delete"]>[0] & { id: unknown }) => {
    for (const id of ids(type)) await db.delete(table).where(eq(table.id as never, id));
  };
  await remove("spec_register", specRegisters);
  await remove("dashboard", dashboards);
  await remove("model_set", modelSets);
  await remove("review", reviews);
  await remove("work", works);
  await remove("form", forms);
  await remove("form_template", formTemplates);
  await remove("issue", issues);
  await remove("location", locations);
  await remove("schedule", schedules);
  await remove("workflow_template", workflowTemplates);
  await remove("file", files);
  await db.delete(showcaseBatches).where(eq(showcaseBatches.id, batch.id));
}

function addDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
