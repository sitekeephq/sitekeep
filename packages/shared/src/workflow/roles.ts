/**
 * Project roles (teams), role packages and "who can see this?" vocabulary.
 *
 * A project role is a named group of members ("İdare Mimari Ekip", "Danışman Teknik Ofis").
 * Roles are used as folder-permission subjects and as workflow step assignees; a member who
 * holds the role answers a step "on behalf of" the role, so shared function accounts are no
 * longer needed.
 */
import type { PermissionLevel } from "../kernel/permissions.js";
import { labelText, sharedText, SHARED_DEFAULT_LANGUAGE, type SharedParams } from "../platform/i18n.js";
import type { FolderState } from "../core/types.js";
import type { AssigneeType } from "./assignee-types.js";

export interface ProjectRoleDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** CSS colour (#rrggbb) for chips; null = default. */
  color: string | null;
  /** Members holding the role. */
  memberIds: string[];
}

/**
 * Seeded on every project (root-folder grants). New members pick one of these in Üye Ekle.
 * Highest matching grant still wins if a company grant also exists.
 */
export const DEFAULT_PROJECT_ROLES = [
  {
    name: "Görüntüleyici", // i18n-ok: default role seeded into projects as data
    description: "Dosyaları görüntüler ve indirir; yükleme yok.", // i18n-ok: default role seeded into projects as data
    color: "#5f6b7a",
    level: "view_download" as const,
    projectAdmin: false,
  },
  {
    name: "Düzenleyici", // i18n-ok: default role seeded into projects as data
    description: "Dosya yükler ve düzenler.", // i18n-ok: default role seeded into projects as data
    color: "#157a3d",
    level: "edit" as const,
    projectAdmin: false,
  },
  {
    name: "Yönetici", // i18n-ok: default role seeded into projects as data
    description: "Klasör yetkilerini yönetir ve proje ayarlarına girer.", // i18n-ok: default role seeded into projects as data
    color: "#0b6bcb",
    level: "manage" as const,
    projectAdmin: true,
  },
] as const;

/** Who a workflow answer was given for: a team (role) or a company, besides the person. */
export interface OnBehalfOfDto {
  type: AssigneeType;
  id: string;
  name?: string;
}

// ---- Role packages (KONSEPT §4) -------------------------------------------------------------

export const ROLE_PACKAGE_KEYS = ["idare", "musavir", "tasarimci", "yuklenici"] as const;
export type RolePackageKey = (typeof ROLE_PACKAGE_KEYS)[number];

export interface RolePackage {
  key: RolePackageKey;
  label: string;
  description: string;
  /** Level written on every folder with this ISO 19650 state ("none" = no grant is written). */
  states: Record<FolderState, PermissionLevel>;
  /** Level on the company's own area folder (optional, chosen when the package is applied). */
  ownArea: PermissionLevel;
}

/**
 * Default folder permissions per party. WIP stays closed to other parties (ISO 19650: work in
 * progress is private to the task team); each party works in its own area. Designer and
 * contractor get "Düzenle" on SHARED because starting a review that copies into SHARED needs
 * upload rights there (Forma's "Yükle" has no closer 7D level).
 */
const ROLE_PACKAGE_GRANTS: Record<RolePackageKey, Pick<RolePackage, "states" | "ownArea">> = {
  idare: {
    states: { wip: "none", shared: "view_download_markup", published: "view_download_markup", archived: "view_download" },
    ownArea: "manage",
  },
  musavir: {
    states: { wip: "none", shared: "view_download_markup", published: "view_download", archived: "view_download" },
    ownArea: "manage",
  },
  tasarimci: {
    states: { wip: "none", shared: "edit", published: "view_download", archived: "view_download" },
    ownArea: "manage",
  },
  yuklenici: {
    states: { wip: "none", shared: "edit", published: "view_download", archived: "view_download" },
    ownArea: "manage",
  },
};

/** A role package with its label and description in `lang`. */
export function rolePackage(key: RolePackageKey, lang: string = SHARED_DEFAULT_LANGUAGE): RolePackage {
  return {
    key,
    label: sharedText(lang, `roles.packages.${key}.label`),
    description: sharedText(lang, `roles.packages.${key}.description`),
    ...ROLE_PACKAGE_GRANTS[key],
  };
}

export function isRolePackageKey(v: unknown): v is RolePackageKey {
  return typeof v === "string" && (ROLE_PACKAGE_KEYS as readonly string[]).includes(v);
}

/**
 * What applying a package does on one folder:
 * - create / upgrade: a grant is written
 * - unchanged: the company already has exactly this grant here
 * - kept_higher: the company already has a higher (or incomparable) grant here; never lowered
 * - covered_by_inherited: a parent folder already gives the same level
 * - rejected_lower_than_inherited: a parent gives more; a subfolder cannot be lower (no-downgrade)
 * - no_grant: the package gives no access to this state (nothing is written, nothing removed)
 */
export type RolePackageAction =
  | "create"
  | "upgrade"
  | "unchanged"
  | "kept_higher"
  | "covered_by_inherited"
  | "rejected_lower_than_inherited"
  | "no_grant";

export const ROLE_PACKAGE_ACTION_LABELS_TR: Record<RolePackageAction, string> = {
  create: "Yeni yetki yazılacak",
  upgrade: "Mevcut yetki yükseltilecek",
  unchanged: "Zaten aynı yetki var",
  kept_higher: "Daha yüksek yetki korunuyor",
  covered_by_inherited: "Üst klasörden zaten geliyor",
  rejected_lower_than_inherited: "Üst klasördeki yetkiden düşük olamaz",
  no_grant: "Erişim verilmiyor",
};

export const WRITING_ACTIONS: readonly RolePackageAction[] = ["create", "upgrade"];

export interface RolePackagePlanEntry {
  folderId: string;
  folderPath: string;
  state: FolderState | null;
  /** Why the folder is in the plan. */
  reason: "state" | "own_area";
  level: PermissionLevel;
  /** The company's direct grant on this folder before applying (null = none). */
  current: PermissionLevel | null;
  /** What the company inherits from parent folders (incl. earlier entries of this plan). */
  inherited: PermissionLevel;
  action: RolePackageAction;
}

export interface RolePackagePlanDto {
  package: RolePackageKey;
  companyId: string;
  companyName: string;
  /** Project members representing the company (0 = the grants reach nobody yet). */
  memberCount: number;
  areaFolderId: string | null;
  entries: RolePackagePlanEntry[];
  /** Number of grants written (apply) or that would be written (preview). */
  writes: number;
  applied: boolean;
}

// ---- Who can see? -----------------------------------------------------------------------------

export type AccessVia = "user" | "company" | "role" | "project_admin" | "system_admin";

export interface AccessReasonDto {
  via: AccessVia;
  subjectId?: string;
  subjectName?: string;
  level: PermissionLevel;
  /** Folder carrying the grant (absent for admin reasons). */
  folderId?: string;
  folderName?: string;
  /** The grant sits on a parent folder. */
  inherited: boolean;
  /** This grant decides the effective level (or the upload right). */
  decisive: boolean;
}

export interface WhoCanSeeEntryDto {
  userId: string;
  name: string;
  email: string;
  companyName: string | null;
  roleNames: string[];
  disabled: boolean;
  level: PermissionLevel;
  canUpload: boolean;
  /** Sees the folder's files (or, with fileId, that file). */
  canSee: boolean;
  reasons: AccessReasonDto[];
  /** Plain Turkish sentence. */
  explanation: string;
}

export interface WhoCanSeeDto {
  folderId: string;
  folderPath: string;
  fileId: string | null;
  fileName: string | null;
  entries: WhoCanSeeEntryDto[];
}

export const ACCESS_VIA_LABELS_TR: Record<AccessVia, string> = {
  user: "kişisel yetkisi",
  company: "firma yetkisi",
  role: "rol yetkisi",
  project_admin: "proje yöneticisi",
  system_admin: "sistem yöneticisi",
};

function reasonText(r: AccessReasonDto, lang: string): string {
  const t = (key: string, params?: SharedParams) => sharedText(lang, `roles.access.${key}`, params);
  if (r.via === "project_admin") return t("reason.projectAdmin");
  if (r.via === "system_admin") return t("reason.systemAdmin");
  const who =
    r.via === "user"
      ? t("via.user")
      : r.subjectName
        ? t(r.via === "company" ? "via.namedCompany" : "via.namedRole", { name: r.subjectName })
        : t(r.via === "company" ? "via.company" : "via.role");
  const where = r.inherited && r.folderName ? t("inheritedFrom", { folder: r.folderName }) : r.inherited ? t("inherited") : "";
  return t("reason.grant", { who, where, level: labelText(lang, "level", r.level) });
}

/** One readable sentence for a member, e.g. "Ali — "Mimari Ekip" rolü üzerinden (…): Düzenle." */
export function explainAccess(
  e: Pick<WhoCanSeeEntryDto, "name" | "level" | "canSee" | "canUpload" | "reasons">,
  lang: string = SHARED_DEFAULT_LANGUAGE,
): string {
  const t = (key: string, params?: SharedParams) => sharedText(lang, `roles.access.${key}`, params);
  if (!e.reasons.length) return t("noAccess", { name: e.name });
  const decisive = e.reasons.filter((r) => r.decisive);
  const shown = decisive.length ? decisive : e.reasons;
  const head = !e.canSee
    ? t("head.fileUploadOnly", { name: e.name })
    : e.level === "upload_only"
      ? t("head.uploadOnly", { name: e.name })
      : t("head.canSee", { name: e.name, level: labelText(lang, "level", e.level) });
  const extra = e.reasons.length - shown.length;
  const reasons = shown.map((r) => reasonText(r, lang)).join("; ");
  return extra > 0 ? t("sentenceWithLower", { head, reasons, count: extra }) : t("sentence", { head, reasons });
}
