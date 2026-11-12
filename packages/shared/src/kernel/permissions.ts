/**
 * Folder permission levels and inheritance.
 *
 * The levels mirror Autodesk Forma (ACC) Docs so that permissions can be migrated
 * one-to-one and users see familiar names. A permission granted on a folder applies
 * to every subfolder; a subfolder can raise a subject's level but never lower it.
 */

export const PERMISSION_LEVELS = [
  "none",
  "view",
  "view_download",
  "view_download_markup",
  "upload_only",
  "edit",
  "manage",
] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export type Action =
  | "view" // see the folder and files
  | "download"
  | "markup"
  | "upload" // add files / new versions
  | "edit" // rename, move, delete, edit attributes of any file
  | "manage"; // folder permissions, naming standard, subfolders

const ACTIONS: Record<PermissionLevel, readonly Action[]> = {
  none: [],
  view: ["view"],
  view_download: ["view", "download"],
  view_download_markup: ["view", "download", "markup"],
  // Upload only: the user can add files and sees only the files they uploaded.
  upload_only: ["upload"],
  edit: ["view", "download", "markup", "upload", "edit"],
  manage: ["view", "download", "markup", "upload", "edit", "manage"],
};

export const LEVEL_LABELS_TR: Record<PermissionLevel, string> = {
  none: "Yetki Yok",
  view: "Görüntüle",
  view_download: "Görüntüle + İndir",
  view_download_markup: "Görüntüle + İndir + İşaretle",
  upload_only: "Sadece Yükle",
  edit: "Düzenle",
  manage: "Yönet",
};

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

export function actionsFor(level: PermissionLevel): readonly Action[] {
  return ACTIONS[level];
}

export function can(level: PermissionLevel, action: Action): boolean {
  return ACTIONS[level].includes(action);
}

/** Rank used when combining grants: the higher rank wins. */
export function rank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export type SubjectType = "user" | "company" | "role";

export interface Grant {
  folderId: string;
  subjectType: SubjectType;
  subjectId: string;
  level: PermissionLevel;
}

export interface Principal {
  userId: string;
  companyId?: string | null;
  roleIds?: readonly string[];
  /** Project administrators manage every folder. */
  projectAdmin?: boolean;
}

export interface EffectivePermission {
  level: PermissionLevel;
  /** True when the user may upload even though their level does not include it. */
  canUpload: boolean;
}

/**
 * Effective permission of a principal on a folder. The highest grant wins, except that
 * upload_only is not part of the view ladder: a viewer who also has upload_only keeps
 * their view level and gains canUpload.
 * @param ancestry folder ids from the root down to the folder itself
 * @param grants every grant on any folder of the ancestry
 */
export function effectivePermission(
  principal: Principal,
  ancestry: readonly string[],
  grants: readonly Grant[],
): EffectivePermission {
  if (principal.projectAdmin) return { level: "manage", canUpload: true };
  const inChain = new Set(ancestry);
  const roles = new Set(principal.roleIds ?? []);
  let level: PermissionLevel = "none";
  let canUpload = false;
  for (const g of grants) {
    if (!inChain.has(g.folderId)) continue;
    const matches =
      (g.subjectType === "user" && g.subjectId === principal.userId) ||
      (g.subjectType === "company" && !!principal.companyId && g.subjectId === principal.companyId) ||
      (g.subjectType === "role" && roles.has(g.subjectId));
    if (!matches) continue;
    if (can(g.level, "upload")) canUpload = true;
    if (g.level === "upload_only") {
      if (level === "none") level = "upload_only";
      continue;
    }
    if (level === "upload_only" || rank(g.level) > rank(level)) level = g.level;
  }
  return { level, canUpload: canUpload || can(level, "upload") };
}

/**
 * True when a subfolder grant would be lower than what the subject already inherits.
 * Forma rejects lowering an inherited permission on a subfolder; so do we.
 */
export function isDowngrade(inherited: PermissionLevel, requested: PermissionLevel): boolean {
  if (inherited === "none") return false;
  if (requested === "upload_only") return inherited !== "upload_only";
  if (inherited === "upload_only") return false;
  return rank(requested) < rank(inherited);
}
