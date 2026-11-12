/**
 * cde_dev_upload and the upload helper used by seeds and scenarios: generated samples, test
 * fixtures or an explicitly given local path, through the normal upload route.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import type { CdeCall } from "@sitekeep/cde-tools";
import { files, folders } from "../db/schema.js";
import type { DevContext } from "./context.js";
import { link } from "./context.js";
import { findProject } from "./registry.js";
import { fixture, makeSample, type Sample, type SampleKind } from "./samples.js";
import { projectPath } from "@sitekeep/shared";

export interface Uploaded {
  fileId: string;
  versionId: string;
  version: number;
  name: string;
}

/** Uploads one file (same name in the same folder = new version) and returns its latest version. */
export async function uploadFile(
  call: CdeCall,
  projectId: string,
  folderId: string,
  file: Sample,
  o: { comment?: string; attributes?: Record<string, string> } = {},
): Promise<Uploaded> {
  const form = new FormData();
  if (o.comment) form.append("comment", o.comment);
  if (o.attributes) form.append("attributes", JSON.stringify(o.attributes));
  form.append("file", new Blob([new Uint8Array(file.data)]), file.name);
  const r = await call<{ results: { name: string; ok: boolean; errors?: string[]; fileId?: string; version?: number }[] }>(
    "POST",
    `/projects/${projectId}/folders/${folderId}/files`,
    form,
  );
  const res = r.results[0];
  if (!res?.ok || !res.fileId) throw new Error(`${file.name}: ${(res?.errors ?? ["yüklenemedi"]).join(", ")}`);
  const f = await call<{ latest: { id: string; version: number } }>("GET", `/projects/${projectId}/files/${res.fileId}`);
  return { fileId: res.fileId, versionId: f.latest.id, version: f.latest.version, name: file.name };
}

/** First WIP folder of the project, else the root. */
async function defaultFolder(ctx: DevContext, projectId: string, rootId: string): Promise<string> {
  const [wip] = await ctx.db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.projectId, projectId), eq(folders.state, "wip"), sql`${folders.deletedAt} is null`))
    .orderBy(asc(folders.name))
    .limit(1);
  return wip?.id ?? rootId;
}

export async function devUpload(ctx: DevContext, a: Record<string, unknown>) {
  const p = await findProject(ctx.db, String(a.project));
  const sources = [a.sample, a.fixture, a.path].filter((x) => x !== undefined && x !== null && x !== "");
  if (sources.length > 1) throw new Error("sample, fixture ve path'ten yalnız birini verin.");
  let folderId = a.folderId as string | undefined;
  let fixedName = a.name as string | undefined;
  if (a.newVersionOf) {
    const [f] = await ctx.db.select().from(files).where(and(eq(files.id, String(a.newVersionOf)), eq(files.projectId, p.id)));
    if (!f) throw new Error("newVersionOf: dosya bu projede yok.");
    folderId = f.folderId;
    fixedName = f.name;
  }
  folderId ??= await defaultFolder(ctx, p.id, p.rootFolderId!);
  const count = Number(a.count ?? 1);
  const out: (Uploaded & { link: string })[] = [];
  for (let i = 0; i < count; i++) {
    let file: Sample;
    if (a.path) {
      const full = path.resolve(String(a.path));
      const st = await stat(full);
      if (!st.isFile()) throw new Error("path bir dosya olmalı.");
      if (st.size > 200 * 1024 * 1024) throw new Error("Dosya 200 MB'den büyük.");
      file = { name: fixedName ?? path.basename(full), data: await readFile(full) };
    } else if (a.fixture) {
      file = { name: fixedName ?? String(a.fixture), data: fixture(String(a.fixture)) };
    } else {
      const kind = (a.sample as SampleKind | undefined) ?? (fixedName?.toLowerCase().endsWith(".ifc") ? "ifc_v2" : "pdf_drawing");
      file = await makeSample(kind, { i: i + Math.floor(Date.now() / 1000) % 900, revision: a.revision as string | undefined, name: fixedName, project: p.name.toLocaleUpperCase("tr-TR") });
    }
    const u = await uploadFile(ctx.call, p.id, folderId, file, { comment: a.comment as string | undefined, ...(a.revision ? { attributes: { Revizyon: String(a.revision) } } : {}) });
    out.push({ ...u, link: link(ctx, projectPath(p.id, `files/${folderId}`)) });
    if (a.newVersionOf || a.path) break;
  }
  return { project: p.code, folderId, uploaded: out };
}
