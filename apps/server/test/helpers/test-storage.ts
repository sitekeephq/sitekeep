/**
 * The storage a server test runs on: the local disk by default; SITEKEEP_TEST_STORAGE=object runs the same
 * test on object storage (an in-memory bucket, docs/onprem/object-storage.md), so workers that need a file
 * on disk are exercised through temporary local copies.
 */
import path from "node:path";
import { ObjectStorage } from "../../src/core/platform/object-storage.js";
import { LocalStorage, type Storage } from "../../src/core/platform/storage.js";
import { MemoryBackend } from "./object-store.js";

export const objectStorageRun = process.env.SITEKEEP_TEST_STORAGE === "object";

export async function testStorage(dataDir: string): Promise<Storage> {
  if (!objectStorageRun) return new LocalStorage(path.join(dataDir, "storage"));
  const s = new ObjectStorage(new MemoryBackend(), { prefix: "app", workDir: path.join(dataDir, "tmp", "storage") });
  await s.init({ clearScratch: true });
  return s;
}
