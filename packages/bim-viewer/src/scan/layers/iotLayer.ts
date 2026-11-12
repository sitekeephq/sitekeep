import * as THREE from "three";
import type { IotSensor, SensorStatus } from "../types.js";

const STATUS_COLOR: Record<SensorStatus, number> = {
  ok: 0x22c55e,
  warn: 0xf59e0b,
  alarm: 0xef4444,
};

function makeLabelTexture(text: string, hex: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
  ctx.beginPath();
  ctx.rect(8, 10, 240, 44);
  ctx.fill();
  ctx.strokeStyle = hex;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 20px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function iotMarkerRadius(box?: THREE.Box3 | null): number {
  if (!box || box.isEmpty()) return 0.35;
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1);
  return THREE.MathUtils.clamp(span * 0.008, 0.35, 16);
}

/**
 * Above this many points (the 25 cm survey: thousands) each point is one instance of a single mesh,
 * coloured by status, without the per-point halo and label texture (thousands of canvases would
 * stall the GPU). The value of a point is in the list and the detail panel.
 */
export const DENSE_IOT_POINTS = 200;

/** The instanced mesh of a dense layer; userData.sensorIds maps instanceId → sensor id. */
const DENSE_MESH = "iot-points";

function createDenseIotLayer(group: THREE.Group, sensors: IotSensor[], radius: number) {
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(radius, 10, 8),
    new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.25 }),
    sensors.length,
  );
  mesh.name = DENSE_MESH;
  const matrix = new THREE.Matrix4();
  sensors.forEach((sensor, i) => {
    mesh.setMatrixAt(i, matrix.makeTranslation(...sensor.position));
    mesh.setColorAt(i, new THREE.Color(STATUS_COLOR[sensor.status]));
  });
  mesh.userData.sensorIds = sensors.map((s) => s.id);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
  return group;
}

/** The sensor id under a raycast hit on the IoT layer (a marker, or an instance of the dense mesh). */
export function iotSensorIdFromHit(hit: THREE.Intersection): string | undefined {
  const { object } = hit;
  if (object.userData.sensorId) return object.userData.sensorId as string;
  const ids = object.userData.sensorIds as string[] | undefined;
  return ids && hit.instanceId != null ? ids[hit.instanceId] : undefined;
}

export function createIotLayer(sensors: IotSensor[], markerRadius = 0.35): THREE.Group {
  const group = new THREE.Group();
  group.name = "iot-extension";
  const r = markerRadius;
  // Dense points sit 25 cm apart along the track: smaller markers keep them apart.
  if (sensors.length > DENSE_IOT_POINTS) return createDenseIotLayer(group, sensors, Math.min(r * 0.5, 0.6));

  for (const sensor of sensors) {
    const color = STATUS_COLOR[sensor.status];
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(r, 18, 18),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.65,
        roughness: 0.35,
        metalness: 0.1,
      })
    );
    marker.position.set(...sensor.position);
    marker.name = sensor.id;
    marker.userData.sensorId = sensor.id;

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.4, r * 2.05, 24),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.copy(marker.position);
    halo.position.y -= r * 0.55;

    const valueText = sensor.value === null ? "—" : `${sensor.value}${sensor.unit}`;
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeLabelTexture(`${sensor.name} · ${valueText}`, `#${color.toString(16).padStart(6, "0")}`),
        transparent: true,
        depthTest: false,
      })
    );
    label.position.copy(marker.position);
    label.position.y += r * 3.2;
    label.scale.set(r * 14, r * 3.5, 1);
    label.name = `${sensor.id}-label`;

    group.add(marker, halo, label);
  }

  return group;
}

export function paintIotLayer(group: THREE.Group, sensors: IotSensor[]) {
  const dense = group.getObjectByName(DENSE_MESH) as THREE.InstancedMesh | undefined;
  if (dense) {
    const index = new Map((dense.userData.sensorIds as string[]).map((id, i) => [id, i]));
    const color = new THREE.Color();
    for (const sensor of sensors) {
      const i = index.get(sensor.id);
      if (i !== undefined) dense.setColorAt(i, color.setHex(STATUS_COLOR[sensor.status]));
    }
    if (dense.instanceColor) dense.instanceColor.needsUpdate = true;
    return;
  }
  for (const sensor of sensors) {
    const color = STATUS_COLOR[sensor.status];
    const marker = group.getObjectByName(sensor.id) as THREE.Mesh | undefined;
    if (marker && marker.material instanceof THREE.MeshStandardMaterial) {
      marker.material.color.setHex(color);
      marker.material.emissive.setHex(color);
    }
    const label = group.getObjectByName(`${sensor.id}-label`) as THREE.Sprite | undefined;
    if (label && label.material instanceof THREE.SpriteMaterial && label.material.map) {
      label.material.map.dispose();
      const valueText = sensor.value === null ? "—" : `${sensor.value}${sensor.unit}`;
      label.material.map = makeLabelTexture(
        `${sensor.name} · ${valueText}`,
        `#${color.toString(16).padStart(6, "0")}`
      );
    }
  }
}
