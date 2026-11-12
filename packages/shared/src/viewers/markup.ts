/** PDF markups, issue links and IFC version comparison (Sprint B / E). */
import type { IssuePriority, IssueStatus } from "../core/types.js";

/** A point in PDF user space (points, origin bottom-left), so markups do not depend on zoom. */
export type PdfPoint = [number, number];

interface ShapeBase {
  /** CSS colour, e.g. "#d92d20". */
  color: string;
  /** Stroke width in PDF points. */
  width: number;
}

export type MarkupShape =
  | (ShapeBase & { type: "pen"; points: PdfPoint[] })
  | (ShapeBase & { type: "rect"; from: PdfPoint; to: PdfPoint })
  | (ShapeBase & { type: "cloud"; from: PdfPoint; to: PdfPoint })
  | (ShapeBase & { type: "arrow"; from: PdfPoint; to: PdfPoint })
  | (ShapeBase & { type: "text"; at: PdfPoint; text: string; size: number });

export type MarkupShapeType = MarkupShape["type"];

export interface MarkupDto {
  id: string;
  versionId: string;
  /** 1-based page number. */
  page: number;
  shapes: MarkupShape[];
  authorId: string;
  authorName?: string;
  /** Drafts are visible only to their author (like Forma). */
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export type IssueLinkKind = "markup" | "version" | "clash_group";

export interface IssueLinkDto {
  id: string;
  issueId: string;
  kind: IssueLinkKind;
  targetId: string;
  createdAt: string;
  /** Summary of the linked issue (lists on the PDF page). */
  issue?: { number: number; title: string; status: IssueStatus; priority: IssuePriority };
  /** Where the target lives (issue page). */
  target?: { fileId: string; fileName: string; versionId: string; version: number; page?: number; clashTestId?: string; title?: string };
}

/** File version with the caller's rights, for viewer pages that start from a version id. */
export interface VersionInfoDto {
  id: string;
  fileId: string;
  fileName: string;
  folderId: string;
  version: number;
  currentVersion: number;
  extension: string;
  size: number;
  uploadedAt: string;
  canDownload: boolean;
  canMarkup: boolean;
}

export interface CompareClassCount {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export interface VersionCompareDto {
  from: { versionId: string; fileName: string; version: number; elementCount: number };
  to: { versionId: string; fileName: string; version: number; elementCount: number };
  /** IFC GlobalIds. */
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  byClass: Record<string, CompareClassCount>;
  /** Class and name of every added, removed or changed element: GlobalId → [class, name]. */
  elements: Record<string, [string, string | null]>;
  /** Both indexes carry properties and storeys (new index format); otherwise only the lists above. */
  detailed?: boolean;
  /** An old-format index is being upgraded in the background; ask again for the detailed result. */
  upgrading?: boolean;
  /** Storey of every added / removed / changed element (detailed only). */
  storeys?: Record<string, string | null>;
  /** Property-level changes of changed elements: GlobalId → [{prop, from, to}] (detailed only). */
  changes?: Record<string, import("../coordination/model-query.js").ComparePropChange[]>;
  /** Changes grouped by kind, storey, class (and property), most significant first (detailed only). */
  groups?: import("../coordination/model-query.js").CompareGroupDto[];
}
