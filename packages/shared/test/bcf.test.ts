import { describe, expect, it } from "vitest";
import {
  BCF_IMPORT_STATE_LABELS_TR,
  bcfToViewpoint,
  defaultUp,
  dueDateFromBcf,
  dueDateToBcf,
  ifcDirToScene,
  ifcToScene,
  isBcfGuid,
  isIfcGuid,
  isTitleCaseTr,
  normalizeBcfColor,
  planesToSections,
  rebaseViewpoint,
  sceneDirToIfc,
  sceneToIfc,
  sectionsToPlanes,
  suggestIssuePriority,
  suggestIssueStatus,
  viewpointToBcf,
  type IssueViewpoint,
  type Vec3,
} from "../src/index.js";

const EPS = 1e-9;

function close(a: Vec3 | undefined, b: Vec3 | undefined, eps = EPS) {
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  for (let i = 0; i < 3; i++) expect(Math.abs(a![i]! - b![i]!), `${a} vs ${b}`).toBeLessThan(eps);
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dirOf = (vp: IssueViewpoint) => unit([0, 1, 2].map((i) => vp.camera.target[i]! - vp.camera.position[i]!) as Vec3);

describe("coordinates: IFC world (Z up) ↔ viewer scene (Y up + Fragments offset)", () => {
  it("maps axes like web-ifc: scene = (x, z, −y) + offset", () => {
    expect(ifcToScene([1, 2, 3])).toEqual([1, 3, -2]);
    expect(ifcToScene([1, 2, 3], [10, 20, 30])).toEqual([11, 23, 28]);
    expect(sceneToIfc([11, 23, 28], [10, 20, 30])).toEqual([1, 2, 3]);
    // IFC up (Z) is scene up (Y); IFC north (Y) looks into the screen (−Z).
    expect(ifcDirToScene([0, 0, 1])).toEqual([0, 1, 0]);
    expect(ifcDirToScene([0, 1, 0])).toEqual([0, 0, -1]);
    expect(sceneDirToIfc([0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("is invertible for points and directions (large site coordinates too)", () => {
    const offset: Vec3 = [-512345.25, -12.5, 4412345.75];
    for (const p of [
      [0, 0, 0],
      [512345.25, 4412345.75, 12.5],
      [-3.5, 7.25, 1e-3],
    ] as Vec3[]) {
      close(sceneToIfc(ifcToScene(p, offset), offset), p, 1e-6);
      close(ifcToScene(sceneToIfc(p, offset), offset), p, 1e-6);
      close(sceneDirToIfc(ifcDirToScene(p)), p);
    }
  });

  it("rebases a viewpoint into the viewer's frame and leaves older viewpoints alone", () => {
    const vp: IssueViewpoint = {
      camera: { position: [1, 2, 3], target: [1, 2, 0], projection: "perspective" },
      sceneOffset: [0, 0, 0],
      fileVersionIds: [],
      sections: { planes: [{ origin: [0, 1, 0], normal: [0, 1, 0] }], box: { min: [0, 0, 0], max: [1, 1, 1] } },
      lines: [[[0, 0, 0], [1, 0, 0]]],
      measurements: [{ kind: "length", points: [[0, 0, 0], [0, 0, 2]], value: 2 }],
    };
    const r = rebaseViewpoint(vp, [10, 20, 30]);
    expect(r.camera.position).toEqual([11, 22, 33]);
    expect(r.camera.target).toEqual([11, 22, 30]);
    expect(r.sections?.planes[0]?.origin).toEqual([10, 21, 30]);
    expect(r.sections?.planes[0]?.normal).toEqual([0, 1, 0]);
    expect(r.sections?.box).toEqual({ min: [10, 20, 30], max: [11, 21, 31] });
    expect(r.lines).toEqual([[[10, 20, 30], [11, 20, 30]]]);
    expect(r.measurements?.[0]).toMatchObject({ points: [[10, 20, 30], [10, 20, 32]] });
    expect(r.sceneOffset).toEqual([10, 20, 30]);
    const legacy: IssueViewpoint = { camera: vp.camera, fileVersionIds: [] };
    expect(rebaseViewpoint(legacy, [10, 20, 30])).toBe(legacy);
  });
});

describe("viewpoint ↔ BCF viewpoint", () => {
  const offset: Vec3 = [-1200.5, -3.25, 845.75];
  const position: Vec3 = [-1180.5, 12.75, 870.75];
  const target: Vec3 = [-1195.5, 1.75, 850.75];
  const dir = unit([target[0] - position[0], target[1] - position[1], target[2] - position[2]]);
  // A rolled camera: up perpendicular to the direction but not in the vertical plane.
  const right = unit([dir[1] * 0 - dir[2] * 1, dir[2] * 0 - dir[0] * 0, dir[0] * 1 - dir[1] * 0]);
  const up0 = unit([right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]]);
  const roll = 0.3;
  const up = unit([0, 1, 2].map((i) => up0[i]! * Math.cos(roll) + right[i]! * Math.sin(roll)) as Vec3);

  const original: IssueViewpoint = {
    guid: "0f8f6f5e-1111-4222-8333-944455556666",
    camera: { position, target, projection: "perspective", up, fov: 55, aspect: 1.6 },
    sceneOffset: offset,
    fileVersionIds: ["a2c1d3e4-0000-4000-8000-000000000001"],
    selection: ["3vB2YO$MX4xv5uCqZZG0A1", "1pPHnf7cXCpPsNEnQf8_A3"],
    visibility: { defaultVisible: false, exceptions: ["3vB2YO$MX4xv5uCqZZG0A1"], spacesVisible: true },
    coloring: [{ color: "FF0000", guids: ["3vB2YO$MX4xv5uCqZZG0A1"] }, { color: "8000FF00", guids: ["1pPHnf7cXCpPsNEnQf8_A3"] }],
    sections: {
      planes: [
        { origin: [-1190, 5, 860], normal: unit([0.2, 1, 0.1]) },
        { origin: [-1190, 5, 860], normal: [1, 0, 0], enabled: false },
      ],
      box: { min: [-1199, 0, 846], max: [-1185, 9, 869] },
    },
  };

  it("round-trips camera, components and clipping (our viewpoint → BCF → back) within tolerance", () => {
    const bcf = viewpointToBcf(original, { guid: original.guid!, index: 0 });
    expect(bcf.guid).toBe(original.guid);
    expect(bcf.perspective_camera?.field_of_view).toBe(55);
    expect(bcf.perspective_camera?.aspect_ratio).toBe(1.6);
    // The disabled plane is not exported; the box becomes six planes.
    expect(bcf.clipping_planes).toHaveLength(7);

    const back = rebaseViewpoint(bcfToViewpoint(bcf, { fileVersionIds: original.fileVersionIds }), offset);
    expect(back.guid).toBe(original.guid);
    expect(back.camera.projection).toBe("perspective");
    close(back.camera.position, position, 1e-6);
    close(dirOf(back), dir, 1e-9);
    close(back.camera.up, up, 1e-9);
    expect(back.camera.fov).toBe(55);
    expect(back.camera.aspect).toBe(1.6);
    expect(back.selection).toEqual(original.selection);
    expect(back.visibility).toEqual(original.visibility);
    expect(back.coloring).toEqual(original.coloring);
    expect(back.sections?.planes).toHaveLength(1);
    close(back.sections!.planes[0]!.origin, original.sections!.planes[0]!.origin, 1e-6);
    close(back.sections!.planes[0]!.normal, original.sections!.planes[0]!.normal);
    close(back.sections!.box!.min, original.sections!.box!.min, 1e-6);
    close(back.sections!.box!.max, original.sections!.box!.max, 1e-6);
    expect(back.fileVersionIds).toEqual(original.fileVersionIds);
  });

  it("round-trips an orthographic camera with its view-to-world scale", () => {
    const ortho: IssueViewpoint = {
      camera: { position: [5, 40, -5], target: [5, 0, -5.0001], projection: "orthographic", up: [0, 0, -1], viewToWorldScale: 23.5, aspect: 2 },
      sceneOffset: [0, 0, 0],
      fileVersionIds: [],
    };
    const bcf = viewpointToBcf(ortho, { guid: "a1bdeab5-bfa6-48b5-b0b3-de08f3fe7128" });
    expect(bcf.perspective_camera).toBeUndefined();
    expect(bcf.orthogonal_camera?.view_to_world_scale).toBe(23.5);
    // Looking straight down with IFC north up.
    expect(bcf.orthogonal_camera?.camera_direction.z).toBeCloseTo(-1, 6);
    expect(bcf.orthogonal_camera?.camera_up_vector.y).toBeCloseTo(1, 6);
    const back = bcfToViewpoint(bcf, { fileVersionIds: [] });
    expect(back.camera.projection).toBe("orthographic");
    expect(back.camera.viewToWorldScale).toBe(23.5);
    close(back.camera.position, ortho.camera.position, 1e-9);
    close(back.camera.up, [0, 0, -1], 1e-5);
  });

  it("writes the camera in IFC axes: the official BCF 2.1 sample camera maps back exactly", () => {
    // Test Cases/v2.1/Visualization/One part of decomposed object visible (buildingSMART BCF-XML).
    const bcf = {
      guid: "5c0b5748-1bc2-4ce7-b6cb-39e4594617f0",
      perspective_camera: {
        camera_view_point: { x: 26.00261522559086, y: -26.152546069409244, z: 20.25187937049607 },
        camera_direction: { x: -0.6658547449851194, y: 0.48425538694636966, z: -0.567568655577652 },
        camera_up_vector: { x: -0.4590141077401259, y: 0.33382664316941446, z: 0.8233260722252009 },
        field_of_view: 60,
      },
    };
    const vp = bcfToViewpoint(bcf, { fileVersionIds: [] });
    expect(vp.camera.position).toEqual([26.00261522559086, 20.25187937049607, 26.152546069409244]);
    expect(vp.sceneOffset).toEqual([0, 0, 0]);
    const again = viewpointToBcf(vp, { guid: bcf.guid });
    const p = again.perspective_camera!;
    close([p.camera_view_point.x, p.camera_view_point.y, p.camera_view_point.z], [26.00261522559086, -26.152546069409244, 20.25187937049607]);
    close([p.camera_direction.x, p.camera_direction.y, p.camera_direction.z], unit([-0.6658547449851194, 0.48425538694636966, -0.567568655577652]));
    close([p.camera_up_vector.x, p.camera_up_vector.y, p.camera_up_vector.z], unit([-0.4590141077401259, 0.33382664316941446, 0.8233260722252009]), 1e-6);
  });

  it("fills defaults for older viewpoints and uses a known model offset", () => {
    const legacy: IssueViewpoint = {
      camera: { position: [10, 10, 10], target: [0, 0, 0], projection: "perspective" },
      fileVersionIds: [],
      selection: ["3vB2YO$MX4xv5uCqZZG0A1"],
    };
    const bcf = viewpointToBcf(legacy, { guid: "6f1a0bb2-3f0e-4b8c-9f1f-1a2b3c4d5e6f", fallbackOffset: [10, 0, 0] });
    const cam = bcf.perspective_camera!;
    expect(cam.field_of_view).toBe(60);
    expect(cam.aspect_ratio).toBeCloseTo(16 / 9);
    expect(cam.camera_view_point).toEqual({ x: 0, y: -10, z: 10 });
    // No roll: the up vector leans towards IFC Z.
    expect(cam.camera_up_vector.z).toBeGreaterThan(0.5);
    expect(bcf.components?.visibility).toEqual({
      default_visibility: true,
      exceptions: [],
      view_setup_hints: { spaces_visible: false, space_boundaries_visible: false, openings_visible: false },
    });
    expect(defaultUp([0, -1, 0])).toEqual([0, 0, -1]);
  });

  it("turns measurements and the pin into lines and negates clipping directions", () => {
    const vp: IssueViewpoint = {
      camera: { position: [0, 5, 5], target: [0, 0, 0], projection: "perspective" },
      sceneOffset: [0, 0, 0],
      fileVersionIds: [],
      sections: { planes: [{ origin: [0, 2, 0], normal: [0, 1, 0] }] },
      measurements: [
        { kind: "length", points: [[0, 0, 0], [1, 0, 0]], value: 1 },
        { kind: "area", points: [[0, 0, 0], [1, 0, 0], [1, 0, -1]], value: 0.5 },
        { kind: "volume", guids: ["3vB2YO$MX4xv5uCqZZG0A1"], value: 2 },
      ],
    };
    const bcf = viewpointToBcf(vp, { guid: "6f1a0bb2-3f0e-4b8c-9f1f-1a2b3c4d5e6f", pin: [2, 0, 0] });
    // The scene plane keeps what is above Y = 2: BCF hides what is below Z = 2.
    expect(bcf.clipping_planes).toEqual([{ location: { x: 0, y: 0, z: 2 }, direction: { x: 0, y: 0, z: -1 } }]);
    expect(bcf.lines).toHaveLength(1 + 3 + 1);
    expect(bcf.lines![4]).toEqual({ start_point: { x: 2, y: 0, z: 0 }, end_point: { x: 2, y: 0, z: 0 } });
    const back = bcfToViewpoint(bcf, { fileVersionIds: [] });
    expect(back.lines).toHaveLength(5);
    expect(back.sections).toEqual({ planes: [{ origin: [0, 2, 0], normal: [0, 1, 0] }] });
  });

  it("treats a camera-less viewpoint as snapshot only and 'hide all, show nothing' as no visibility", () => {
    const vp = bcfToViewpoint({ guid: "6f1a0bb2-3f0e-4b8c-9f1f-1a2b3c4d5e6f" }, { fileVersionIds: [], snapshot: "data:image/png;base64,AA==" });
    expect(vp.snapshotOnly).toBe(true);
    expect(viewpointToBcf(vp, { guid: "6f1a0bb2-3f0e-4b8c-9f1f-1a2b3c4d5e6f" })).toEqual({ guid: "6f1a0bb2-3f0e-4b8c-9f1f-1a2b3c4d5e6f" });
    const cam = {
      camera_view_point: { x: 0, y: 0, z: 0 },
      camera_direction: { x: 1, y: 0, z: 0 },
      camera_up_vector: { x: 0, y: 0, z: 1 },
      field_of_view: 60,
    };
    const v2 = bcfToViewpoint({ guid: "x", perspective_camera: cam, components: { visibility: { default_visibility: false, exceptions: [] } } }, { fileVersionIds: [] });
    expect(v2.visibility).toBeUndefined();
  });

  it("detects a section box only from six inward axis-aligned planes", () => {
    const box = { min: [0, 0, 0] as Vec3, max: [2, 3, 4] as Vec3 };
    expect(planesToSections(sectionsToPlanes({ planes: [], box }))).toEqual({ planes: [], box });
    const skew = sectionsToPlanes({ planes: [], box });
    skew[5] = { origin: [0, 0, 4], normal: unit([0.1, 0, -1]) };
    expect(planesToSections(skew).box).toBeUndefined();
    expect(planesToSections(skew).planes).toHaveLength(6);
  });
});

describe("topic field helpers", () => {
  it("suggests our status and priority for common BCF values", () => {
    expect(suggestIssueStatus("Open")).toBe("open");
    expect(suggestIssueStatus("OPEN")).toBe("open");
    expect(suggestIssueStatus("Active")).toBe("open");
    expect(suggestIssueStatus("In Progress")).toBe("in_progress");
    expect(suggestIssueStatus("IN_PROGRESS")).toBe("in_progress");
    expect(suggestIssueStatus("Resolved")).toBe("in_review");
    expect(suggestIssueStatus("SOLVED")).toBe("in_review");
    expect(suggestIssueStatus("Closed")).toBe("closed");
    expect(suggestIssueStatus("Kapalı")).toBe("closed");
    expect(suggestIssueStatus("whatever")).toBe("open");
    expect(suggestIssuePriority("CRITICAL")).toBe("critical");
    expect(suggestIssuePriority("Major")).toBe("high");
    expect(suggestIssuePriority("MEDIUM")).toBe("normal");
    expect(suggestIssuePriority("Minor")).toBe("low");
    expect(suggestIssuePriority(null)).toBe("normal");
  });

  it("normalizes colours, GUIDs and due dates", () => {
    expect(normalizeBcfColor("#ff0000")).toBe("FF0000");
    expect(normalizeBcfColor("80ff00aa")).toBe("80FF00AA");
    expect(normalizeBcfColor("red")).toBeNull();
    expect(isIfcGuid("3vB2YO$MX4xv5uCqZZG0A1")).toBe(true);
    expect(isIfcGuid("short")).toBe(false);
    expect(isBcfGuid("793a5f9f-788e-46e4-b484-9c44d3061577")).toBe(true);
    expect(isBcfGuid("not-a-guid")).toBe(false);
    expect(dueDateToBcf("2026-10-15")).toBe("2026-10-15T12:00:00Z");
    expect(dueDateFromBcf("2026-10-15T00:00:00+03:00")).toBe("2026-10-15");
    expect(dueDateFromBcf(dueDateToBcf("2026-01-31"))).toBe("2026-01-31");
    expect(dueDateFromBcf("yarın")).toBeNull();
  });

  it("labels import states in Title Case", () => {
    expect(Object.values(BCF_IMPORT_STATE_LABELS_TR).every((l) => isTitleCaseTr(l))).toBe(true);
  });
});
