import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, cut, day, qs, type Any, type Row } from "../../format/common.js";
import { capList } from "../../format/lists.js";
import { chainText } from "../../format/workflow.js";

const REVIEW_STATUS_TR: Record<string, string> = { running: "sürüyor", completed: "tamamlandı", cancelled: "iptal" };

export function registerReviewTools(tool: ToolAdder, call: CdeCall): void {
  const id = (what: string) => z.string().uuid().describe(what);
  const pid = id("Project id (from cde_projects_list).");
  const wid = id("Work id (from cde_works_list).");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// ---- Reviews -----------------------------------------------------------------------------

tool(
  "cde_reviews_list",
  "Lists document reviews (approval workflows): status, current step, step due date, file count, whether it is my turn.",
  { projectId: pid, status: z.enum(["running", "completed", "cancelled"]).optional(), mine: z.boolean().optional().describe("Only reviews waiting for me") },
  async (a) => {
    const rows = await call<Any[]>("GET", `/projects/${a.projectId}/reviews${qs({ status: a.status, mine: a.mine })}`);
    const list = capList(
      rows.map((r) => {
        const running = r.status === "running";
        return clean({
          id: r.id,
          number: r.number,
          code: r.code,
          name: r.name,
          status: REVIEW_STATUS_TR[r.status] ?? r.status,
          step: running ? r.stepName : undefined,
          stepDue: running ? day(r.stepDueAt) : undefined,
          overdue: running && !!r.overdue,
          files: r.fileCount,
          by: r.startedByName,
          started: day(r.createdAt),
          completed: day(r.completedAt),
          myTurn: !!r.myTurn,
        });
      }),
      30,
    );
    return clean({ total: rows.length, reviews: list.items, more: list.more });
  },
);

tool(
  "cde_review_get",
  "Review details: steps, current step and due date, and per file the review chain status (e.g. Tasarımcı ✓ → Müşavir ⧗) and final outcome.",
  { projectId: pid, reviewId: id("Review id") },
  async (a) => {
    const r = await call<Any>("GET", `/projects/${a.projectId}/reviews/${a.reviewId}`);
    const running = r.status === "running";
    const files = capList(
      (r.files ?? []).map((f: Any) =>
        clean({ fileId: f.fileId, versionId: f.fileVersionId, name: f.fileName, v: f.version, chain: chainText(f.chain), final: f.finalLabel ?? f.finalStatus, copiedTo: f.targetPath }),
      ),
      30,
    );
    return clean({
      id: r.id,
      number: r.number,
      code: r.code,
      name: r.name,
      status: REVIEW_STATUS_TR[r.status] ?? r.status,
      template: r.templateName,
      step: running ? `${r.stepIndex + 1}/${r.stepCount} ${r.stepName ?? ""}`.trim() : undefined,
      stepDue: running ? day(r.stepDueAt) : undefined,
      overdue: running && !!r.overdue,
      steps: (r.steps ?? []).map((s: Any) => s.name),
      note: cut(r.note, 300),
      target: r.targetFolderPath,
      files: files.items,
      moreFiles: files.more,
      lastActions: (r.actions ?? []).slice(-5).map((x: Any) => clean({ at: day(x.at), kind: x.kind, by: x.userName, outcome: x.outcome, comment: cut(x.comment, 200) })),
      canAct: !!r.canAct,
    });
  },
);
}
