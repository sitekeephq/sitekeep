import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { SectionTool } from "../src/tools/sections";
import { compactSectionFill, compactSectionLine, compactSectionMeshes, usedSegments } from "../src/tools/section-meshes";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

/** A getSection result: the fixed 600 000-float buffer with `usedVertices` filled. */
function sectionBuffer(usedVertices: number) {
  const buffer = new Float32Array(6e5);
  for (let i = 0; i < usedVertices * 3; i++) buffer[i] = (i % 7) + 1;
  return buffer;
}

/** What ClipEdges.updateMeshes builds from it: a fat line from the whole buffer and a fill. */
function clipEdges(usedVertices: number, fillTriangles: number[] = [0, 1, 2]) {
  const buffer = sectionBuffer(usedVertices);
  const position = new THREE.BufferAttribute(buffer, 3);
  const source = new THREE.BufferGeometry().setAttribute("position", position);
  source.setDrawRange(0, usedVertices);
  const lineGeometry = new LineSegmentsGeometry().fromLineSegments(new THREE.LineSegments(source));
  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.attributes.position = position;
  fillGeometry.setIndex(fillTriangles);
  const group = new THREE.Group();
  group.add(new LineSegments2(lineGeometry, new LineMaterial()), new THREE.Mesh(fillGeometry));
  return { group, lineGeometry, fillGeometry, buffer };
}

describe("usedSegments", () => {
  it("counts segments up to the last non-zero value", () => {
    expect(usedSegments(new Float32Array(60))).toBe(0);
    expect(usedSegments(Float32Array.from([1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0]))).toBe(1);
    // A segment that starts at the origin still counts.
    expect(usedSegments(Float32Array.from([1, 1, 1, 2, 2, 2, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]))).toBe(2);
  });
});

describe("compactSectionLine", () => {
  it("reproduces the ClipEdges geometry: 100 000 instances whatever the cut", () => {
    expect(clipEdges(8).lineGeometry.instanceCount).toBe(100_000);
  });

  it("keeps only the real segments, in a buffer of their size", () => {
    const { lineGeometry } = clipEdges(8);
    compactSectionLine(lineGeometry);
    expect(lineGeometry.instanceCount).toBe(4);
    expect(lineGeometry.attributes.instanceStart!.array.length).toBe(24);
    // The bounds cover the cut only, not the empty origin of the rest of the buffer.
    expect(lineGeometry.boundingBox!.min.x).toBeGreaterThan(0);
    const array = lineGeometry.attributes.instanceStart!.array;
    compactSectionLine(lineGeometry);
    expect(lineGeometry.attributes.instanceStart!.array).toBe(array);
  });

  it("draws nothing for an empty cut and logs no NaN bounds", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { lineGeometry } = clipEdges(0);
    compactSectionLine(lineGeometry);
    expect(lineGeometry.instanceCount).toBe(0);
    expect(lineGeometry.attributes.instanceStart!.array.length).toBe(6);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("compacts again after the section is recomputed", () => {
    const { lineGeometry } = clipEdges(8);
    compactSectionLine(lineGeometry);
    const next = sectionBuffer(40);
    lineGeometry.fromLineSegments(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(next, 3))));
    expect(lineGeometry.instanceCount).toBe(100_000);
    compactSectionLine(lineGeometry);
    expect(lineGeometry.instanceCount).toBe(20);
  });

  it("leaves a geometry without line data alone", () => {
    const geometry = new LineSegmentsGeometry();
    const before = geometry.instanceCount;
    compactSectionLine(geometry);
    expect(geometry.instanceCount).toBe(before);
  });
});

describe("compactSectionFill", () => {
  it("keeps the positions up to the highest indexed vertex", () => {
    const { fillGeometry } = clipEdges(8, [0, 1, 2, 2, 3, 5]);
    fillGeometry.computeBoundingSphere();
    compactSectionFill(fillGeometry);
    expect(fillGeometry.getAttribute("position").count).toBe(6);
    expect(fillGeometry.getIndex()!.count).toBe(6);
    expect(fillGeometry.boundingSphere).toBeNull();
  });

  it("empties the positions of a fill without triangles", () => {
    const { fillGeometry } = clipEdges(8, []);
    compactSectionFill(fillGeometry);
    expect(fillGeometry.getAttribute("position").count).toBe(0);
  });
});

describe("compactSectionMeshes", () => {
  it("compacts the line and the fill of a ClipEdges group; both stop sharing the big buffer", () => {
    const { group, lineGeometry, fillGeometry, buffer } = clipEdges(10, [0, 1, 2]);
    compactSectionMeshes([group]);
    expect(lineGeometry.instanceCount).toBe(5);
    expect(lineGeometry.attributes.instanceStart!.array).not.toBe(buffer);
    expect(fillGeometry.getAttribute("position").array).not.toBe(buffer);
    expect(fillGeometry.getAttribute("position").count).toBe(3);
  });
});

describe("SectionTool scene hook", () => {
  it("compacts its cut meshes before each frame and keeps the previous scene hook working", () => {
    const { engine, scene } = makeEngineStub([fakeModel({ id: "arch" })]);
    const previous = vi.fn();
    scene.onBeforeRender = previous;
    const tool = new SectionTool(engine);
    const { group, lineGeometry } = clipEdges(10);
    (tool as unknown as { edges: Map<string, { three: THREE.Object3D }> }).edges.set("p1", { three: group });

    const render = scene.onBeforeRender as unknown as (...args: unknown[]) => void;
    render({}, scene, new THREE.PerspectiveCamera(), null);
    expect(lineGeometry.instanceCount).toBe(5);
    expect(previous).toHaveBeenCalledOnce();

    (tool as unknown as { edges: Map<string, unknown> }).edges.clear();
    tool.dispose();
    expect(scene.onBeforeRender).toBe(previous);
  });
});
