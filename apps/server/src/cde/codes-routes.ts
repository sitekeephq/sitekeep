/**
 * ISO 19650 codes API (docs/features/CDE_STATES.md "Codes"):
 *   GET   /projects/:pid/folders/:fid/cde/codes   profile and state of a folder (web inputs)
 *   PATCH /projects/:pid/versions/:vid/codes      change the codes of a version (a code that does not
 *                                                 fit the state: 400 when the project enforces the
 *                                                 rules, else stored with `warnings`); WIP (or no state):
 *                                                 folder editors; Shared / Published / Archived:
 *                                                 project administrators with a reason (audit
 *                                                 "file.codes_changed", plus "cde.override")
 *   GET   /projects/:pid/cde/codes/unmapped        legacy attribute values that could not become
 *                                                 codes (project administrators)
 *   POST  /projects/:pid/cde/codes/apply           map the legacy attribute values of the current
 *                                                 versions into empty codes under the project's
 *                                                 current scheme ("Apply to existing files";
 *                                                 project administrators; audit "cde.codes_applied")
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { can, codeProfile, validateCodes, type CdeApplyCodesReportDto, type CdeCodeWarningDto, type CdeFolderCodesDto, type CdeUnmappedCodeDto, type FileVersionDto } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { FolderTree, projectAccess, requireProjectAdmin, userNames } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { badRequest, forbidden, notFound } from "../core/platform/http.js";
import { msg, requestLanguage } from "../i18n/index.js";
import { fileVersions } from "../db/schema.js";
import { loadVersion, requireView } from "../modules/documents/files.js";
import { toVersionDto } from "../modules/documents/mapper.js";
import { codeError, codeErrorMsg, loadCodeSettings, warningDtos } from "./codes.js";
import { applyLegacyCodes, unmappedLegacyCodes } from "./codes-migration.js";
import { cdeStateOf } from "./state.js";

const patchBody = z
  .object({
    suitabilityCode: z.string().trim().max(20).nullable().optional(),
    revisionCode: z.string().trim().max(20).nullable().optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

export async function cdeCodesRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.get<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/cde/codes", async (req): Promise<CdeFolderCodesDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.byId.has(req.params.fid) || tree.permission(a.principal, req.params.fid).level === "none")
      throw notFound(msg("documents:entities.folder"));
    const settings = await loadCodeSettings(db, a.project.id);
    return { ...settings, state: cdeStateOf(tree, req.params.fid) };
  });

  api.patch<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/codes", async (req): Promise<FileVersionDto & { warnings?: CdeCodeWarningDto[] }> => {
    const { a, file, tree, version } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const body = patchBody.parse(req.body);
    const state = cdeStateOf(tree, file.folderId);
    const locked = state !== null && state !== "wip";
    if (locked) {
      // Shared, Published, Archived: an administrator's override, with a reason (audited).
      if (!a.isProjectAdmin) throw forbidden(msg("cde:codes.errors.adminRequired", { state: msg(`cde:codes.states.${state}`) }));
      if (!body.reason) throw badRequest(msg("cde:codes.errors.reasonRequired", { state: msg(`cde:codes.states.${state}`) }));
    } else {
      const perm = tree.permission(a.principal, file.folderId);
      const own = perm.canUpload && file.createdBy === a.user.id;
      if (!can(perm.level, "edit") && !own && !a.isProjectAdmin) throw forbidden(msg("cde:codes.errors.noEditPermission"));
    }

    const before = { suitabilityCode: version.suitabilityCode ?? null, revisionCode: version.revisionCode ?? null };
    const wanted = {
      suitabilityCode: body.suitabilityCode === undefined ? before.suitabilityCode : body.suitabilityCode || null,
      revisionCode: body.revisionCode === undefined ? before.revisionCode : body.revisionCode || null,
    };
    const settings = await loadCodeSettings(db, a.project.id);
    const profile = codeProfile(settings);
    const check = validateCodes(profile, state, wanted);
    // A value that is not changed is not checked again (existing data is grandfathered).
    const errors = check.errors.filter((e) => e.value !== before[e.field]);
    // Refused only when the project enforces the ISO 19650 rules (D-8); else kept with a warning.
    if (errors.length && settings.enforceTransitions) throw codeError(profile, state, errors);
    const warnings = warningDtos(
      requestLanguage(req),
      errors.map((e) => ({ ...e, state, msg: codeErrorMsg(profile, state, e) })),
    );
    const after = check.codes;
    if (after.suitabilityCode === before.suitabilityCode && after.revisionCode === before.revisionCode) {
      const names = await userNames(db, [version.uploadedBy]);
      return toVersionDto(version, names);
    }

    const [updated] = await db
      .update(fileVersions)
      .set({ ...after, codesSetBy: a.user.id, codesSetAt: new Date() })
      .where(eq(fileVersions.id, version.id))
      .returning();
    const details = {
      name: file.name,
      versionId: version.id,
      version: version.version,
      folderId: file.folderId,
      state,
      before,
      after,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(warnings.length ? { warnings: warnings.map(({ message: _m, ...w }) => w) } : {}),
    };
    await audit(db, { projectId: a.project.id, userId: a.user.id, action: "file.codes_changed", targetType: "file", targetId: file.id, details });
    if (locked)
      await audit(db, { projectId: a.project.id, userId: a.user.id, action: "cde.override", targetType: "file", targetId: file.id, details: { ...details, what: "codes" } });
    const names = await userNames(db, [updated!.uploadedBy]);
    return { ...toVersionDto(updated!, names), ...(warnings.length ? { warnings } : {}) };
  });

  api.get<{ Params: { pid: string } }>("/projects/:pid/cde/codes/unmapped", async (req): Promise<{ items: CdeUnmappedCodeDto[]; truncated: boolean }> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    return unmappedLegacyCodes(db, a.project.id);
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/cde/codes/apply", async (req): Promise<CdeApplyCodesReportDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    return applyLegacyCodes(db, a.project.id, { actorId: a.user.id });
  });
}
