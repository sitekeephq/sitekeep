/**
 * ISO-1, D-2: a document a review sends back (rejected, or revise and resubmit). Nothing is moved:
 *   - the WIP original (the reviewed file when it is in WIP, else the container's files in WIP) is
 *     flagged `returned`, its current version's suitability goes back to S0 (ISO profiles) and its
 *     task team is notified (the members of the team owning its WIP folder; the uploader when no
 *     team owns it);
 *   - a Shared copy sent to Published and refused is flagged `withdrawn`; the step back to WIP is
 *     the automatic transition shared → wip (audit `cde.transition`, mode `auto`).
 * Only for projects that enforce the transitions. A new version of the WIP file clears `returned`
 * (files/new-version.ts).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { allowedSuitability, codeProfile, type OutcomeCode } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files, memberRoles, reviewFiles, type reviews } from "../db/schema.js";
import { FolderTree } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { msg } from "../i18n/index.js";
import { notify } from "../workflow/service.js";
import { reviewLabel, reviewLink } from "../workflow/review-types.js";
import { loadCodeSettings } from "./codes.js";
import { cdeStateOf } from "./state.js";
import { loadTransitionRules } from "./transitions.js";
import { recordTransition } from "./events.js";

type ReviewRow = typeof reviews.$inferSelect;
type ReviewFileRow = typeof reviewFiles.$inferSelect;
type FileRow = typeof files.$inferSelect;

/** Outcomes that send a document back to its team. */
export const RETURNING_OUTCOMES: readonly OutcomeCode[] = ["rejected", "revise_resubmit"];

/** The task team owning a WIP folder (the folder's or the nearest ancestor's), or null. */
function owningTeam(tree: FolderTree, folderId: string): string | null {
  if (!tree.byId.has(folderId)) return null;
  for (const id of tree.ancestry(folderId).reverse()) {
    const team = tree.byId.get(id)?.ownerTeamId;
    if (team) return team;
  }
  return null;
}

async function teamMembers(db: Db, projectId: string, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: memberRoles.userId })
    .from(memberRoles)
    .where(and(eq(memberRoles.projectId, projectId), eq(memberRoles.roleId, teamId)));
  return rows.map((r) => r.userId);
}

/** Flags returned / withdrawn documents of a review; returns the ids of the files flagged. */
export async function applyReviewRejections(
  db: Db,
  review: ReviewRow,
  rfs: readonly ReviewFileRow[],
  actorId: string | null,
): Promise<{ returned: string[]; withdrawn: string[] }> {
  const out = { returned: [] as string[], withdrawn: [] as string[] };
  const refused = rfs.filter((rf) => rf.finalStatus && RETURNING_OUTCOMES.includes(rf.finalStatus));
  if (!refused.length) return out;
  const rules = await loadTransitionRules(db, review.projectId);
  if (!rules.enforce) return out;
  const tree = await FolderTree.load(db, review.projectId);
  const profile = codeProfile(await loadCodeSettings(db, review.projectId));
  const s0 = profile.scheme !== "legacy_r" && profile.scheme !== "letter_rev" && allowedSuitability(profile, "wip").includes("S0");
  const toState = review.targetFolderId ? cdeStateOf(tree, review.targetFolderId) : null;
  const sourceIds = [...new Set(refused.map((rf) => rf.fileId))];
  const sources = await db.select().from(files).where(inArray(files.id, sourceIds));

  for (const rf of refused) {
    const file = sources.find((f) => f.id === rf.fileId);
    if (!file || file.deletedAt || !tree.byId.has(file.folderId)) continue;
    const fromState = cdeStateOf(tree, file.folderId);
    let wipFiles: FileRow[];
    if (fromState === "wip") wipFiles = [file];
    else {
      const siblings = await db
        .select()
        .from(files)
        .where(and(eq(files.projectId, review.projectId), eq(files.containerId, file.containerId), isNull(files.deletedAt)));
      wipFiles = siblings.filter((f) => tree.byId.has(f.folderId) && cdeStateOf(tree, f.folderId) === "wip");
    }
    const details = { reviewId: review.id, reviewNumber: review.number, outcome: rf.finalStatus, system: true };

    for (const w of wipFiles) {
      await db.update(files).set({ cdeStatus: "returned" }).where(eq(files.id, w.id));
      if (s0)
        await db
          .update(fileVersions)
          .set({ suitabilityCode: "S0", codesSetBy: actorId, codesSetAt: new Date() })
          .where(and(eq(fileVersions.fileId, w.id), eq(fileVersions.version, w.currentVersion)));
      out.returned.push(w.id);
      await audit(db, {
        projectId: review.projectId,
        userId: actorId,
        action: "cde.returned",
        targetType: "file",
        targetId: w.id,
        details: { name: w.name, ...details, ...(s0 ? { suitabilityCode: "S0" } : {}) },
      });
      if (w.id !== file.id)
        await recordTransition(db, {
          projectId: review.projectId,
          userId: actorId,
          fileId: w.id,
          fromFolderId: file.folderId,
          toFolderId: w.folderId,
          fromState,
          toState: "wip",
          mode: "auto",
          reviewId: review.id,
        });
      // The owning task team, else whoever uploaded the current version (or created the file).
      const team = owningTeam(tree, w.folderId);
      let recipients = team ? await teamMembers(db, review.projectId, team) : [];
      if (!recipients.length) {
        const [v] = await db
          .select({ uploadedBy: fileVersions.uploadedBy })
          .from(fileVersions)
          .where(and(eq(fileVersions.fileId, w.id), eq(fileVersions.version, w.currentVersion)));
        recipients = [v?.uploadedBy ?? w.createdBy].filter((u): u is string => !!u);
      }
      await notify(db, recipients, {
        projectId: review.projectId,
        kind: "cde.returned",
        title: msg("cde:notifications.returned", { name: w.name, review: reviewLabel(review) }),
        body: msg(`cde:notifications.outcome.${rf.finalStatus === "rejected" ? "rejected" : "revise"}`),
        link: reviewLink(review.projectId, review.id),
        actorId,
      });
    }

    // A Shared copy refused for publication is withdrawn.
    if (fromState === "shared" && toState === "published") {
      await db.update(files).set({ cdeStatus: "withdrawn" }).where(eq(files.id, file.id));
      out.withdrawn.push(file.id);
      await audit(db, {
        projectId: review.projectId,
        userId: actorId,
        action: "cde.withdrawn",
        targetType: "file",
        targetId: file.id,
        details: { name: file.name, ...details },
      });
    }
  }
  return out;
}
