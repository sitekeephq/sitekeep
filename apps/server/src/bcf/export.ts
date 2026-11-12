/**
 * .bcfzip export (BCF-XML 2.1 or 3.0), layout per buildingSMART BCF-XML:
 *   bcf.version · project.bcfp · extensions.xml (3.0) ·
 *   <topic guid>/markup.bcf · <topic guid>/viewpoint.bcfv + snapshot.png|jpg (first viewpoint) ·
 *   <topic guid>/<viewpoint guid>.bcfv + <viewpoint guid>.png|jpg (further viewpoints)
 */
import { ZipFile } from "yazl";
import { BCF_PRIORITY_OUT, BCF_STATUS_OUT, type BcfVersion } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import type { issues, projects } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { writeExtensions, writeMarkup, writeProject, writeVersion, writeVisinfo, type ViewpointEntry } from "./bcf-xml.js";
import { issuesToBundles } from "./topics.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

export interface BcfZipResult {
  zip: Buffer;
  topics: number;
  warnings: string[];
}

export async function buildBcfZip(
  o: { db: Db; storage: Storage },
  project: Pick<typeof projects.$inferSelect, "id" | "code" | "name">,
  rows: (typeof issues.$inferSelect)[],
  version: BcfVersion,
  memberEmails: string[] = [],
  /** lang: language of the warnings (the requester's). */
  opts: { snapshots?: boolean; lang?: string } = {},
): Promise<BcfZipResult> {
  const lang = opts.lang ?? DEFAULT_LANGUAGE;
  const { bundles, warnings } = await issuesToBundles(o, rows, lang);
  const zip = new ZipFile();
  const mtime = new Date();
  const add = (name: string, data: string | Buffer, compress = true) =>
    zip.addBuffer(typeof data === "string" ? Buffer.from(data, "utf8") : data, name, { mtime, compress });

  add("bcf.version", writeVersion(version));
  add("project.bcfp", writeProject(version, { id: project.id, name: `${project.code} ${project.name}`.trim() }));
  if (version === "3.0") {
    add(
      "extensions.xml",
      writeExtensions({
        topicTypes: ["Issue", ...bundles.map((b) => b.topic.topic_type)],
        topicStatuses: [...Object.values(BCF_STATUS_OUT), ...bundles.map((b) => b.topic.topic_status)],
        priorities: [...Object.values(BCF_PRIORITY_OUT), ...bundles.map((b) => b.topic.priority ?? "").filter(Boolean)],
        labels: bundles.flatMap((b) => b.topic.labels),
        users: [...memberEmails, ...bundles.flatMap((b) => [b.topic.creation_author, b.topic.assigned_to ?? ""])].filter((u) => u && u !== "bilinmiyor"),
        stages: bundles.map((b) => b.topic.stage ?? "").filter(Boolean),
      }),
    );
  }

  let lowFov = 0;
  for (const b of bundles) {
    const folder = b.topic.guid.toLowerCase();
    const entries: ViewpointEntry[] = [];
    for (const [i, vp] of b.viewpoints.entries()) {
      const base = i === 0 ? null : vp.guid.toLowerCase();
      const entry: ViewpointEntry = { guid: vp.guid, index: i };
      if (vp.perspective_camera || vp.orthogonal_camera) {
        entry.viewpoint = base ? `${base}.bcfv` : "viewpoint.bcfv";
        if (version === "2.1" && vp.perspective_camera && (vp.perspective_camera.field_of_view < 45 || vp.perspective_camera.field_of_view > 60)) lowFov++;
        add(`${folder}/${entry.viewpoint}`, writeVisinfo(version, vp));
      }
      if (vp.snapshot && opts.snapshots !== false) {
        entry.snapshot = `${base ?? "snapshot"}.${vp.snapshot.snapshot_type}`;
        // Images are already compressed.
        add(`${folder}/${entry.snapshot}`, Buffer.from(vp.snapshot.snapshot_data, "base64"), false);
      }
      if (entry.viewpoint || entry.snapshot) entries.push(entry);
    }
    add(`${folder}/markup.bcf`, writeMarkup(version, b, entries));
  }
  if (lowFov) warnings.push(tFor(lang)("bcf:warnings.fovClamped", { count: lowFov }));
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return { zip: Buffer.concat(chunks), topics: bundles.length, warnings };
}

export function bcfFileName(projectCode: string, version: BcfVersion, count: number, number?: number): string {
  const safe = projectCode.replace(/[^A-Za-z0-9_-]+/g, "-") || "proje";
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const what = count === 1 && number !== undefined ? `sorun-${number}` : `sorunlar-${count}`;
  return `${safe}-${what}-${stamp}-bcf${version.replace(".", "")}.bcfzip`;
}
