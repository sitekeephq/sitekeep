/**
 * BCF-XML 2.1 / 3.0 ↔ BCF API 3.0 JSON shapes (packages/shared/src/bcf.ts).
 *
 * The writer follows the element order and cardinalities of the official XSDs (vendored in
 * apps/server/test/fixtures/bcf-xsd, checked by test/bcf.test.ts). The reader is tolerant: it reads
 * both layouts whatever bcf.version says, because real files mix them (2.0 / 2.1 / 3.0 exporters).
 */
import { createHash } from "node:crypto";
import {
  isBcfGuid,
  isIfcGuid,
  normalizeBcfColor,
  type BcfComment,
  type BcfComponent,
  type BcfComponents,
  type BcfDocumentReference,
  type BcfFileRef,
  type BcfPoint,
  type BcfTopic,
  type BcfVersion,
  type BcfViewpoint,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, msg, tFor } from "../i18n/index.js";
import { BcfFormatError, attr, bool, dbl, el, kid, kids, num, parseBcfXml, render, text, tx, type El, type XmlNode } from "./xml.js";

// ------------------------------------------------------------------ writer

const SCHEMA_30 = "https://raw.githubusercontent.com/buildingSMART/BCF-XML/release_3_0/Schemas/";

export function writeVersion(v: BcfVersion): string {
  if (v === "3.0") return render(el("Version", { VersionId: "3.0" }), `${SCHEMA_30}version.xsd`);
  return render(el("Version", { VersionId: "2.1" }, [tx("DetailedVersion", "2.1")]), "version.xsd");
}

export function writeProject(v: BcfVersion, p: { id: string; name: string }): string {
  if (v === "3.0") return render(el("ProjectInfo", {}, [el("Project", { ProjectId: p.id }, [tx("Name", nonBlank(p.name))])]), `${SCHEMA_30}project.xsd`);
  // 2.1 requires ExtensionSchema; an empty URI means "no extension schema".
  return render(el("ProjectExtension", {}, [el("Project", { ProjectId: p.id }, [tx("Name", nonBlank(p.name))]), { name: "ExtensionSchema", text: "" }]), "project.xsd");
}

export interface BcfExtensions {
  topicTypes: string[];
  topicStatuses: string[];
  priorities: string[];
  labels: string[];
  users: string[];
  stages: string[];
}

/** extensions.xml (BCF 3.0): the values this project uses. */
export function writeExtensions(e: BcfExtensions): string {
  const list = (outer: string, inner: string, values: string[]) => el(outer, {}, uniq(values).map((v) => tx(inner, v)));
  return render(
    el("Extensions", {}, [
      list("TopicTypes", "TopicType", e.topicTypes),
      list("TopicStatuses", "TopicStatus", e.topicStatuses),
      list("Priorities", "Priority", e.priorities),
      list("TopicLabels", "TopicLabel", e.labels),
      list("Users", "User", e.users),
      el("SnippetTypes"),
      list("Stages", "Stage", e.stages),
    ]),
    `${SCHEMA_30}extensions.xsd`,
  );
}

/** A viewpoint entry of markup.bcf: file names inside the topic folder. */
export interface ViewpointEntry {
  guid: string;
  viewpoint?: string;
  snapshot?: string;
  index?: number;
}

export function writeMarkup(
  v: BcfVersion,
  b: { topic: BcfTopic; files: BcfFileRef[]; comments: BcfComment[] },
  viewpoints: ViewpointEntry[],
): string {
  const t = b.topic;
  const v3 = v === "3.0";
  const file = (f: BcfFileRef): El =>
    el(
      "File",
      {
        IfcProject: f.ifc_project && isIfcGuid(f.ifc_project) ? f.ifc_project : undefined,
        IfcSpatialStructureElement: f.ifc_spatial_structure_element && isIfcGuid(f.ifc_spatial_structure_element) ? f.ifc_spatial_structure_element : undefined,
        [v3 ? "IsExternal" : "isExternal"]: f.is_external === false ? "false" : "true",
      },
      [tx("Filename", nonBlank(f.filename)), tx("Date", dateTime(f.date)), tx("Reference", nonBlank(f.reference))],
    );
  const header = b.files.length ? el("Header", {}, v3 ? [el("Files", {}, b.files.map(file))] : b.files.map(file)) : null;

  const comment = (c: BcfComment): El =>
    el("Comment", { Guid: c.guid.toLowerCase() }, [
      tx("Date", dateTime(c.date) ?? new Date(0).toISOString()),
      tx("Author", nonBlank(c.author) ?? "bilinmiyor"),
      // 2.1 requires the element (may be empty); 3.0 forbids blank text but allows leaving it out.
      v3 ? tx("Comment", nonBlank(c.comment)) : { name: "Comment", text: c.comment ?? "" },
      c.viewpoint_guid && isBcfGuid(c.viewpoint_guid) ? el("Viewpoint", { Guid: c.viewpoint_guid.toLowerCase() }) : null,
      tx("ModifiedDate", dateTime(c.modified_date)),
      tx("ModifiedAuthor", nonBlank(c.modified_author)),
    ]);
  const vpEntry = (e: ViewpointEntry): El =>
    el(v3 ? "ViewPoint" : "Viewpoints", { Guid: e.guid.toLowerCase() }, [tx("Viewpoint", e.viewpoint), tx("Snapshot", e.snapshot), tx("Index", e.index)]);

  const labels = uniq(t.labels.map((l) => nonBlank(l)).filter((l): l is string => !!l));
  const links = t.reference_links.map((l) => nonBlank(l)).filter((l): l is string => !!l);
  const related = uniq(t.related_topics.map((r) => r.related_topic_guid.toLowerCase()).filter((g) => isBcfGuid(g)));
  const docs = (t.document_references ?? []).filter((d) => nonBlank(d.url));

  const topicChildren: El["children"] = [
    ...(v3 ? [links.length ? el("ReferenceLinks", {}, links.map((l) => tx("ReferenceLink", l))) : null] : links.map((l) => tx("ReferenceLink", l))),
    tx("Title", nonBlank(t.title) ?? "(başlıksız)"), // i18n-ok: BCF data written to the file
    tx("Priority", nonBlank(t.priority)),
    ...(v3 ? [labels.length ? el("Labels", {}, labels.map((l) => tx("Label", l))) : null] : labels.map((l) => tx("Labels", l))),
    tx("CreationDate", dateTime(t.creation_date) ?? new Date(0).toISOString()),
    tx("CreationAuthor", nonBlank(t.creation_author) ?? "bilinmiyor"),
    tx("ModifiedDate", dateTime(t.modified_date)),
    tx("ModifiedAuthor", nonBlank(t.modified_author)),
    tx("DueDate", dateTime(t.due_date)),
    tx("AssignedTo", nonBlank(t.assigned_to)),
    tx("Stage", nonBlank(t.stage)),
    tx("Description", nonBlank(t.description)),
    ...(v3
      ? [docs.length ? el("DocumentReferences", {}, docs.map((d) => el("DocumentReference", { Guid: docGuid(d) }, [tx("Url", d.url!.trim()), tx("Description", nonBlank(d.description))]))) : null]
      : docs.map((d) => el("DocumentReference", { Guid: docGuid(d), isExternal: "true" }, [tx("ReferencedDocument", d.url!.trim()), tx("Description", nonBlank(d.description))]))),
    ...(v3 ? [related.length ? el("RelatedTopics", {}, related.map((g) => el("RelatedTopic", { Guid: g }))) : null] : related.map((g) => el("RelatedTopic", { Guid: g }))),
    ...(v3
      ? [b.comments.length ? el("Comments", {}, b.comments.map(comment)) : null, viewpoints.length ? el("Viewpoints", {}, viewpoints.map(vpEntry)) : null]
      : []),
  ];
  const topic = el(
    "Topic",
    {
      Guid: t.guid.toLowerCase(),
      ...(v3 && { ServerAssignedId: nonBlank(t.server_assigned_id) ?? undefined }),
      TopicType: nonBlank(t.topic_type) ?? "Issue",
      TopicStatus: nonBlank(t.topic_status) ?? "Open",
    },
    topicChildren,
  );
  const markup = el("Markup", {}, [header, topic, ...(v3 ? [] : [...b.comments.map(comment), ...viewpoints.map(vpEntry)])]);
  return render(markup, v3 ? `${SCHEMA_30}markup.xsd` : "markup.xsd");
}

/** viewpoint.bcfv; the viewpoint must have a camera (callers skip snapshot-only viewpoints). */
export function writeVisinfo(v: BcfVersion, vp: BcfViewpoint): string {
  const v3 = v === "3.0";
  const point = (name: string, p: BcfPoint): El => el(name, {}, [tx("X", dbl(p.x)), tx("Y", dbl(p.y)), tx("Z", dbl(p.z))]);
  const component = (c: BcfComponent): El | null =>
    c.ifc_guid && isIfcGuid(c.ifc_guid)
      ? el("Component", { IfcGuid: c.ifc_guid }, [tx("OriginatingSystem", nonBlank(c.originating_system)), tx("AuthoringToolId", nonBlank(c.authoring_tool_id))])
      : null;
  const comps = (list: BcfComponent[] | undefined) => (list ?? []).map(component).filter((c): c is El => !!c);

  const c: BcfComponents = vp.components ?? {};
  const hints = c.visibility?.view_setup_hints;
  const hintsEl = el("ViewSetupHints", {
    SpacesVisible: String(!!hints?.spaces_visible),
    SpaceBoundariesVisible: String(!!hints?.space_boundaries_visible),
    OpeningsVisible: String(!!hints?.openings_visible),
  });
  const selection = comps(c.selection);
  const exceptions = comps(c.visibility?.exceptions);
  const colors = (c.coloring ?? [])
    .map((col) => ({ color: normalizeBcfColor(col.color), list: comps(col.components) }))
    .filter((col) => col.color && col.list.length);
  const visibility = el("Visibility", { DefaultVisibility: String(c.visibility ? c.visibility.default_visibility : true) }, [
    v3 ? hintsEl : null,
    exceptions.length ? el("Exceptions", {}, exceptions) : null,
  ]);
  const components = el("Components", {}, [
    v3 ? null : hintsEl,
    selection.length ? el("Selection", {}, selection) : null,
    visibility,
    colors.length
      ? el(
          "Coloring",
          {},
          colors.map((col) => el("Color", { Color: col.color! }, v3 ? [el("Components", {}, col.list)] : col.list)),
        )
      : null,
  ]);

  let camera: El;
  if (vp.orthogonal_camera) {
    const o = vp.orthogonal_camera;
    camera = el("OrthogonalCamera", {}, [
      point("CameraViewPoint", o.camera_view_point),
      point("CameraDirection", o.camera_direction),
      point("CameraUpVector", o.camera_up_vector),
      tx("ViewToWorldScale", dbl(o.view_to_world_scale)),
      v3 ? tx("AspectRatio", dbl(positiveOr(o.aspect_ratio, 16 / 9))) : null,
    ]);
  } else if (vp.perspective_camera) {
    const p = vp.perspective_camera;
    // 2.1 limits the field of view to 45–60°; 3.0 to (0, 180).
    const fov = v3 ? Math.min(179, Math.max(1, p.field_of_view)) : Math.min(60, Math.max(45, p.field_of_view));
    camera = el("PerspectiveCamera", {}, [
      point("CameraViewPoint", p.camera_view_point),
      point("CameraDirection", p.camera_direction),
      point("CameraUpVector", p.camera_up_vector),
      tx("FieldOfView", dbl(fov)),
      v3 ? tx("AspectRatio", dbl(positiveOr(p.aspect_ratio, 16 / 9))) : null,
    ]);
  } else {
    throw new Error("Kamerasız görünüm için viewpoint.bcfv yazılmaz."); // i18n-ok: internal guard (callers never reach it), log only
  }

  const lines = vp.lines ?? [];
  const planes = vp.clipping_planes ?? [];
  return render(
    el("VisualizationInfo", { Guid: vp.guid.toLowerCase() }, [
      components,
      camera,
      lines.length ? el("Lines", {}, lines.map((l) => el("Line", {}, [point("StartPoint", l.start_point), point("EndPoint", l.end_point)]))) : null,
      planes.length ? el("ClippingPlanes", {}, planes.map((p) => el("ClippingPlane", {}, [point("Location", p.location), point("Direction", p.direction)]))) : null,
    ]),
    v3 ? `${SCHEMA_30}visinfo.xsd` : "visinfo.xsd",
  );
}

function nonBlank(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

function positiveOr(n: number | undefined, d: number) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : d;
}

/** xs:dateTime from an ISO string; null when missing or unreadable. */
function dateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function docGuid(d: BcfDocumentReference): string {
  return d.guid && isBcfGuid(d.guid) ? d.guid.toLowerCase() : guidFrom(`doc:${d.url ?? ""}`);
}

/** Deterministic RFC 4122 (v5-style) GUID from any text. */
export function guidFrom(seed: string): string {
  const h = sha1Hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function sha1Hex(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

// ------------------------------------------------------------------ reader

export interface ParsedMarkup {
  topic: BcfTopic;
  files: BcfFileRef[];
  comments: BcfComment[];
  viewpoints: ViewpointEntry[];
  warnings: string[];
}

export function readVersion(buf: Buffer): string {
  const root = parseBcfXml(buf, "bcf.version");
  if (root.name !== "Version") throw new BcfFormatError(msg("bcf:xml.noVersion"));
  return attr(root, "VersionId") ?? text(root, "DetailedVersion") ?? "";
}

export function readProject(buf: Buffer): { projectId: string | null; name: string | null } {
  const root = parseBcfXml(buf, "project.bcfp");
  const p = kid(root, "Project");
  return { projectId: attr(p, "ProjectId"), name: text(p, "Name") };
}

/** Warnings come back in `lang` (the importer's language). */
export function readMarkup(buf: Buffer, where: string, lang = DEFAULT_LANGUAGE): ParsedMarkup {
  const tr = tFor(lang);
  const root = parseBcfXml(buf, where);
  if (root.name !== "Markup") throw new BcfFormatError(msg("bcf:xml.noMarkup", { where }));
  const warnings: string[] = [];
  const t = kid(root, "Topic");
  if (!t) throw new BcfFormatError(msg("bcf:xml.noTopic", { where }));
  const guid = attr(t, "Guid");
  if (!guid) throw new BcfFormatError(msg("bcf:xml.noTopicGuid", { where }));

  const header = kid(root, "Header");
  const fileNodes = [...kids(header, "File"), ...kids(kid(header, "Files"), "File")];
  const files: BcfFileRef[] = fileNodes.map((f) => ({
    ifc_project: attr(f, "IfcProject"),
    ifc_spatial_structure_element: attr(f, "IfcSpatialStructureElement"),
    filename: text(f, "Filename"),
    date: text(f, "Date"),
    reference: text(f, "Reference"),
    is_external: bool(attr(f, "IsExternal")) ?? true,
  }));

  const labels = [...kids(t, "Labels").map((l) => l.text.trim()), ...kids(kid(t, "Labels"), "Label").map((l) => l.text.trim())].filter(Boolean);
  const links = [...kids(t, "ReferenceLink"), ...kids(kid(t, "ReferenceLinks"), "ReferenceLink")].map((l) => l.text.trim()).filter(Boolean);
  const related = [...kids(t, "RelatedTopic"), ...kids(kid(t, "RelatedTopics"), "RelatedTopic")]
    .map((r) => attr(r, "Guid"))
    .filter((g): g is string => !!g)
    .map((g) => ({ related_topic_guid: g.toLowerCase() }));
  const docs: BcfDocumentReference[] = [...kids(t, "DocumentReference"), ...kids(kid(t, "DocumentReferences"), "DocumentReference")].map((d) => {
    const url = text(d, "Url") ?? text(d, "ReferencedDocument");
    return {
      guid: attr(d, "Guid") ?? undefined,
      url,
      document_guid: text(d, "DocumentGuid"),
      description: text(d, "Description"),
    };
  });
  if (kid(t, "BimSnippet")) warnings.push(tr("bcf:warnings.bimSnippet"));

  const topic: BcfTopic = {
    guid,
    server_assigned_id: attr(t, "ServerAssignedId"),
    topic_type: attr(t, "TopicType") ?? "",
    topic_status: attr(t, "TopicStatus") ?? "",
    title: text(t, "Title") ?? "",
    priority: text(t, "Priority"),
    index: num(t, "Index"),
    labels,
    creation_date: text(t, "CreationDate") ?? "",
    creation_author: text(t, "CreationAuthor") ?? "",
    modified_date: text(t, "ModifiedDate"),
    modified_author: text(t, "ModifiedAuthor"),
    due_date: text(t, "DueDate"),
    assigned_to: text(t, "AssignedTo"),
    stage: text(t, "Stage"),
    description: kid(t, "Description")?.text.trim() || null,
    reference_links: links,
    related_topics: related,
    document_references: docs,
  };

  const commentNodes = [...kids(root, "Comment"), ...kids(kid(t, "Comments"), "Comment")];
  const comments: BcfComment[] = [];
  for (const c of commentNodes) {
    const cg = attr(c, "Guid");
    if (!cg) {
      warnings.push(tr("bcf:warnings.commentNoGuid"));
      continue;
    }
    comments.push({
      guid: cg,
      date: text(c, "Date") ?? "",
      author: text(c, "Author") ?? "",
      comment: kid(c, "Comment")?.text.trim() ?? "",
      viewpoint_guid: attr(kid(c, "Viewpoint"), "Guid"),
      modified_date: text(c, "ModifiedDate"),
      modified_author: text(c, "ModifiedAuthor"),
    });
  }

  // 2.1: <Viewpoints Guid> at the root; 3.0: <Topic><Viewpoints><ViewPoint Guid>.
  const vpNodes = [...kids(root, "Viewpoints").filter((n) => attr(n, "Guid")), ...kids(kid(t, "Viewpoints"), "ViewPoint")];
  const viewpoints: ViewpointEntry[] = [];
  for (const n of vpNodes) {
    const vg = attr(n, "Guid");
    if (!vg) continue;
    viewpoints.push({ guid: vg, viewpoint: text(n, "Viewpoint") ?? undefined, snapshot: text(n, "Snapshot") ?? undefined, index: num(n, "Index") ?? undefined });
  }
  return { topic, files, comments, viewpoints, warnings };
}

export function readVisinfo(buf: Buffer, where: string, lang = DEFAULT_LANGUAGE): { viewpoint: BcfViewpoint; warnings: string[] } {
  const tr = tFor(lang);
  const root = parseBcfXml(buf, where);
  if (root.name !== "VisualizationInfo") throw new BcfFormatError(msg("bcf:xml.noVisinfo", { where }));
  const warnings: string[] = [];
  const point = (n: XmlNode | undefined): BcfPoint | null => {
    const x = num(n, "X");
    const y = num(n, "Y");
    const z = num(n, "Z");
    return x === null || y === null || z === null ? null : { x, y, z };
  };
  const component = (n: XmlNode): BcfComponent => ({
    ifc_guid: attr(n, "IfcGuid"),
    originating_system: text(n, "OriginatingSystem"),
    authoring_tool_id: text(n, "AuthoringToolId"),
  });
  const vp: BcfViewpoint = { guid: attr(root, "Guid") ?? "" };

  const comps = kid(root, "Components");
  if (comps) {
    const out: BcfComponents = {};
    const sel = kids(kid(comps, "Selection"), "Component").map(component);
    if (sel.length) out.selection = sel;
    const vis = kid(comps, "Visibility");
    const hintsNode = kid(vis, "ViewSetupHints") ?? kid(comps, "ViewSetupHints");
    if (vis || hintsNode) {
      out.visibility = {
        default_visibility: bool(attr(vis, "DefaultVisibility")) ?? false,
        exceptions: kids(kid(vis, "Exceptions"), "Component").map(component),
        ...(hintsNode && {
          view_setup_hints: {
            spaces_visible: bool(attr(hintsNode, "SpacesVisible")) ?? false,
            space_boundaries_visible: bool(attr(hintsNode, "SpaceBoundariesVisible")) ?? false,
            openings_visible: bool(attr(hintsNode, "OpeningsVisible")) ?? false,
          },
        }),
      };
    }
    const colors = kids(kid(comps, "Coloring"), "Color")
      .map((c) => ({
        color: attr(c, "Color") ?? "",
        components: [...kids(c, "Component"), ...kids(kid(c, "Components"), "Component")].map(component),
      }))
      .filter((c) => c.components.length);
    if (colors.length) out.coloring = colors;
    vp.components = out;
  }

  const cameraOf = (n: XmlNode | undefined) => {
    const pos = point(kid(n, "CameraViewPoint"));
    const dir = point(kid(n, "CameraDirection"));
    if (!n || !pos || !dir) return null;
    const up = point(kid(n, "CameraUpVector")) ?? { x: 0, y: 0, z: 1 };
    const aspect = num(n, "AspectRatio");
    return { camera_view_point: pos, camera_direction: dir, camera_up_vector: up, ...(aspect !== null && { aspect_ratio: aspect }) };
  };
  const persp = kid(root, "PerspectiveCamera");
  const ortho = kid(root, "OrthogonalCamera");
  const pc = cameraOf(persp);
  const oc = cameraOf(ortho);
  if (pc) vp.perspective_camera = { ...pc, field_of_view: num(persp, "FieldOfView") ?? 60 };
  else if (oc) vp.orthogonal_camera = { ...oc, view_to_world_scale: num(ortho, "ViewToWorldScale") ?? 10 };
  else if (persp || ortho) warnings.push(tr("bcf:warnings.cameraUnreadable", { where }));

  const lines = kids(kid(root, "Lines"), "Line")
    .map((l) => ({ start_point: point(kid(l, "StartPoint")), end_point: point(kid(l, "EndPoint")) }))
    .filter((l): l is { start_point: BcfPoint; end_point: BcfPoint } => !!l.start_point && !!l.end_point);
  if (lines.length) vp.lines = lines;
  const planes = kids(kid(root, "ClippingPlanes"), "ClippingPlane")
    .map((p) => ({ location: point(kid(p, "Location")), direction: point(kid(p, "Direction")) }))
    .filter((p): p is { location: BcfPoint; direction: BcfPoint } => !!p.location && !!p.direction);
  if (planes.length) vp.clipping_planes = planes;
  if (kids(root, "Bitmap").length || kids(kid(root, "Bitmaps"), "Bitmap").length) warnings.push(tr("bcf:warnings.bitmaps"));
  return { viewpoint: vp, warnings };
}
