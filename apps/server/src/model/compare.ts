import { inArray } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { CompareClassCount, VersionCompareDto } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { isUuid } from "../core/security/access.js";
import { HttpError, badRequest } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { versionIndexes } from "../db/schema.js";
import { loadIndexFile, type ElementIndex } from "../jobs/version-index.js";
import { Lru } from "./ai.js";
import { detailDiff } from "./diff.js";
import { ModelIndex } from "./model-index.js";
import { ensureIndexJob, ensureUpgradeJob, ifcVersion, type LoadedVersion } from "./service.js";

export type ComparePair = { a: LoadedVersion; b: LoadedVersion; oldIdx: ModelIndex; newIdx: ModelIndex; upgrading: boolean };

const diffCache = new Lru<{ result: Omit<VersionCompareDto, "from" | "to">; oldIdx: ModelIndex; newIdx: ModelIndex }>(12);
type User = Parameters<typeof ifcVersion>[3];

/** Both versions (visible IFC) and their indexes; 409 "preparing" while an index is being built. */
export async function loadComparePair(deps: AppDeps, pid: string, from: unknown, to: unknown, user: User, rebuild = false): Promise<ComparePair> {
  const { db, storage, jobs: queue } = deps;
  if (!isUuid(from) || !isUuid(to)) throw badRequest(msg("doccompare:errors.versionIdsRequired"));
  const a = await ifcVersion(db, pid, from, user);
  const b = await ifcVersion(db, pid, to, user);
  const rows = await db.select().from(versionIndexes).where(inArray(versionIndexes.versionId, [from, to]));
  const pending: string[] = [];
  for (const v of [a, b]) {
    if (rows.some((r) => r.versionId === v.version.id) || pending.includes(v.version.id)) continue;
    await ensureIndexJob(db, queue, v.version.id, v.version.derivativeStatus, rebuild);
    pending.push(v.version.id);
  }
  if (pending.length) throw new HttpError(409, "preparing", msg("doccompare:errors.preparing"), { pending });
  const rowOf = (vid: string) => rows.find((r) => r.versionId === vid)!;
  const oldIdx = ModelIndex.of(await loadIndexFile(storage, from, rowOf(from).storageKey));
  const newIdx = ModelIndex.of(await loadIndexFile(storage, to, rowOf(to).storageKey));
  let upgrading = false;
  for (const [idx, vid] of [[oldIdx, from], [newIdx, to]] as const) {
    if (!idx.detailed && (await ensureUpgradeJob(db, queue, vid, rowOf(vid).createdAt))) upgrading = true;
  }
  return { a, b, oldIdx, newIdx, upgrading };
}

/** The comparison of a pair (cached per version pair and loaded index). */
export function compareOf(p: ComparePair): VersionCompareDto {
  const key = `${p.a.version.id}|${p.b.version.id}`;
  let hit = diffCache.get(key);
  if (!hit || hit.oldIdx !== p.oldIdx || hit.newIdx !== p.newIdx) {
    const base = diffIndexes(p.oldIdx.file.elements, p.newIdx.file.elements);
    const d = detailDiff(p.oldIdx, p.newIdx, base);
    const result: Omit<VersionCompareDto, "from" | "to"> = { ...base, detailed: d.detailed, storeys: d.storeys, groups: d.groups };
    if (d.detailed) result.changes = d.changes;
    hit = { result, oldIdx: p.oldIdx, newIdx: p.newIdx };
    diffCache.set(key, hit);
  }
  return {
    from: { versionId: p.a.version.id, fileName: p.a.file.name, version: p.a.version.version, elementCount: p.oldIdx.size },
    to: { versionId: p.b.version.id, fileName: p.b.file.name, version: p.b.version.version, elementCount: p.newIdx.size },
    ...hit.result,
    ...(p.upgrading ? { upgrading: true } : {}),
  };
}

/** Aborts the model call when the client goes away. */
export function abortOnClose(reply: FastifyReply): { signal: AbortSignal; done(): void } {
  const ac = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) ac.abort();
  };
  reply.raw.on("close", onClose);
  return { signal: ac.signal, done: () => reply.raw.off("close", onClose) };
}

export function diffIndexes(oldIdx: ElementIndex, newIdx: ElementIndex): Omit<VersionCompareDto, "from" | "to"> {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  const byClass: Record<string, CompareClassCount> = {};
  const elements: VersionCompareDto["elements"] = {};
  const bump = (cls: string, key: keyof CompareClassCount) => {
    const c = (byClass[cls] ??= { added: 0, removed: 0, changed: 0, unchanged: 0 });
    c[key]++;
  };
  for (const [guid, [cls, name, hash]] of Object.entries(newIdx)) {
    const old = oldIdx[guid];
    if (!old) {
      added.push(guid); elements[guid] = [cls, name]; bump(cls, "added");
    } else if (old[2] !== hash || old[0] !== cls) {
      changed.push(guid); elements[guid] = [cls, name]; bump(cls, "changed");
    } else {
      unchanged++; bump(cls, "unchanged");
    }
  }
  for (const [guid, [cls, name]] of Object.entries(oldIdx)) {
    if (newIdx[guid]) continue;
    removed.push(guid); elements[guid] = [cls, name]; bump(cls, "removed");
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged, byClass, elements };
}
