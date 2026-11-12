import type { ViewerExtension } from "../extensions/types.js";

export type Vec3 = [number, number, number];

export interface ViewerCameraState {
  position: Vec3;
  target: Vec3;
  projection: "perspective" | "orthographic";
  up?: Vec3;
  fov?: number;
  aspect?: number;
  viewToWorldScale?: number;
}

export interface IssueViewpoint {
  guid?: string;
  camera: ViewerCameraState;
  sceneOffset?: Vec3;
  fileVersionIds: string[];
  selection?: string[];
  snapshot?: string;
  sections?: ViewpointSections;
  measurements?: ViewpointMeasurement[];
  visibility?: ViewpointVisibility;
  coloring?: ViewpointColoring[];
  lines?: [Vec3, Vec3][];
  snapshotOnly?: boolean;
}

export interface ViewpointVisibility {
  defaultVisible: boolean;
  exceptions: string[];
  spacesVisible?: boolean;
  spaceBoundariesVisible?: boolean;
  openingsVisible?: boolean;
}

export interface ViewpointColoring {
  color: string;
  guids: string[];
}

export interface ViewpointSectionPlane {
  origin: Vec3;
  normal: Vec3;
  enabled?: boolean;
}

export interface ViewpointSections {
  planes: ViewpointSectionPlane[];
  box?: { min: Vec3; max: Vec3 } | null;
}

export type ViewpointMeasurement =
  | { kind: "length"; points: [Vec3, Vec3]; value: number }
  | { kind: "area"; points: Vec3[]; value: number }
  | { kind: "angle"; points: [Vec3, Vec3, Vec3]; value: number }
  | { kind: "volume"; guids: string[]; value: number };

export interface ViewRule {
  classes: string[];
  fileIds?: string[];
  action: "hide" | "color" | "isolate";
  color?: string;
  opacity?: number;
}

export interface ViewerEngineOptions {
  /**
   * Public URL of the That Open Fragments worker.
   * Copy it with `npm run copy-assets` in the consuming application.
   */
  workerUrl?: string;
  /** Show the renderer vendor wordmark. Disabled by default in product UIs. */
  showVendorLogo?: boolean;
}

export interface ViewerRuntimeOptions extends ViewerEngineOptions {
  extensions?: readonly ViewerExtension[];
}

/** Moves all viewpoint points into another Fragments scene-offset frame. */
export function rebaseViewpoint(vp: IssueViewpoint, offset: Vec3): IssueViewpoint {
  const from = vp.sceneOffset;
  if (!from) return vp;
  const delta: Vec3 = [offset[0] - from[0], offset[1] - from[1], offset[2] - from[2]];
  if (delta.every((value) => value === 0)) return vp;
  const move = (point: Vec3): Vec3 => [
    point[0] + delta[0],
    point[1] + delta[1],
    point[2] + delta[2],
  ];
  const result: IssueViewpoint = {
    ...vp,
    sceneOffset: offset,
    camera: {
      ...vp.camera,
      position: move(vp.camera.position),
      target: move(vp.camera.target),
    },
  };
  if (vp.sections) {
    result.sections = {
      planes: vp.sections.planes.map((plane) => ({
        ...plane,
        origin: move(plane.origin),
      })),
      ...(vp.sections.box !== undefined && {
        box: vp.sections.box
          ? { min: move(vp.sections.box.min), max: move(vp.sections.box.max) }
          : null,
      }),
    };
  }
  if (vp.measurements) {
    result.measurements = vp.measurements.map((measurement) =>
      measurement.kind === "volume"
        ? measurement
        : { ...measurement, points: measurement.points.map(move) } as ViewpointMeasurement,
    );
  }
  if (vp.lines) result.lines = vp.lines.map(([start, end]) => [move(start), move(end)]);
  return result;
}
