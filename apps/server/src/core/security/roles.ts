/**
 * Permission maths for project roles: role-package plans and "who can see this folder?".
 * Pure functions over a loaded FolderTree; the routes load rows and write the results.
 */
import {
  can,
  effectivePermission,
  isDowngrade,
  rank,
  type AccessReasonDto,
  type EffectivePermission,
  type Grant,
  type PermissionLevel,
  type Principal,
  type RolePackage,
  type RolePackageAction,
  type RolePackagePlanEntry,
} from "@sitekeep/shared";
import type { FolderTree } from "./access.js";

export function folderPath(tree: FolderTree, id: string): string {
  return tree
    .ancestry(id)
    .map((x) => tree.get(x).name)
    .join(" / ");
}

/** True when `target` gives strictly more than `current` (upload_only is not on the view ladder). */
function raises(current: PermissionLevel, target: PermissionLevel): boolean {
  if (current === "upload_only") return target !== "upload_only" && can(target, "upload");
  if (target === "upload_only") return false;
  return rank(target) > rank(current);
}

/**
 * Company-level grants a role package would write. Folders with an ISO 19650 state get the
 * package's level for that state; the optional own-area folder gets `ownArea`. Existing grants
 * are never lowered or removed, and a subfolder grant lower than what the company inherits is
 * rejected (Forma's no-downgrade rule). Entries are ordered root-first so later entries see the
 * grants planned above them.
 */
export function planRolePackage(
  tree: FolderTree,
  companyId: string,
  pkg: RolePackage,
  areaFolderId: string | null,
): RolePackagePlanEntry[] {
  const targets = new Map<string, { level: PermissionLevel; reason: "state" | "own_area" }>();
  for (const f of tree.byId.values()) if (f.state) targets.set(f.id, { level: pkg.states[f.state], reason: "state" });
  if (areaFolderId) {
    const cur = targets.get(areaFolderId);
    if (!cur || cur.level === "none" || raises(cur.level, pkg.ownArea))
      targets.set(areaFolderId, { level: pkg.ownArea, reason: "own_area" });
  }
  const paths = new Map([...targets.keys()].map((id) => [id, folderPath(tree, id)]));
  const order = [...targets.keys()].sort(
    (x, y) => tree.ancestry(x).length - tree.ancestry(y).length || paths.get(x)!.localeCompare(paths.get(y)!, "tr"),
  );

  const grants: Grant[] = tree.grants.map((g) => ({ ...g }));
  const principal: Principal = { userId: "", companyId };
  const entries: RolePackagePlanEntry[] = [];
  for (const id of order) {
    const t = targets.get(id)!;
    const folder = tree.get(id);
    const direct = grants.find((g) => g.folderId === id && g.subjectType === "company" && g.subjectId === companyId);
    const current = direct?.level ?? null;
    const inherited = folder.parentId ? effectivePermission(principal, tree.ancestry(folder.parentId), grants).level : "none";
    let action: RolePackageAction;
    if (t.level === "none") action = "no_grant";
    else if (current === t.level) action = "unchanged";
    else if (current && !raises(current, t.level)) action = "kept_higher";
    else if (isDowngrade(inherited, t.level)) action = "rejected_lower_than_inherited";
    else if (!current && inherited === t.level) action = "covered_by_inherited";
    else action = current ? "upgrade" : "create";

    if (action === "create") grants.push({ folderId: id, subjectType: "company", subjectId: companyId, level: t.level });
    if (action === "upgrade") direct!.level = t.level;
    entries.push({
      folderId: id,
      folderPath: paths.get(id)!,
      state: folder.state,
      reason: t.reason,
      level: t.level,
      current,
      inherited,
      action,
    });
  }
  return entries;
}

export interface AccessSubject extends Principal {
  systemAdmin?: boolean;
}

export interface AccessExplanation extends EffectivePermission {
  reasons: AccessReasonDto[];
}

/**
 * Effective level of a principal on a folder plus every grant that contributes to it.
 * Names are filled in by the caller (`subjectName`).
 */
export function explainFolderAccess(tree: FolderTree, who: AccessSubject, folderId: string): AccessExplanation {
  const perm = tree.permission(who, folderId);
  if (who.projectAdmin) {
    return {
      ...perm,
      reasons: [{ via: who.systemAdmin ? "system_admin" : "project_admin", level: "manage", inherited: false, decisive: true }],
    };
  }
  const chain = new Set(tree.ancestry(folderId));
  const roles = new Set(who.roleIds ?? []);
  const reasons: AccessReasonDto[] = [];
  for (const g of tree.grants) {
    if (!chain.has(g.folderId)) continue;
    const matches =
      (g.subjectType === "user" && g.subjectId === who.userId) ||
      (g.subjectType === "company" && !!who.companyId && g.subjectId === who.companyId) ||
      (g.subjectType === "role" && roles.has(g.subjectId));
    if (!matches) continue;
    const decisive =
      g.level === perm.level || (g.level === "upload_only" && perm.canUpload && !can(perm.level, "upload"));
    reasons.push({
      via: g.subjectType,
      subjectId: g.subjectId,
      level: g.level,
      folderId: g.folderId,
      folderName: tree.get(g.folderId).name,
      inherited: g.folderId !== folderId,
      decisive,
    });
  }
  reasons.sort((x, y) => Number(y.decisive) - Number(x.decisive) || rank(y.level) - rank(x.level));
  return { ...perm, reasons };
}
