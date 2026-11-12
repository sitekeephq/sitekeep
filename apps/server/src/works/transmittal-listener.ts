import { eq } from "drizzle-orm";
import { isApprovedOutcome, resolveModules, type WorkFieldValues } from "@sitekeep/shared";
import {
  projectMembers,
  projects,
  reviewFiles,
  reviews,
  users,
  workflowTemplateWorkOptions,
} from "../db/schema.js";
import { notify, type WorkflowEvent } from "../workflow/service.js";
import { msg } from "../i18n/index.js";
import { createWork, sendWork } from "./lifecycle.js";
import { projectTypes, workLink, type WorksCtx } from "./work-core.js";

export function autoTransmittalListener(ctx: WorksCtx) {
  return async (e: WorkflowEvent): Promise<void> => {
    if (e.type !== "completed" || e.subjectType !== "review" || !e.templateId) return;
    const { db } = ctx;
    const [opts] = await db
      .select()
      .from(workflowTemplateWorkOptions)
      .where(eq(workflowTemplateWorkOptions.templateId, e.templateId));
    if (!opts?.autoTransmittal) return;
    const [review] = await db.select().from(reviews).where(eq(reviews.id, e.subjectId));
    const [project] = await db.select().from(projects).where(eq(projects.id, e.projectId));
    if (!review || !project || !resolveModules(project.settings?.modules).transmittals) return;
    const rfs = await db.select().from(reviewFiles).where(eq(reviewFiles.reviewId, review.id));
    const picked = rfs.filter((rf) => opts.include === "all" || isApprovedOutcome(rf.finalStatus));
    if (!picked.length) return;
    const versionIds = picked.map((rf) => rf.copiedVersionId ?? rf.fileVersionId);
    const types = await projectTypes(db, project.id);
    const type =
      types.find((t) => t.category === "transmittal" && !t.archivedAt && t.key === "transmittal") ??
      types.find((t) => t.category === "transmittal" && !t.archivedAt);
    if (!type) return;
    const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id));
    const companyOf = async (uid: string | null) => {
      if (!uid) return null;
      const m = members.find((x) => x.userId === uid);
      if (m?.companyId) return m.companyId;
      const [u] = await db.select({ companyId: users.companyId }).from(users).where(eq(users.id, uid));
      return u?.companyId ?? null;
    };
    const actorId = e.actorId ?? review.createdBy;
    const senderCompany = await companyOf(actorId);
    const starterCompany = await companyOf(review.createdBy);
    const recipients = opts.recipientCompanyIds.length
      ? opts.recipientCompanyIds
      : starterCompany
        ? [starterCompany]
        : [];
    const to = [...new Set(recipients)];
    const fields: WorkFieldValues = {};
    if (type.fields.some((f) => f.key === "amac")) fields.amac = opts.purpose;
    if (type.fields.some((f) => f.key === "not")) fields.not = `İnceleme #${review.number} sonucu otomatik oluşturuldu.`; // i18n-ok: field value stored as data
    const work = await createWork(
      db,
      null,
      project,
      type,
      { userId: actorId, companyId: senderCompany },
      {
        title: review.name,
        fields,
        fromCompanyId: senderCompany,
        toCompanyIds: to,
        links: [
          { kind: "review", targetId: review.id, role: "kaynak" },
          ...versionIds.map((id) => ({ kind: "file_version" as const, targetId: id, role: "ek" as const })),
        ],
      },
      `İnceleme #${review.number} tamamlanınca otomatik oluşturuldu`, // i18n-ok: event message stored as data
    );
    if (opts.send && to.length) await sendWork(ctx, project, work, type, actorId, { channel: "cde" });
    else if (work.createdBy)
      await notify(db, [work.createdBy], {
        projectId: project.id,
        kind: "work.created",
        title: msg("works:notifications.transmittalDraftReady", { number: work.number }),
        link: workLink(project.id, work.id),
      });
  };
}
