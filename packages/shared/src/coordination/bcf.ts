/**
 * BCF mapping layer, shared by the server (.bcfzip import / export, later BCF API 3.0), the web
 * viewer and the MCP tools (docs/features/BCF.md).
 *
 * - The BCF shapes below are the BCF API 3.0 JSON resources (snake_case). The BCF-XML reader and
 *   writer (apps/server/src/bcf/bcf-xml.ts) convert .bcfzip files to and from them, so the BCF API
 *   can serve the same objects.
 * - Coordinates: BCF uses the IFC world (metres, Z up). Our viewpoints use the viewer scene: three.js
 *   Y up, shifted by the translation web-ifc / Fragments applied on import (COORDINATE_TO_ORIGIN):
 *   scene = (x, z, −y) + sceneOffset. Directions only rotate.
 * - Clipping planes: BCF directions point to the hidden half, ours (three.js) to the visible half.
 */
import type {
  IssuePriority,
  IssueStatus,
  IssueViewpoint,
  Vec3,
  ViewpointColoring,
  ViewpointSectionPlane,
  ViewpointSections,
  ViewpointVisibility,
} from "../core/types.js";

export type BcfVersion = "2.1" | "3.0";
export const BCF_VERSIONS: readonly BcfVersion[] = ["2.1", "3.0"];
/** BCF 2.1 is what Navisworks, Revit plug-ins, BIMcollab ZOOM and Solibri read most reliably. */
export const BCF_DEFAULT_VERSION: BcfVersion = "2.1";

// ------------------------------------------------------------------ BCF API 3.0 JSON shapes

export interface BcfPoint {
  x: number;
  y: number;
  z: number;
}

interface BcfCameraBase {
  camera_view_point: BcfPoint;
  camera_direction: BcfPoint;
  camera_up_vector: BcfPoint;
  /** Width / height. Required in BCF 3.0, missing in 2.1 files. */
  aspect_ratio?: number;
}

export interface BcfPerspectiveCamera extends BcfCameraBase {
  /** Vertical field of view in degrees. */
  field_of_view: number;
}

export interface BcfOrthogonalCamera extends BcfCameraBase {
  /** Visible height of the view in metres. */
  view_to_world_scale: number;
}

export interface BcfComponent {
  ifc_guid?: string | null;
  originating_system?: string | null;
  authoring_tool_id?: string | null;
}

export interface BcfViewSetupHints {
  spaces_visible?: boolean;
  space_boundaries_visible?: boolean;
  openings_visible?: boolean;
}

export interface BcfComponents {
  selection?: BcfComponent[];
  visibility?: { default_visibility: boolean; exceptions?: BcfComponent[]; view_setup_hints?: BcfViewSetupHints };
  coloring?: { color: string; components: BcfComponent[] }[];
}

export interface BcfLine {
  start_point: BcfPoint;
  end_point: BcfPoint;
}

export interface BcfClippingPlane {
  location: BcfPoint;
  /** Normal pointing to the clipped (hidden) half. */
  direction: BcfPoint;
}

export interface BcfSnapshot {
  snapshot_type: "png" | "jpg";
  /** Base64, no data-URL prefix. */
  snapshot_data: string;
}

export interface BcfViewpoint {
  guid: string;
  /** Sort order within the topic. */
  index?: number | null;
  perspective_camera?: BcfPerspectiveCamera | null;
  orthogonal_camera?: BcfOrthogonalCamera | null;
  lines?: BcfLine[];
  clipping_planes?: BcfClippingPlane[];
  components?: BcfComponents;
  snapshot?: BcfSnapshot | null;
}

/** Topic header file (BCF API: topics/{guid}/files): an IFC model the topic refers to. */
export interface BcfFileRef {
  ifc_project?: string | null;
  ifc_spatial_structure_element?: string | null;
  filename?: string | null;
  date?: string | null;
  /** URI or server id; our exports write the file version id. */
  reference?: string | null;
  is_external?: boolean;
}

export interface BcfComment {
  guid: string;
  date: string;
  author: string;
  comment: string;
  viewpoint_guid?: string | null;
  modified_date?: string | null;
  modified_author?: string | null;
}

export interface BcfDocumentReference {
  guid?: string;
  document_guid?: string | null;
  url?: string | null;
  description?: string | null;
}

export interface BcfTopic {
  guid: string;
  server_assigned_id?: string | null;
  topic_type: string;
  topic_status: string;
  title: string;
  priority?: string | null;
  index?: number | null;
  labels: string[];
  creation_date: string;
  creation_author: string;
  modified_date?: string | null;
  modified_author?: string | null;
  due_date?: string | null;
  assigned_to?: string | null;
  stage?: string | null;
  description?: string | null;
  reference_links: string[];
  related_topics: { related_topic_guid: string }[];
  document_references?: BcfDocumentReference[];
}

/** One topic with everything its .bcfzip folder holds: markup.bcf, viewpoints, snapshots. */
export interface BcfTopicBundle {
  topic: BcfTopic;
  files: BcfFileRef[];
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
}

// ------------------------------------------------------------------ coordinates

const ZERO: Vec3 = [0, 0, 0];
/** +0 instead of −0, so mapped values compare equal to the originals. */
const z0 = (n: number) => n + 0;

/** IFC world point (metres, Z up) → viewer scene point in the frame `offset`. */
export function ifcToScene(p: Vec3, offset: Vec3 = ZERO): Vec3 {
  return [z0(p[0] + offset[0]), z0(p[2] + offset[1]), z0(-p[1] + offset[2])];
}

/** Viewer scene point in the frame `offset` → IFC world point (metres, Z up). */
export function sceneToIfc(p: Vec3, offset: Vec3 = ZERO): Vec3 {
  return [z0(p[0] - offset[0]), z0(-(p[2] - offset[2])), z0(p[1] - offset[1])];
}

export function ifcDirToScene(d: Vec3): Vec3 {
  return [z0(d[0]), z0(d[2]), z0(-d[1])];
}

export function sceneDirToIfc(d: Vec3): Vec3 {
  return [z0(d[0]), z0(-d[2]), z0(d[1])];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const finite = (a: Vec3) => a.every((n) => Number.isFinite(n));

function normalize(a: Vec3): Vec3 | null {
  const l = len(a);
  return l > 1e-12 && Number.isFinite(l) ? [z0(a[0] / l), z0(a[1] / l), z0(a[2] / l)] : null;
}

const toPoint = (v: Vec3): BcfPoint => ({ x: v[0], y: v[1], z: v[2] });
const fromPoint = (p: BcfPoint | null | undefined): Vec3 | null => {
  if (!p) return null;
  const v: Vec3 = [Number(p.x), Number(p.y), Number(p.z)];
  return finite(v) ? v : null;
};

/** Scene up vector without roll for a view direction: +Y, or IFC north (−Z scene) when looking straight up / down. */
export function defaultUp(dir: Vec3): Vec3 {
  const right = cross(dir, [0, 1, 0]);
  if (len(right) < 1e-6) return [0, 0, -1];
  return normalize(cross(right, dir)) ?? [0, 1, 0];
}

/** `up` made perpendicular to `dir` (Gram–Schmidt); falls back to the roll-free up. */
function orthoUp(dir: Vec3, up: Vec3 | undefined): Vec3 {
  if (!up || !finite(up)) return defaultUp(dir);
  return normalize(sub(up, scale(dir, dot(up, dir)))) ?? defaultUp(dir);
}

/**
 * Moves a viewpoint into another frame (the viewer's current sceneOffset): every point is shifted
 * by `offset − vp.sceneOffset`. Viewpoints without a sceneOffset are taken as already in the frame.
 */
export function rebaseViewpoint(vp: IssueViewpoint, offset: Vec3): IssueViewpoint {
  const from = vp.sceneOffset;
  if (!from) return vp;
  const d = sub(offset, from);
  if (d.every((n) => n === 0)) return vp;
  const mv = (p: Vec3): Vec3 => add(p, d);
  const out: IssueViewpoint = {
    ...vp,
    sceneOffset: offset,
    camera: { ...vp.camera, position: mv(vp.camera.position), target: mv(vp.camera.target) },
  };
  if (vp.sections) {
    out.sections = {
      planes: vp.sections.planes.map((p) => ({ ...p, origin: mv(p.origin) })),
      ...(vp.sections.box !== undefined && { box: vp.sections.box ? { min: mv(vp.sections.box.min), max: mv(vp.sections.box.max) } : null }),
    };
  }
  if (vp.measurements) {
    out.measurements = vp.measurements.map((m) => (m.kind === "volume" ? m : ({ ...m, points: m.points.map(mv) } as typeof m)));
  }
  if (vp.lines) out.lines = vp.lines.map(([a, b]) => [mv(a), mv(b)]);
  return out;
}

// ------------------------------------------------------------------ viewpoint ↔ BCF

/** Default vertical field of view (That Open's perspective camera). */
export const BCF_DEFAULT_FOV = 60;
/** Default aspect ratio when a viewpoint did not record one. */
export const BCF_DEFAULT_ASPECT = 16 / 9;
/** Orbit target distance for imported cameras (BCF has a direction, no target). */
export const BCF_TARGET_DISTANCE = 10;

export interface ViewpointToBcfOptions {
  guid: string;
  index?: number;
  /** Frame for viewpoints saved without sceneOffset (older ones): the first model's offset, if known. */
  fallbackOffset?: Vec3;
  /** Aspect ratio when the viewpoint has none (e.g. from the snapshot size). */
  aspect?: number;
  /** Issue pin (scene coordinates, same frame) written as a point line. */
  pin?: Vec3 | null;
}

/** Our viewpoint → BCF viewpoint (IFC world coordinates). The snapshot is added by the caller. */
export function viewpointToBcf(vp: IssueViewpoint, o: ViewpointToBcfOptions): BcfViewpoint {
  const offset = vp.sceneOffset ?? o.fallbackOffset ?? ZERO;
  const out: BcfViewpoint = { guid: o.guid, ...(o.index !== undefined && { index: o.index }) };
  if (vp.snapshotOnly) return out;

  const pos = vp.camera.position;
  const dir = normalize(sub(vp.camera.target, pos)) ?? [0, 0, -1];
  const up = orthoUp(dir, vp.camera.up);
  const aspect = positive(vp.camera.aspect) ?? positive(o.aspect) ?? BCF_DEFAULT_ASPECT;
  const base: BcfCameraBase = {
    camera_view_point: toPoint(sceneToIfc(pos, offset)),
    camera_direction: toPoint(sceneDirToIfc(dir)),
    camera_up_vector: toPoint(sceneDirToIfc(up)),
    aspect_ratio: aspect,
  };
  const fov = positive(vp.camera.fov) ?? BCF_DEFAULT_FOV;
  if (vp.camera.projection === "orthographic") {
    // Older orthographic viewpoints have no scale: the height a perspective view sees at the target.
    const estimate = 2 * len(sub(vp.camera.target, pos)) * Math.tan(((fov / 2) * Math.PI) / 180);
    out.orthogonal_camera = { ...base, view_to_world_scale: positive(vp.camera.viewToWorldScale) ?? (positive(estimate) || 10) };
  } else {
    out.perspective_camera = { ...base, field_of_view: fov };
  }

  const components: BcfComponents = {};
  if (vp.selection?.length) components.selection = vp.selection.map((g) => ({ ifc_guid: g }));
  const vis = vp.visibility;
  components.visibility = {
    default_visibility: vis ? vis.defaultVisible : true,
    exceptions: (vis?.exceptions ?? []).map((g) => ({ ifc_guid: g })),
    view_setup_hints: {
      spaces_visible: !!vis?.spacesVisible,
      space_boundaries_visible: !!vis?.spaceBoundariesVisible,
      openings_visible: !!vis?.openingsVisible,
    },
  };
  const coloring = (vp.coloring ?? []).filter((c) => c.guids.length && normalizeBcfColor(c.color));
  if (coloring.length) {
    components.coloring = coloring.map((c) => ({ color: normalizeBcfColor(c.color)!, components: c.guids.map((g) => ({ ifc_guid: g })) }));
  }
  out.components = components;

  const planes = sectionsToPlanes(vp.sections);
  if (planes.length) {
    out.clipping_planes = planes.map((p) => ({
      location: toPoint(sceneToIfc(p.origin, offset)),
      direction: toPoint(sceneDirToIfc(scale(p.normal, -1))),
    }));
  }

  const lines: [Vec3, Vec3][] = [...(vp.lines ?? [])];
  for (const m of vp.measurements ?? []) {
    if (m.kind === "length") lines.push([m.points[0], m.points[1]]);
    else if (m.kind === "angle") lines.push([m.points[0], m.points[1]], [m.points[1], m.points[2]]);
    else if (m.kind === "area") m.points.forEach((p, i) => lines.push([p, m.points[(i + 1) % m.points.length]!]));
  }
  if (o.pin && finite(o.pin)) lines.push([o.pin, o.pin]);
  if (lines.length) {
    out.lines = lines.map(([a, b]) => ({ start_point: toPoint(sceneToIfc(a, offset)), end_point: toPoint(sceneToIfc(b, offset)) }));
  }
  return out;
}

export interface BcfToViewpointOptions {
  /** Model versions the topic's header files were matched to (loaded when the viewpoint opens). */
  fileVersionIds: string[];
  /** Snapshot as a data URL. */
  snapshot?: string;
  /** Orbit target distance (default BCF_TARGET_DISTANCE). */
  targetDistance?: number;
}

/**
 * BCF viewpoint → our viewpoint in the IFC frame (sceneOffset [0, 0, 0]); the viewer moves it into
 * its own frame (rebaseViewpoint). A viewpoint without a camera becomes `snapshotOnly`.
 */
export function bcfToViewpoint(v: BcfViewpoint, o: BcfToViewpointOptions): IssueViewpoint {
  const cam = v.perspective_camera ?? v.orthogonal_camera ?? null;
  const out: IssueViewpoint = {
    guid: v.guid,
    camera: { position: [0, 0, 0], target: [0, 0, -1], projection: "perspective" },
    sceneOffset: [0, 0, 0],
    fileVersionIds: o.fileVersionIds,
    ...(o.snapshot && { snapshot: o.snapshot }),
  };
  const position = cam && fromPoint(cam.camera_view_point);
  if (!cam || !position) {
    out.snapshotOnly = true;
    return out;
  }
  const pos = ifcToScene(position);
  const rawDir = fromPoint(cam.camera_direction);
  const dir = (rawDir && normalize(ifcDirToScene(rawDir))) ?? [0, 0, -1];
  const rawUp = fromPoint(cam.camera_up_vector);
  const up = rawUp ? normalize(ifcDirToScene(rawUp)) : null;
  out.camera = {
    position: pos,
    target: add(pos, scale(dir, o.targetDistance ?? BCF_TARGET_DISTANCE)),
    projection: v.orthogonal_camera && !v.perspective_camera ? "orthographic" : "perspective",
    ...(up && { up }),
  };
  const aspect = positive(cam.aspect_ratio);
  if (aspect) out.camera.aspect = aspect;
  if (v.perspective_camera) {
    const fov = positive(v.perspective_camera.field_of_view);
    if (fov && fov < 180) out.camera.fov = fov;
  } else if (v.orthogonal_camera) {
    const s = positive(v.orthogonal_camera.view_to_world_scale);
    if (s) out.camera.viewToWorldScale = s;
  }

  const c = v.components;
  const selection = guidsOf(c?.selection);
  if (selection.length) out.selection = selection;
  if (c?.visibility) {
    const exceptions = guidsOf(c.visibility.exceptions);
    let defaultVisible = c.visibility.default_visibility !== false;
    // "Hide everything, show nothing" is never meant: treat it as no visibility information.
    if (!defaultVisible && !exceptions.length) defaultVisible = true;
    const hints = c.visibility.view_setup_hints;
    if (!defaultVisible || exceptions.length || hints?.spaces_visible || hints?.openings_visible || hints?.space_boundaries_visible) {
      const vis: ViewpointVisibility = { defaultVisible, exceptions };
      if (hints?.spaces_visible) vis.spacesVisible = true;
      if (hints?.space_boundaries_visible) vis.spaceBoundariesVisible = true;
      if (hints?.openings_visible) vis.openingsVisible = true;
      out.visibility = vis;
    }
  }
  const coloring: ViewpointColoring[] = [];
  for (const col of c?.coloring ?? []) {
    const color = normalizeBcfColor(col.color);
    const guids = guidsOf(col.components);
    if (color && guids.length) coloring.push({ color, guids });
  }
  if (coloring.length) out.coloring = coloring;

  const planes: ViewpointSectionPlane[] = [];
  for (const p of v.clipping_planes ?? []) {
    const loc = fromPoint(p.location);
    const d = fromPoint(p.direction);
    const n = d && normalize(scale(ifcDirToScene(d), -1));
    if (loc && n) planes.push({ origin: ifcToScene(loc), normal: n });
  }
  if (planes.length) out.sections = planesToSections(planes);

  const lines: [Vec3, Vec3][] = [];
  for (const l of v.lines ?? []) {
    const a = fromPoint(l.start_point);
    const b = fromPoint(l.end_point);
    if (a && b) lines.push([ifcToScene(a), ifcToScene(b)]);
  }
  if (lines.length) out.lines = lines;
  return out;
}

function positive(n: number | null | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function guidsOf(list: BcfComponent[] | undefined): string[] {
  const out: string[] = [];
  for (const c of list ?? []) {
    const g = c.ifc_guid?.trim();
    if (g) out.push(g);
  }
  return out;
}

/** IFC GlobalId (22 characters of the IFC base-64 alphabet). */
export function isIfcGuid(s: string): boolean {
  return /^[0-9A-Za-z_$]{22}$/.test(s);
}

/** "#ff0000", "FF0000", "80FF0000" → "FF0000" / "80FF0000"; anything else → null. */
export function normalizeBcfColor(c: string | null | undefined): string | null {
  const s = (c ?? "").trim().replace(/^#/, "").toUpperCase();
  return /^([0-9A-F]{6}|[0-9A-F]{8})$/.test(s) ? s : null;
}

/** Section planes (enabled ones) and the box as six inward planes, all in the three.js convention. */
export function sectionsToPlanes(s: ViewpointSections | undefined): { origin: Vec3; normal: Vec3 }[] {
  const out: { origin: Vec3; normal: Vec3 }[] = [];
  for (const p of s?.planes ?? []) {
    const n = p.enabled === false ? null : normalize(p.normal);
    if (n && finite(p.origin)) out.push({ origin: p.origin, normal: n });
  }
  const box = s?.box;
  if (box) {
    const { min, max } = box;
    out.push(
      { origin: min, normal: [1, 0, 0] },
      { origin: max, normal: [-1, 0, 0] },
      { origin: min, normal: [0, 1, 0] },
      { origin: max, normal: [0, -1, 0] },
      { origin: min, normal: [0, 0, 1] },
      { origin: max, normal: [0, 0, -1] },
    );
  }
  return out;
}

/**
 * Planes → sections: when the last six planes are axis-aligned, one per axis and side, facing
 * inwards and enclosing a non-empty box, they become the section box (our exports and Solibri
 * write boxes that way).
 */
export function planesToSections(planes: ViewpointSectionPlane[]): ViewpointSections {
  if (planes.length >= 6) {
    const tail = planes.slice(-6);
    const min: (number | null)[] = [null, null, null];
    const max: (number | null)[] = [null, null, null];
    let ok = true;
    for (const p of tail) {
      const axis = p.normal.findIndex((c) => Math.abs(c) > 0.9999);
      if (axis < 0) {
        ok = false;
        break;
      }
      const slot = p.normal[axis]! > 0 ? min : max;
      if (slot[axis] !== null) {
        ok = false;
        break;
      }
      slot[axis] = p.origin[axis]!;
    }
    if (ok && [0, 1, 2].every((a) => min[a] !== null && max[a] !== null && min[a]! < max[a]!)) {
      return { planes: planes.slice(0, -6), box: { min: min as Vec3, max: max as Vec3 } };
    }
  }
  return { planes };
}

// ------------------------------------------------------------------ topic fields

export const BCF_STATUS_OUT: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  in_review: "Resolved",
  closed: "Closed",
};

export const BCF_PRIORITY_OUT: Record<IssuePriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
};

/** Topic type written for issues without a type (BCF 3.0 requires one). */
export const BCF_DEFAULT_TYPE = "Issue";

const key = (s: string) =>
  s
    .toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

const STATUS_IN: Record<string, IssueStatus> = {};
for (const [k, words] of Object.entries({
  open: ["open", "new", "active", "reopened", "reopen", "assigned", "todo", "açık", "acik", "yeni"], // i18n-ok: words matching Turkish BCF input
  in_progress: ["inprogress", "inwork", "working", "ongoing", "pending", "started", "devamediyor"],
  in_review: ["resolved", "solved", "done", "fixed", "review", "inreview", "readyforreview", "answered", "incelemede", "çözüldü", "cozuldu"], // i18n-ok: words matching Turkish BCF input
  closed: ["closed", "close", "completed", "complete", "rejected", "cancelled", "canceled", "void", "duplicate", "archived", "kapalı", "kapali"], // i18n-ok: words matching Turkish BCF input
} as Record<IssueStatus, string[]>)) {
  for (const w of words) STATUS_IN[key(w)] = k as IssueStatus;
}

/** Our status for a BCF topic status (unknown values → open). */
export function suggestIssueStatus(bcf: string | null | undefined): IssueStatus {
  return STATUS_IN[key(bcf ?? "")] ?? "open";
}

const PRIORITY_IN: Record<string, IssuePriority> = {};
for (const [k, words] of Object.entries({
  critical: ["critical", "blocker", "urgent", "highest", "kritik", "acil"],
  high: ["high", "major", "important", "yüksek", "yuksek"], // i18n-ok: words matching Turkish BCF input
  normal: ["normal", "medium", "moderate", "default", "orta"],
  low: ["low", "minor", "lowest", "trivial", "düşük", "dusuk"], // i18n-ok: words matching Turkish BCF input
} as Record<IssuePriority, string[]>)) {
  for (const w of words) PRIORITY_IN[key(w)] = k as IssuePriority;
}

/** Our priority for a BCF priority (unknown or missing → normal). */
export function suggestIssuePriority(bcf: string | null | undefined): IssuePriority {
  return PRIORITY_IN[key(bcf ?? "")] ?? "normal";
}

/** "2026-10-15" → BCF dateTime (noon UTC, so the day survives any time zone). */
export function dueDateToBcf(d: string | null | undefined): string | null {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : null;
}

/** BCF dateTime → "YYYY-MM-DD" as written in the file (its own time zone). */
export function dueDateFromBcf(d: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(d?.trim() ?? "");
  return m ? m[1]! : null;
}

/** RFC 4122 form, lower case (BCF 3.0 requires lower case GUIDs). */
export function isBcfGuid(s: string | null | undefined): boolean {
  return !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ------------------------------------------------------------------ import preview / mapping (REST + web + MCP)

export type BcfImportState = "new" | "update" | "unchanged" | "conflict";

export const BCF_IMPORT_STATE_LABELS_TR: Record<BcfImportState, string> = {
  new: "Yeni",
  update: "Güncellenecek",
  unchanged: "Değişiklik Yok",
  conflict: "Uyuşmazlık",
};

export interface BcfImportTopicPreview {
  guid: string;
  title: string;
  topicStatus: string;
  topicType: string;
  priority: string | null;
  assignedTo: string | null;
  state: BcfImportState;
  existingIssueId?: string;
  existingNumber?: number;
  /** The caller may not change this existing issue (only new comments and viewpoints are added). */
  readOnly?: boolean;
  comments: number;
  viewpoints: number;
  snapshots: number;
  warnings: string[];
}

export interface BcfImportPreview {
  version: string;
  fileName?: string;
  projectName?: string | null;
  topics: BcfImportTopicPreview[];
  /** Distinct BCF values with a suggested mapping. */
  statuses: { value: string; count: number; suggested: IssueStatus }[];
  types: { value: string; count: number; suggested: string | null }[];
  priorities: { value: string; count: number; suggested: IssuePriority }[];
  /** E-mail addresses (authors, assignees, comment authors); null = no matching project member. */
  users: { email: string; count: number; suggestedUserId: string | null; name?: string | null }[];
  /** Header files; key = reference / IfcProject / file name. */
  files: { key: string; filename: string | null; ifcProject: string | null; count: number; suggestedVersionId: string | null; label?: string | null }[];
  warnings: string[];
}

export interface BcfImportMapping {
  statuses?: Record<string, IssueStatus>;
  /** BCF type → our type text (null = no type). */
  types?: Record<string, string | null>;
  priorities?: Record<string, IssuePriority>;
  /** E-mail (lower case) → project member id, or null for "eşleşmeyen". */
  users?: Record<string, string | null>;
  /** Header file key → file version id (null = not linked). */
  files?: Record<string, string | null>;
  /** Existing topics changed both here and in the file: keep ours (default) or take the file's. */
  conflicts?: "keep" | "overwrite";
  /** Import only these topic GUIDs (default: all). */
  topics?: string[];
}

export interface BcfImportResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  comments: number;
  viewpoints: number;
  issues: { guid: string; issueId: string; number: number; state: BcfImportState | "skipped" }[];
  warnings: string[];
}

export interface BcfExportInfo {
  fileName: string;
  version: BcfVersion;
  topics: number;
  size: number;
  /** GET link (same session or token) that downloads the file. */
  downloadUrl: string;
  /** The .bcfzip as base64 when it is small enough to inline. */
  base64?: string;
  warnings: string[];
}
