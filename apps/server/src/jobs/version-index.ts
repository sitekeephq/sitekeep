/** IFC element indexes (GlobalId → class, name, propsHash, details) used for version comparison and "Modele sor". */
import { createReadStream } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { versionIndexes } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";

/** GlobalId → [IFC class, Name, propsHash] */
export type ElementIndex = Record<string, [string, string | null, string]>;

export async function saveVersionIndex(
  db: Db,
  storage: Storage,
  versionId: string,
  projectId: string,
  file: string,
  elementCount: number,
): Promise<void> {
  const stored = await storage.put(createReadStream(file), `projects/${projectId}/indexes`);
  const [old] = await db.select().from(versionIndexes).where(eq(versionIndexes.versionId, versionId));
  await db
    .insert(versionIndexes)
    .values({ versionId, storageKey: stored.key, elementCount })
    .onConflictDoUpdate({
      target: versionIndexes.versionId,
      set: { storageKey: stored.key, elementCount, createdAt: new Date() },
    });
  if (old && old.storageKey !== stored.key) await storage.remove(old.storageKey);
  cache.delete(versionId);
}

/** Parsed index file. Format 1 has only `elements`; format 2 adds storeys, types, materials and properties. */
export interface IndexFile {
  v: number;
  elements: ElementIndex;
  storeys?: { name: string; elevation: number | null }[];
  keys?: string[];
  vals?: (string | number | boolean)[];
  /**
   * GlobalId → [expressId, storey index (-1), type name (vals index, -1), material (vals index, -1), placement hash,
   * [key, val, key, val …], keys whose value comes from the type (newer indexes), type GlobalId (vals index, -1; newer indexes)]
   */
  details?: Record<string, [number, number, number, number, string, number[], number[]?, number?]>;
  /** Metres, m² and m³ per model unit (IfcUnitAssignment); absent in older indexes. */
  units?: { length: number; area: number; volume: number };
  /** Version of the `openings` field (OPENINGS_FORMAT); absent in older indexes. */
  openingsV?: number;
  /**
   * Host GlobalId → openings voiding it: [opening GlobalId, filling door/window GlobalId, extruded
   * solids [profile area m², profile width m, profile height m, extrusion height m]] (no solids: unmeasured).
   */
  openings?: Record<string, [string, string | null, [number, number, number, number][]][]>;
}

/** Index format that "Modele sor" and property-level comparison need. */
export const MODEL_INDEX_FORMAT = 2;

/** Openings format the quantity inventory needs (jobs/ifc-worker.ts writes the same number). */
export const OPENINGS_FORMAT = 1;

const cache = new Map<string, IndexFile>();
const CACHE_SIZE = 8;

/** Reads an index from storage (a few recent ones stay in memory). */
export async function loadIndexFile(storage: Storage, versionId: string, storageKey: string): Promise<IndexFile> {
  const hit = cache.get(versionId);
  if (hit) {
    cache.delete(versionId);
    cache.set(versionId, hit);
    return hit;
  }
  const chunks: Buffer[] = [];
  for await (const c of storage.get(storageKey)) chunks.push(c as Buffer);
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as IndexFile;
  cache.set(versionId, parsed);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return parsed;
}

/** Only the GlobalId → [class, name, hash] part (version comparison). */
export async function loadVersionIndex(storage: Storage, versionId: string, storageKey: string): Promise<ElementIndex> {
  return (await loadIndexFile(storage, versionId, storageKey)).elements;
}
