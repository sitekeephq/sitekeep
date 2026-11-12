/** Model coordination (Sprint E): model sets, clash tests and IDS checks. */
import type { ViewpointMeasurement, ViewpointSections } from "../core/types.js";

/** One file of a model set: the latest version (versionId null) or a pinned version. */
export interface ModelSetItem {
  fileId: string;
  versionId: string | null;
}

/** Visibility / colour rule of a saved view, applied by IFC class. */
export interface ViewRule {
  /** IFC classes, e.g. ["IfcWall", "IfcSlab"] (case-insensitive). Empty = every element. */
  classes: string[];
  /** Limit to these files of the set (empty = all). */
  fileIds?: string[];
  action: "hide" | "color" | "isolate";
  /** "#rrggbb" for action "color". */
  color?: string;
  /** 0..1, for action "color". */
  opacity?: number;
}

export interface ModelSetViewState {
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    projection: "perspective" | "orthographic";
  };
  /** Files of the set that are switched off in this view. */
  hiddenFileIds: string[];
  rules: ViewRule[];
  /** Section planes and box of the view (missing in older views). */
  sections?: ViewpointSections;
  /** Measurements of the view (missing in older views). */
  measurements?: ViewpointMeasurement[];
}

export interface ModelSetViewDto {
  id: string;
  modelSetId: string;
  name: string;
  state: ModelSetViewState;
  createdBy: string | null;
  createdByName?: string;
  createdAt: string;
}

export interface ModelSetItemDto extends ModelSetItem {
  fileName: string | null;
  folderPath: string | null;
  /** The version the item resolves to now (null when the file is gone or not visible). */
  resolvedVersionId: string | null;
  resolvedVersion: number | null;
  derivativeStatus: string | null;
  /** True when the caller cannot see the file (name and version are hidden). */
  hidden?: boolean;
  missing?: boolean;
}

export interface ModelSetDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  items: ModelSetItemDto[];
  views: ModelSetViewDto[];
  createdBy: string | null;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

/** Which elements take part on one side of a clash test. */
export interface ClashSelection {
  /** Files of the model set (empty = every file of the set). */
  fileIds: string[];
  /** IFC classes (case-insensitive, "IfcWall" also matches IfcWallStandardCase). Empty = every building element. */
  classes: string[];
  /** Optional property filter: the element (or its type) has the property; with value, the value must match. */
  property?: { pset: string; name: string; value?: string | null } | null;
}

export type ClashType = "hard" | "clearance";

export type ClashGroupBy = "elementA" | "storey" | "classPair" | "system";

export type ClashStatus = "new" | "active" | "resolved" | "approved";

export type ClashRunStatus = "queued" | "running" | "done" | "failed";

export const CLASH_GROUP_BY_LABELS_TR: Record<ClashGroupBy, string> = {
  elementA: "A Elemanına Göre",
  storey: "Kata Göre",
  classPair: "Sınıf Çiftine Göre",
  system: "Sisteme Göre",
};

export interface ClashRunStats {
  elementsA: number;
  elementsB: number;
  triangles: number;
  candidatePairs: number;
  clashes: number;
  new: number;
  active: number;
  resolved: number;
  durationMs: number;
  /** Per phase timings (ms): geometry, broad, narrow. */
  timings?: Record<string, number>;
  warnings?: string[];
}

export interface ClashRunDto {
  id: string;
  testId: string;
  status: ClashRunStatus;
  error: string | null;
  stats: ClashRunStats | null;
  versions: { fileId: string; versionId: string; version: number; fileName: string }[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ClashTestDto {
  id: string;
  projectId: string;
  modelSetId: string;
  modelSetName?: string;
  name: string;
  selectionA: ClashSelection;
  selectionB: ClashSelection;
  type: ClashType;
  /** Hard: penetrations up to this depth are ignored. Clearance: minimum required distance. */
  toleranceMm: number;
  groupBy: ClashGroupBy;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: ClashRunDto | null;
  counts: Record<ClashStatus, number>;
  canManage: boolean;
}

export interface ClashElementDto {
  fileId: string;
  versionId: string;
  globalId: string;
  ifcClass: string;
  name: string | null;
  storey: string | null;
  system: string | null;
}

export interface ClashDto {
  /** Stable id: hash of the test and the (file, GlobalId) pair, the same on every run. */
  id: string;
  testId: string;
  groupId: string | null;
  a: ClashElementDto;
  b: ClashElementDto;
  /** IFC world coordinates (metres, Z up). */
  point: [number, number, number];
  /** Metres. Negative = penetration depth estimate (hard clash), positive = clearance distance. */
  distance: number;
  status: ClashStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface ClashGroupDto {
  id: string;
  testId: string;
  key: string;
  title: string;
  assignedCompanyId: string | null;
  assignedCompanyName?: string | null;
  issueId: string | null;
  issueNumber?: number | null;
  counts: Record<ClashStatus, number>;
  /** Clash ids in the group (all statuses). */
  clashIds: string[];
}

export interface ClashResultsDto {
  test: ClashTestDto;
  groups: ClashGroupDto[];
  clashes: ClashDto[];
  /** "IfcWall × IfcDuctSegment" → counts by status. */
  byClassPair: { pair: string; counts: Record<ClashStatus, number> }[];
}

export interface ClashSummaryDto {
  stats: Record<string, unknown>;
  summary: string;
  source: "ai" | "deterministic";
  model?: string;
  aiError?: string;
}

/** IDS check (information delivery specification) of one IFC version. */
export type IdsReportStatus = "queued" | "running" | "done" | "failed";

export interface IdsFailure {
  globalId: string;
  ifcClass: string;
  name: string | null;
  reasons: string[];
}

export interface IdsSpecResult {
  name: string;
  description: string | null;
  ifcVersions: string[];
  status: "pass" | "fail" | "skipped";
  applicable: number;
  passed: number;
  failed: number;
  /** Requirement texts, for the report. */
  requirements: string[];
  /** Facets of the subset this checker does not evaluate (reported, not silently passed). */
  unsupported: string[];
  failures: IdsFailure[];
  /** True when failures were cut to the report limit. */
  truncated?: boolean;
  note?: string;
}

export interface IdsReportDto {
  id: string;
  projectId: string;
  idsVersionId: string;
  ifcVersionId: string;
  idsFileName: string | null;
  ifcFileName: string | null;
  ifcVersion: number | null;
  status: IdsReportStatus;
  error: string | null;
  title: string | null;
  specs: IdsSpecResult[];
  totals: { specs: number; passed: number; failed: number; skipped: number; elementsChecked: number } | null;
  createdBy: string | null;
  createdByName?: string;
  createdAt: string;
  finishedAt: string | null;
}
