/** DTOs shared by the server, the web app and the MCP server. */
import type { PermissionLevel, SubjectType } from "../kernel/permissions.js";
import type { NamingStandard } from "../kernel/naming.js";
import type { ProjectModuleState } from "./module-state.js";

export type FolderState = "wip" | "shared" | "published" | "archived";

export const FOLDER_STATE_LABELS_TR: Record<FolderState, string> = {
  wip: "Çalışma",
  shared: "Paylaşılan",
  published: "Yayınlanan",
  archived: "Arşivlenen",
};

export interface UserDto {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  companyId: string | null;
  /** True until the user replaces the provisioned temporary password. */
  mustChangePassword?: boolean;
  /** Interface language from the profile (users.prefs.language); null = not chosen yet. */
  language?: string | null;
}

/** Password we set when creating accounts for someone else; first login must replace it. */
export const PROVISION_PASSWORD = "1234567890";

export interface CompanyDto {
  id: string;
  name: string;
  /** Short code (2–8 upper-case letters/digits) used in numbers; null = derived from the name. */
  code: string | null;
  /** Postal address (multi-line) and e-mail, used as the recipient of official letters. */
  address?: string | null;
  email?: string | null;
}

export interface ProjectDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rootFolderId: string;
  createdAt: string;
  /** The caller is a project administrator. */
  isProjectAdmin?: boolean;
  /** Module switches (Proje Ayarları → Modüller); missing = every module on. */
  modules?: ProjectModuleState;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  isProjectAdmin: boolean;
  /** Project roles (teams) the member holds. */
  roleIds?: string[];
}

export interface FolderDto {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  /** Free text shown in the "Açıklama" column. */
  description?: string | null;
  state: FolderState | null;
  /** Sub-status label, e.g. "Onay için" or "İş sonu" (project templates). */
  stateLabel?: string | null;
  namingStandardId: string | null;
  /** The caller's effective level on this folder. */
  myLevel?: PermissionLevel;
  canUpload?: boolean;
  /** True when the caller can see at least one real subfolder (tree chevron). */
  hasChildren?: boolean;
}

export type DerivativeStatus = "none" | "pending" | "processing" | "ready" | "failed";

export interface IfcSummary {
  schema: string;
  projectName: string | null;
  elementCount: number;
  byClass: Record<string, number>;
  /** GlobalId of the IfcProject (BCF header files); missing for files converted before BCF support. */
  projectGuid?: string | null;
  /**
   * Translation Fragments applied on import (scene = (x, z, −y) + offset), read from the derivative
   * when a viewpoint without its own offset is exported to BCF; cached here.
   */
  sceneOffset?: [number, number, number];
  /**
   * Curve tessellation the viewer derivative was built with (web-ifc CIRCLE_SEGMENTS: straight
   * pieces per full circle). Missing: converted before 24.10.2026 with web-ifc's default of 12.
   */
  geometry?: {
    circleSegments: number;
    /**
     * Conversion fixes the derivative carries (GEOMETRY_REVISION on the server): 2 = winding repair
     * (web-ifc's inside-out extrusion walls). Missing: older, rebuilt in place when opened.
     */
    revision?: number;
  };
}

export interface FileVersionDto {
  id: string;
  fileId: string;
  version: number;
  size: number;
  sha256: string;
  uploadedBy: string;
  uploadedByName?: string;
  uploadedAt: string;
  comment: string | null;
  derivativeStatus: DerivativeStatus;
  derivativeError: string | null;
  ifcSummary: IfcSummary | null;
}

export interface FileDto {
  id: string;
  folderId: string;
  name: string;
  /** Short free-text note shown next to the name ("Açıklama"); null when empty. */
  description: string | null;
  extension: string;
  currentVersion: number;
  attributes: Record<string, string>;
  createdAt: string;
  createdBy: string;
  latest: FileVersionDto;
}

export interface GrantDto {
  folderId: string;
  subjectType: SubjectType;
  subjectId: string;
  subjectName?: string;
  level: PermissionLevel;
  inherited?: boolean;
}

export interface NamingStandardDto {
  id: string;
  projectId: string;
  definition: NamingStandard;
}

export type IssueStatus = "open" | "in_progress" | "in_review" | "closed";
export type IssuePriority = "low" | "normal" | "high" | "critical";

export const ISSUE_STATUS_LABELS_TR: Record<IssueStatus, string> = {
  open: "Açık",
  in_progress: "Devam Ediyor",
  in_review: "İncelemede",
  closed: "Kapalı",
};

export const ISSUE_PRIORITY_LABELS_TR: Record<IssuePriority, string> = {
  low: "Düşük",
  normal: "Normal",
  high: "Yüksek",
  critical: "Kritik",
};

/**
 * BCF-style viewpoint in viewer (scene) coordinates: metres, Y up. Exported to / imported from
 * BCF (IFC world coordinates, Z up) by packages/shared/src/bcf.ts; every field except camera
 * position / target / projection and fileVersionIds is optional, so older viewpoints stay valid.
 */
export interface IssueViewpoint {
  /** BCF viewpoint GUID; set by the server when missing (older viewpoints get a derived one on export). */
  guid?: string;
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    projection: "perspective" | "orthographic";
    /** Camera up vector (scene axes). Missing = no roll (derived from +Y). */
    up?: Vec3;
    /** Perspective: vertical field of view in degrees. */
    fov?: number;
    /** Width / height of the view. */
    aspect?: number;
    /** Orthographic: visible height in metres (BCF ViewToWorldScale). */
    viewToWorldScale?: number;
  };
  /**
   * Frame of the coordinates: a point (x, y, z) of the IFC world is (x, z, −y) + sceneOffset in this
   * viewpoint. The viewer saves the offset Fragments moved its first model by (web-ifc
   * COORDINATE_TO_ORIGIN); BCF imports use [0, 0, 0]. Missing in viewpoints saved before BCF support.
   */
  sceneOffset?: Vec3;
  /** Model versions loaded when the viewpoint was taken. */
  fileVersionIds: string[];
  /** IFC GlobalIds of selected elements. */
  selection?: string[];
  snapshot?: string; // data URL (PNG/JPEG)
  /** Section planes and box (Kesit) active when the viewpoint was taken. Missing in older viewpoints. */
  sections?: ViewpointSections;
  /** Measurements (Ölçü) shown when the viewpoint was taken. Missing in older viewpoints. */
  measurements?: ViewpointMeasurement[];
  /** Hidden / isolated elements (BCF visibility). Missing = everything visible. */
  visibility?: ViewpointVisibility;
  /** Coloured elements (BCF coloring). */
  coloring?: ViewpointColoring[];
  /** Lines (BCF lines, scene coordinates); a line whose start equals its end is a point. */
  lines?: [Vec3, Vec3][];
  /** Imported BCF viewpoint without a camera: only the snapshot is meaningful, the camera is a placeholder. */
  snapshotOnly?: boolean;
}

/** BCF visibility: every element is `defaultVisible` except the listed GlobalIds. */
export interface ViewpointVisibility {
  defaultVisible: boolean;
  exceptions: string[];
  spacesVisible?: boolean;
  spaceBoundariesVisible?: boolean;
  openingsVisible?: boolean;
}

/** Elements drawn in one colour: "RRGGBB" or "AARRGGBB" (hex, upper case). */
export interface ViewpointColoring {
  color: string;
  guids: string[];
}

/** A point or direction in viewer (scene) coordinates: metres, Y up. */
export type Vec3 = [number, number, number];

/**
 * A section plane: a point on the plane and its normal (three.js clipping convention). The half
 * the normal points to stays visible, the other half is cut away. (BCF clipping planes point the
 * other way: an exporter negates the normal.)
 */
export interface ViewpointSectionPlane {
  origin: Vec3;
  normal: Vec3;
  /** false: kept in the list but switched off. */
  enabled?: boolean;
}

export interface ViewpointSections {
  planes: ViewpointSectionPlane[];
  /** Section box: only what is inside stays visible. */
  box?: { min: Vec3; max: Vec3 } | null;
}

/** One measurement saved with a viewpoint; value in m, m², ° or m³. */
export type ViewpointMeasurement =
  | { kind: "length"; points: [Vec3, Vec3]; value: number }
  | { kind: "area"; points: Vec3[]; value: number }
  | { kind: "angle"; points: [Vec3, Vec3, Vec3]; value: number }
  | { kind: "volume"; guids: string[]; value: number };

export interface IssuePin {
  position: [number, number, number];
  fileVersionId?: string;
  globalId?: string;
}

export interface IssueDto {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  type: string | null;
  assigneeUserId: string | null;
  assigneeCompanyId: string | null;
  dueDate: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  viewpoint: IssueViewpoint | null;
  pin: IssuePin | null;
  /** BCF topic GUID (= id for issues created here; kept from the file for imported ones). */
  guid?: string;
  labels?: string[];
  stage?: string | null;
  referenceLinks?: string[];
  /** Viewpoints after the first one (BCF topics may have several); the list leaves out snapshots. */
  extraViewpointCount?: number;
  /** Set when the issue came from a .bcfzip import. */
  importedFrom?: IssueImportInfo | null;
}

/** Where an imported issue came from, with the BCF values that had no match here. */
export interface IssueImportInfo {
  source: "bcf";
  version: string;
  fileName?: string;
  importedAt: string;
  importedBy?: string;
  /** BCF ModifiedDate (or CreationDate) of the topic at the last import: decides update vs. conflict. */
  topicModified?: string;
  /** Original BCF values (authors and assignee as e-mail, status, type, priority, server id). */
  creationAuthor?: string;
  modifiedAuthor?: string;
  assignedTo?: string;
  topicStatus?: string;
  topicType?: string;
  priority?: string;
  serverAssignedId?: string;
  /** Header files of the topic (IFC models it refers to). */
  files?: { filename?: string; ifcProject?: string; reference?: string; date?: string; fileVersionId?: string | null }[];
  /** Document references (kept, not shown). */
  documentReferences?: { guid?: string; url?: string; description?: string }[];
}

export interface IssueCommentDto {
  id: string;
  issueId: string;
  authorId: string;
  authorName?: string;
  body: string;
  createdAt: string;
  /** BCF comment GUID. */
  guid?: string;
  /** BCF viewpoint the comment refers to. */
  viewpointGuid?: string | null;
  /** Original BCF author when it matched no project member. */
  importedAuthor?: string | null;
}

/** One viewpoint of an issue (primary first) for the issue detail and the viewer (?issue=…&vp=…). */
export interface IssueViewpointDto {
  guid: string;
  index: number;
  primary: boolean;
  viewpoint: IssueViewpoint;
}

export interface AuditEntryDto {
  id: number;
  projectId: string | null;
  userId: string | null;
  userName?: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  at: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
