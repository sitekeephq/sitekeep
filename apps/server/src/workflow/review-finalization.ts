import { isApprovedOutcome, pathSegments, renderPattern, splitExtension, validateName } from "@sitekeep/shared";
import { and, eq, isNull } from "drizzle-orm";
import { audit } from "../core/platform/audit.js";
import { FolderTree } from "../core/security/access.js";
import { fileVersions, files, reviewFiles } from "../db/schema.js";
import { DEFAULT_LANGUAGE, isMsg, render, tFor } from "../i18n/index.js";
import { fileFieldValues } from "./chain.js";
import { ensureFolderPath, folderPath, StandardCache } from "./chain-service.js";
import type { CopyReport, ReviewCtx, ReviewRow } from "./review-types.js";
import type { Db } from "../db/index.js";
import { checkCodes, checkDocumentCode, checkUpload } from "../cde/guards.js";
import { recordTransition } from "../cde/events.js";
import { cdeStateOf } from "../cde/state.js";

/**
 * Copies approved versions into the review's target folder as new files / versions. With a
 * target pattern each file goes to its own sub-folder ("{Bölge}/{Disiplin}"), created when
 * missing. The copy reuses the stored object (same storage key) and runs with system rights;
 * the folder's naming standard still applies. Failures are reported per file, never thrown.
 */
export async function copyApprovedFiles(ctx: ReviewCtx, review: ReviewRow, actorId: string | null): Promise<CopyReport> {
  const { db, jobs } = ctx;
  // Copy errors are stored on the review file: written in the installation language.
  const t = tFor(DEFAULT_LANGUAGE);
  const rfs = await db.select().from(reviewFiles).where(eq(reviewFiles.reviewId, review.id));
  const approved = rfs.filter((rf) => isApprovedOutcome(rf.finalStatus));
  const report: CopyReport = { approved: approved.length, copied: 0, failed: 0, results: [] };
  if (!review.targetFolderId || !approved.length) return report;

  let tree = await FolderTree.load(db, review.projectId);
  const baseId = review.targetFolderId;
  const standards = new StandardCache(db, tree);
  const created: string[] = [];

  for (const rf of approved) {
    const [row] = await db
      .select()
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(eq(fileVersions.id, rf.fileVersionId));
    const name = row?.files.name ?? "?";
    const fail = async (error: string, unresolved?: string[]) => {
      report.failed++;
      report.results.push({ name, ok: false, error, ...(unresolved?.length ? { unresolved } : {}) });
      await db
        .update(reviewFiles)
        .set({ copyError: error, copyUnresolved: unresolved?.length ? unresolved : null })
        .where(eq(reviewFiles.id, rf.id));
    };
    if (!row) {
      await fail(t("workflow:errors.sourceVersionMissing"));
      continue;
    }
    if (!tree.byId.has(baseId)) {
      await fail(t("workflow:errors.targetFolderMissing"));
      continue;
    }

    let targetId = baseId;
    let unresolved: string[] = [];
    if (review.targetPattern) {
      const standard = await standards.forFile(row.files.folderId, baseId);
      const rendered = renderPattern(review.targetPattern, fileFieldValues(name, row.files.attributes, standard));
      unresolved = rendered.unresolved;
      if (unresolved.length && !review.targetFallback) {
        await fail(t("workflow:errors.subFolderUnresolved", { fields: unresolved.map((u) => `{${u}}`).join(", ") }), unresolved);
        continue;
      }
      if (!unresolved.length) {
        try {
          const ensured = await ensureFolderPath(
            db,
            tree,
            review.projectId,
            baseId,
            pathSegments(rendered.text),
            review.createdBy,
            review.id,
          );
          if (ensured.created.length) {
            created.push(...ensured.created);
            tree = ensured.tree;
            standards.setTree(tree);
          }
          targetId = ensured.folderId;
        } catch (err) {
          await fail(err instanceof Error ? err.message : t("workflow:errors.targetFolderNotCreated"));
          continue;
        }
      }
    }
    const targetPath = folderPath(tree, targetId);
    const standard = await standards.get(targetId);
    if (standard) {
      const check = validateName(standard, name, DEFAULT_LANGUAGE);
      if (!check.ok) {
        await fail(t("workflow:errors.nameStandardMismatch", { errors: check.errors.join("; ") }));
        continue;
      }
    }

    try {
      const src = row.file_versions;
      // CDE guards: the copy is the same document (container) arriving in the target state.
      const guard = { projectId: review.projectId, access: null, tree, source: "review_copy", lang: DEFAULT_LANGUAGE } as const;
      await checkUpload(db, { ...guard, folderId: targetId, name, existingFileId: null });
      const isIfc = splitExtension(name).extension.toLowerCase() === "ifc";
      const derivative =
        src.derivativeStatus === "ready"
          ? { derivativeStatus: "ready" as const, derivativeKey: src.derivativeKey, ifcSummary: src.ifcSummary }
          : { derivativeStatus: isIfc ? ("pending" as const) : ("none" as const) };
      const comment = `İnceleme ${review.code ?? `#${review.number}`} ile onaylandı (kaynak V${src.version})`; // i18n-ok: version comment stored as data
      const out = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [existing] = await tx
          .select()
          .from(files)
          .where(and(eq(files.folderId, targetId), eq(files.name, name), isNull(files.deletedAt)));
        const codes = await checkCodes(txDb, {
          ...guard,
          folderId: targetId,
          fileId: existing?.id ?? null,
          requested: { suitabilityCode: src.suitabilityCode, revisionCode: src.revisionCode },
          state: cdeStateOf(tree, targetId),
        });
        const codeColumns =
          codes.suitabilityCode || codes.revisionCode ? { ...codes, codesSetBy: src.codesSetBy, codesSetAt: src.codesSetAt ?? new Date() } : {};
        const { documentCode } = await checkDocumentCode(txDb, {
          ...guard,
          folderId: targetId,
          name,
          fileId: existing?.id ?? null,
          containerId: existing?.containerId ?? row.files.containerId,
        });
        if (existing) {
          const [current] = await tx
            .select()
            .from(fileVersions)
            .where(and(eq(fileVersions.fileId, existing.id), eq(fileVersions.version, existing.currentVersion)));
          if (current && current.storageKey === src.storageKey) return { file: existing, version: current, created: false };
          const [version] = await tx
            .insert(fileVersions)
            .values({
              fileId: existing.id,
              version: existing.currentVersion + 1,
              storageKey: src.storageKey,
              size: src.size,
              sha256: src.sha256,
              uploadedBy: review.createdBy,
              comment,
              ...derivative,
              ...codeColumns,
            })
            .returning();
          const [file] = await tx
            .update(files)
            .set({
              currentVersion: version!.version,
              attributes: { ...existing.attributes, ...row.files.attributes },
              ...(documentCode ? { documentCode } : {}),
            })
            .where(eq(files.id, existing.id))
            .returning();
          return { file: file!, version: version!, created: true };
        }
        const [file] = await tx
          .insert(files)
          .values({
            projectId: review.projectId,
            folderId: targetId,
            name,
            attributes: row.files.attributes,
            // The approved copy is the same document: it joins the source's container.
            containerId: row.files.containerId,
            documentCode,
            createdBy: review.createdBy,
          })
          .returning();
        const [version] = await tx
          .insert(fileVersions)
          .values({
            fileId: file!.id,
            version: 1,
            storageKey: src.storageKey,
            size: src.size,
            sha256: src.sha256,
            uploadedBy: review.createdBy,
            comment,
            ...derivative,
            ...codeColumns,
          })
          .returning();
        return { file: file!, version: version!, created: true };
      });
      if (out.created)
        await recordTransition(db, {
          projectId: review.projectId,
          userId: actorId,
          fileId: out.file.id,
          versionId: out.version.id,
          fromFolderId: row.files.folderId,
          toFolderId: targetId,
          fromState: cdeStateOf(tree, row.files.folderId),
          toState: cdeStateOf(tree, targetId),
          mode: "review",
          reviewId: review.id,
        });
      await db
        .update(reviewFiles)
        .set({
          copiedFileId: out.file.id,
          copiedVersionId: out.version.id,
          copyError: null,
          copyFolderId: targetId,
          copyUnresolved: unresolved.length ? unresolved : null,
        })
        .where(eq(reviewFiles.id, rf.id));
      if (out.created && out.version.derivativeStatus === "pending")
        await jobs.enqueue("ifc_to_frag", { versionId: out.version.id });
      report.copied++;
      report.results.push({
        name,
        ok: true,
        fileId: out.file.id,
        version: out.version.version,
        path: targetPath,
        ...(unresolved.length ? { unresolved } : {}),
      });
      await audit(db, {
        projectId: review.projectId,
        userId: actorId,
        action: "review.file_copied",
        targetType: "file",
        targetId: out.file.id,
        details: {
          name,
          version: out.version.version,
          folderId: targetId,
          path: targetPath,
          reviewId: review.id,
          reviewNumber: review.number,
          sourceVersionId: src.id,
          system: true,
          unchanged: !out.created,
          ...(unresolved.length ? { unresolved } : {}),
        },
      });
    } catch (err) {
      await fail(
        err instanceof Error && "status" in err
          ? "msg" in err && isMsg(err.msg)
            ? render(DEFAULT_LANGUAGE, err.msg)
            : err.message
          : t("workflow:errors.copyFailed"),
      );
    }
  }
  if (created.length) report.createdFolders = created;
  return report;
}
