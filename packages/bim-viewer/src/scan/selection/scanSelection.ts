import * as THREE from "three";
import type { IfcMeshMeta } from "../layers/ifcMesh.js";

export type ScanElementSelection = {
  id: string;
  label: string;
  part: string;
  elementIndex: number;
  vertexStart: number;
  vertexEnd: number;
  mesh: THREE.Mesh;
  box: THREE.Box3;
};

const PART_LABELS: Record<string, string> = {
  sleepers: "Travers",
  rails: "Ray",
};

export function scanElementFromHit(
  root: THREE.Object3D,
  object: THREE.Object3D,
  faceIndex: number | undefined
): ScanElementSelection | null {
  if (!(object instanceof THREE.Mesh) || !object.geometry) return null;
  if (!object.name.startsWith("guzergah-")) return null;

  const part = object.name.replace("guzergah-", "");
  const meta = (root.userData.ifcMeta || {}) as IfcMeshMeta;
  const configuredCount = part === "sleepers"
    ? meta.counts?.sleepers
    : part === "rails"
      ? meta.counts?.rails
      : undefined;
  const position = object.geometry.getAttribute("position");
  if (!position?.count) return null;

  const elementCount = Math.max(1, configuredCount || 1);
  const verticesPerElement = Math.max(3, Math.floor(position.count / elementCount));
  const hitVertex = Math.max(0, (faceIndex || 0) * 3);
  const elementIndex = Math.min(elementCount - 1, Math.floor(hitVertex / verticesPerElement));
  const start = elementIndex * verticesPerElement;
  const end = elementIndex === elementCount - 1
    ? position.count
    : Math.min(position.count, start + verticesPerElement);
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let index = start; index < end; index++) {
    point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
    box.expandByPoint(point);
  }
  if (box.isEmpty()) return null;

  const singular = PART_LABELS[part] || "Model elemanı";
  return {
    id: `${part}-${elementIndex + 1}`,
    label: `${singular} ${elementIndex + 1}`,
    part,
    elementIndex,
    vertexStart: start,
    vertexEnd: end,
    mesh: object,
    box,
  };
}

export function createScanSelectionOutline(box: THREE.Box3) {
  const outline = new THREE.Box3Helper(box, new THREE.Color(0x38bdf8));
  outline.name = "scan-selection-outline";
  outline.renderOrder = 10000;
  const material = outline.material as THREE.LineBasicMaterial;
  material.depthTest = false;
  material.transparent = true;
  material.opacity = 0.95;
  return outline;
}

export function applyScanSelectionColor(selection: ScanElementSelection) {
  const { mesh, vertexStart, vertexEnd } = selection;
  const geometry = mesh.geometry;
  const originalMaterial = mesh.material;
  const originalGroups = geometry.groups.map((group) => ({ ...group }));
  const highlight = new THREE.MeshLambertMaterial({
    color: 0x38bdf8,
    emissive: 0x0c4a6e,
    emissiveIntensity: 0.75,
    side: THREE.DoubleSide,
  });
  const materials = Array.isArray(originalMaterial)
    ? [...originalMaterial, highlight]
    : [originalMaterial, highlight];
  const highlightIndex = materials.length - 1;

  geometry.clearGroups();
  if (vertexStart > 0) geometry.addGroup(0, vertexStart, 0);
  geometry.addGroup(vertexStart, vertexEnd - vertexStart, highlightIndex);
  if (vertexEnd < geometry.getAttribute("position").count) {
    geometry.addGroup(vertexEnd, geometry.getAttribute("position").count - vertexEnd, 0);
  }
  mesh.material = materials;

  return () => {
    mesh.material = originalMaterial;
    geometry.clearGroups();
    originalGroups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex));
    highlight.dispose();
  };
}
