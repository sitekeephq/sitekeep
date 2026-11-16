/**
 * Model markups (FP-3, docs/features/MODEL_MARKUP.md): pins on a model element or point and
 * drawings (pen, rectangle, cloud, arrow, text) over the current view of an IFC model, saved with
 * the camera viewpoint of the BCF issue viewpoint structure.
 *
 * Drawings are kept in **view units**: the origin is the centre of the view, y points down and one
 * unit is 1/1000 of the view height. The vertical field of view (perspective) and the visible
 * height (orthographic) fix what the view shows vertically, so a drawing lands on the same part of
 * the model when the viewpoint is restored in a window of another width.
 */
import type { IssueViewpoint, Vec3 } from "../core/types.js";
import type { MarkupShape, PdfPoint } from "../viewers/markup.js";

export type ModelMarkupKind = "pin" | "drawing";
export type ModelMarkupStatus = "open" | "closed";
/** private: only the author sees it; project: everyone who can see its model versions. */
export type ModelMarkupVisibility = "private" | "project";

export const MODEL_MARKUP_KINDS: readonly ModelMarkupKind[] = ["pin", "drawing"];
export const MODEL_MARKUP_STATUSES: readonly ModelMarkupStatus[] = ["open", "closed"];
export const MODEL_MARKUP_VISIBILITIES: readonly ModelMarkupVisibility[] = ["private", "project"];
/** View units per view height. */
export const MODEL_MARKUP_VIEW_UNITS = 1000;
export const MODEL_MARKUP_COLORS = ["#d92d20", "#f79009", "#12b76a", "#2e90fa", "#7a5af8", "#101828"] as const;

/** Where a pin sits: a point in the frame of the markup's viewpoint (its sceneOffset), on an element when known. */
export interface ModelMarkupAnchor {
  point: Vec3;
  /** IFC GlobalId of the element under the pin. */
  globalId?: string | null;
  /** Model version the element belongs to. */
  fileVersionId?: string;
  /** Set on a carried-over markup: the element is not in the newer version. */
  missing?: boolean;
}

export interface ModelMarkupCommentDto {
  id: string;
  markupId: string;
  authorId: string;
  authorName?: string;
  body: string;
  createdAt: string;
}

export interface ModelMarkupDto {
  id: string;
  projectId: string;
  /** File and version the markup belongs to (the anchor's model, or the first model of the view). */
  fileId: string;
  fileName?: string;
  versionId: string;
  version?: number;
  /** Every model version of the view (federated views have several). */
  versionIds: string[];
  kind: ModelMarkupKind;
  title: string;
  color: string;
  status: ModelMarkupStatus;
  visibility: ModelMarkupVisibility;
  /** Camera and viewer state; lists leave the snapshot out. */
  viewpoint: IssueViewpoint;
  anchor: ModelMarkupAnchor | null;
  /** Drawing in view units (empty for a pin). */
  shapes: MarkupShape[];
  authorId: string;
  authorName?: string;
  issueId: string | null;
  issueNumber?: number | null;
  /** The markup on an older version this one was carried over from. */
  carriedFromId: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelMarkupDetailDto extends ModelMarkupDto {
  comments: ModelMarkupCommentDto[];
  canEdit: boolean;
  canComment: boolean;
}

export interface ModelMarkupListDto {
  /** Markups on the requested versions. */
  current: ModelMarkupDto[];
  /** Markups on older versions of the same files that were not carried over to the requested ones yet. */
  older: ModelMarkupDto[];
}

export interface ModelMarkupInput {
  kind: ModelMarkupKind;
  versionId: string;
  title?: string;
  color: string;
  visibility?: ModelMarkupVisibility;
  viewpoint: IssueViewpoint;
  anchor?: ModelMarkupAnchor | null;
  shapes?: MarkupShape[];
}

/** View units → pixels of a view of width × height. */
export function viewToPx(p: PdfPoint, width: number, height: number): [number, number] {
  const k = height / MODEL_MARKUP_VIEW_UNITS;
  return [width / 2 + p[0] * k, height / 2 + p[1] * k];
}

/** Pixels of a view of width × height → view units (rounded to 0.01). */
export function pxToView(p: [number, number], width: number, height: number): PdfPoint {
  const k = MODEL_MARKUP_VIEW_UNITS / Math.max(1, height);
  const r = (n: number) => Math.round(n * 100) / 100;
  return [r((p[0] - width / 2) * k), r((p[1] - height / 2) * k)];
}

/**
 * The view versions of a markup carried from version `from` to version `to` of the same file:
 * `from` is replaced, the other models of a federated view stay.
 */
export function carryVersionIds(ids: string[], from: string, to: string): string[] {
  const out = ids.map((id) => (id === from ? to : id));
  if (!out.includes(to)) out.unshift(to);
  return [...new Set(out)];
}

/** A point of a viewpoint frame (sceneOffset `from`) in another frame (`to`). */
export function rebasePoint(p: Vec3, from: Vec3 | undefined, to: Vec3): Vec3 {
  if (!from) return p;
  return [p[0] + to[0] - from[0], p[1] + to[1] - from[1], p[2] + to[2] - from[2]];
}
