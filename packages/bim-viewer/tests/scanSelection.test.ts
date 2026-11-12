import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createScanSelectionOutline, scanElementFromHit } from "../src/scan/selection/scanSelection";

function railMesh(vertexCount = 12) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.name = "guzergah-rails";
  return mesh;
}

describe("scanElementFromHit", () => {
  it("returns null for meshes that are not a güzergah part", () => {
    const mesh = railMesh();
    mesh.name = "other";
    expect(scanElementFromHit(new THREE.Group(), mesh, 0)).toBeNull();
  });

  it("picks the sleeper / rail index from the hit face", () => {
    const root = new THREE.Group();
    root.userData.ifcMeta = { counts: { rails: 2, sleepers: 4 } };
    const mesh = railMesh(12);
    const hit = scanElementFromHit(root, mesh, 3);
    expect(hit).toMatchObject({
      id: "rails-2",
      label: "Ray 2",
      part: "rails",
      elementIndex: 1,
    });
    expect(hit?.box.isEmpty()).toBe(false);
  });

  it("builds a depth-tested-off outline helper", () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
    const outline = createScanSelectionOutline(box);
    expect(outline.name).toBe("scan-selection-outline");
    expect((outline.material as THREE.LineBasicMaterial).depthTest).toBe(false);
  });
});
