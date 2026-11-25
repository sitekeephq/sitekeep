import { z } from "zod";
import type { CdeCall } from "../../core/types.js";
import type { ToolAdder } from "../../core/define.js";
import { clean, type Any } from "../../format/common.js";

/**
 * Approval delegation ("vekâlet", issue #190): the Platform module's /delegations endpoints. A
 * delegate gets the steps and works assigned to the person during the period as well; the first
 * answer wins and is recorded as "X adına Y". Delegation never widens folder permissions.
 */
export function registerDelegationTools(tool: ToolAdder, call: CdeCall): void {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const row = (d: Any) =>
    clean({
      id: d.id,
      person: d.personName,
      personId: d.personId,
      delegate: d.delegateName,
      delegateId: d.delegateId,
      from: d.startsOn,
      to: d.endsOn,
      projects: d.allProjects ? "all" : (d.projects ?? []).map((p: Any) => p.code),
      status: d.status,
      note: d.note,
      endedAt: d.endedAt ? String(d.endedAt).slice(0, 10) : undefined,
    });
  const warnings = (w: Any) =>
    clean({
      notMemberOf: w?.notMemberOf?.length ? w.notMemberOf : undefined,
      foldersDelegateCannotView: w?.folders?.length ? w.folders : undefined,
      openStepFilesDelegateCannotView: w?.openStepFiles?.length ? w.openStepFiles : undefined,
    });
  const confirm = " Changes live data: confirm with the user first.";

  tool(
    "cde_delegations_list",
    "Approval delegations (vekâlet): mine (as the person or the delegate) and, with projectId and project admin rights, every delegation " +
      "that covers the project. Status: planned, active, ended.",
    {
      projectId: z.string().uuid().optional().describe("Project id: all delegations of the project (project admins)."),
      status: z.enum(["planned", "active", "ended"]).optional(),
    },
    async (a) => {
      const q = new URLSearchParams();
      if (a.projectId) q.set("projectId", a.projectId);
      const rows = await call<Any[]>("GET", `/delegations${q.size ? `?${q}` : ""}`);
      return rows.filter((d) => !a.status || d.status === a.status).map(row);
    },
  );

  tool(
    "cde_delegation_create",
    "Creates an approval delegation: during the dates the delegate also gets the review steps, work steps (RFI, submittal), works assigned " +
      "to the person (actions, correspondence) and form approvals; the first answer counts and is recorded as 'X adına Y'. " +
      "personId defaults to the caller; a project admin may set it for another member (then give projectIds of projects they administer). " +
      "Without projectIds it covers all the person's projects. Returns warnings (delegate not a member, folders the delegate cannot view); " +
      "folder permissions are never widened." +
      confirm,
    {
      delegateId: z.string().uuid().describe("User id of the delegate (cde_members_list)."),
      personId: z.string().uuid().optional().describe("The delegating person; default: the caller."),
      startsOn: date.describe("First day, YYYY-MM-DD."),
      endsOn: date.describe("Last day (inclusive), YYYY-MM-DD."),
      projectIds: z.array(z.string().uuid()).max(100).optional().describe("Limit to these projects; omit for all."),
      note: z.string().max(500).optional(),
    },
    async (a) => {
      const r = await call<Any>("POST", "/delegations", a);
      return clean({ delegation: row(r.delegation), warnings: warnings(r.warnings) });
    },
    { write: true },
  );

  tool(
    "cde_delegation_end",
    "Ends an approval delegation now (the person, the delegate, its creator or a project admin of its projects). Steps that were assigned " +
      "while it ran stay with the delegate as well; new ones go to the person only." +
      confirm,
    { delegationId: z.string().uuid() },
    async (a) => row(await call<Any>("POST", `/delegations/${a.delegationId}/end`, {})),
    { write: true },
  );
}
