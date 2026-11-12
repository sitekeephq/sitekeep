/**
 * The translation Fragments applied to a model on import (web-ifc COORDINATE_TO_ORIGIN), read
 * from the stored viewer derivative. The viewer's scene is (x, z, −y) + this offset for an IFC world
 * point (x, y, z). Viewpoints saved since BCF support carry their own `sceneOffset`; this is only
 * needed to export older ones, and is cached in file_versions.ifc_summary.sceneOffset.
 *
 * The derivative is a zlib-deflated FlatBuffer (Fragments 3 Model). Only one path is read:
 * Model.meshes (field 6) → Meshes.coordinates (field 0, inline Transform struct) → position
 * (3 × float64). Same data as FragmentsModel.getCoordinates() in the browser.
 */
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { IfcSummary, Vec3 } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";

const inflateAsync = promisify(inflate);

/** Reads the coordinates position from a (deflated or raw) Fragments model; null when not readable. */
export async function fragmentsOffset(bytes: Buffer): Promise<Vec3 | null> {
  let data = bytes;
  // zlib header (78 xx): pako.deflate output.
  if (data.length > 2 && data[0] === 0x78) {
    try {
      data = await inflateAsync(data, { maxOutputLength: 2 * 1024 * 1024 * 1024 - 1 });
    } catch {
      return null;
    }
  }
  return readOffset(data);
}

export function readOffset(b: Buffer): Vec3 | null {
  try {
    const i32 = (o: number) => b.readInt32LE(o);
    const u16 = (o: number) => b.readUInt16LE(o);
    const field = (table: number, slot: number) => {
      const vtable = table - i32(table);
      const vOffset = 4 + 2 * slot;
      return vOffset < u16(vtable) ? u16(vtable + vOffset) : 0;
    };
    const root = i32(0);
    const meshesField = field(root, 6);
    if (!meshesField) return null;
    const meshes = root + meshesField + i32(root + meshesField);
    const coordsField = field(meshes, 0);
    if (!coordsField) return null;
    const pos = meshes + coordsField;
    const v: Vec3 = [b.readDoubleLE(pos), b.readDoubleLE(pos + 8), b.readDoubleLE(pos + 16)];
    return v.every((n) => Number.isFinite(n)) ? v : null;
  } catch {
    return null;
  }
}

/** Offset of a file version's viewer model (cached); null when the derivative is missing or unreadable. */
export async function versionSceneOffset(db: Db, storage: Storage, versionId: string): Promise<Vec3 | null> {
  const [v] = await db.select().from(fileVersions).where(eq(fileVersions.id, versionId));
  if (!v) return null;
  if (v.ifcSummary?.sceneOffset) return v.ifcSummary.sceneOffset;
  if (v.derivativeStatus !== "ready" || !v.derivativeKey) return null;
  let bytes: Buffer;
  try {
    bytes = await readAll(storage.get(v.derivativeKey));
  } catch {
    return null;
  }
  const offset = await fragmentsOffset(bytes);
  if (offset && v.ifcSummary) {
    const summary: IfcSummary = { ...v.ifcSummary, sceneOffset: offset };
    await db.update(fileVersions).set({ ifcSummary: summary }).where(eq(fileVersions.id, v.id));
  }
  return offset;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}
