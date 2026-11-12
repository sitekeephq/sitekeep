/**
 * Issues ↔ BCF topic bundles (BCF API 3.0 JSON shapes). Used by the .bcfzip export and meant for
 * the BCF API 3.0 routes: GET topics / comments / viewpoints map an issue the same way.
 */
import { asc, eq, inArray } from "drizzle-orm";
import {
  BCF_DEFAULT_TYPE,
  BCF_PRIORITY_OUT,
  BCF_STATUS_OUT,
  dueDateToBcf,
  suggestIssuePriority,
  suggestIssueStatus,
  viewpointToBcf,
  type BcfComment,
  type BcfFileRef,
  type BcfTopic,
  type BcfTopicBundle,
  type BcfViewpoint,
  type IssueViewpoint,
  type IssueViewpointDto,
  type Vec3,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files, issueComments, issueRelatedTopics, issueViewpoints, issues, users } from "../db/schema.js";
import type { Storage } from "../core/platform/storage.js";
import { guidFrom } from "./bcf-xml.js";
import { versionSceneOffset } from "./frame.js";
import { fromDataUrl } from "./image.js";
import { DEFAULT_LANGUAGE, msg, render } from "../i18n/index.js";

type IssueRow = typeof issues.$inferSelect;

/** GUID of an issue's primary viewpoint: its own, or a stable one derived from the issue id (older viewpoints). */
export function primaryViewpointGuid(issue: Pick<IssueRow, "id" | "viewpoint">): string {
  return issue.viewpoint?.guid ?? guidFrom(`viewpoint:${issue.id}`);
}

/** Every viewpoint of an issue, primary first (BCF index order). */
export async function issueViewpointList(db: Db, issue: Pick<IssueRow, "id" | "viewpoint">): Promise<IssueViewpointDto[]> {
  const out: IssueViewpointDto[] = [];
  if (issue.viewpoint) {
    const guid = primaryViewpointGuid(issue);
    out.push({ guid, index: 0, primary: true, viewpoint: { ...issue.viewpoint, guid } });
  }
  const rows = await db.select().from(issueViewpoints).where(eq(issueViewpoints.issueId, issue.id)).orderBy(asc(issueViewpoints.idx), asc(issueViewpoints.createdAt));
  for (const r of rows) out.push({ guid: r.guid, index: out.length, primary: false, viewpoint: { ...r.viewpoint, guid: r.guid } });
  return out;
}

/** E-mail addresses of users (BCF identifies people by e-mail). */
export async function userEmails(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.email]));
}

export interface BundleOptions {
  db: Db;
  storage: Storage;
}

export interface IssueBundle extends BcfTopicBundle {
  issueId: string;
  number: number;
}

/**
 * BCF bundles of issues: topic fields, header files (the models of the viewpoints), comments and
 * viewpoints with snapshots. Viewpoints saved before BCF support get their frame from the model's
 * derivative; when that is unknown a warning says the coordinates may be shifted.
 */
export async function issuesToBundles(o: BundleOptions, rows: IssueRow[], lang = DEFAULT_LANGUAGE): Promise<{ bundles: IssueBundle[]; warnings: string[] }> {
  const { db, storage } = o;
  const warnings: string[] = [];
  if (!rows.length) return { bundles: [], warnings };
  const ids = rows.map((r) => r.id);
  const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, ids)).orderBy(asc(issueComments.createdAt));
  const extras = await db.select().from(issueViewpoints).where(inArray(issueViewpoints.issueId, ids)).orderBy(asc(issueViewpoints.idx), asc(issueViewpoints.createdAt));
  const related = await db.select().from(issueRelatedTopics).where(inArray(issueRelatedTopics.issueId, ids));
  const emails = await userEmails(db, [
    ...rows.flatMap((r) => [r.createdBy, r.assigneeUserId, r.modifiedBy]),
    ...comments.flatMap((c) => [c.authorId, c.modifiedBy]),
  ]);

  // Model versions referenced by the viewpoints → header files.
  const versionIds = new Set<string>();
  for (const r of rows) r.viewpoint?.fileVersionIds.forEach((v) => versionIds.add(v));
  for (const x of extras) x.viewpoint.fileVersionIds.forEach((v) => versionIds.add(v));
  const versions = versionIds.size
    ? await db
        .select({ id: fileVersions.id, uploadedAt: fileVersions.uploadedAt, summary: fileVersions.ifcSummary, name: files.name })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(inArray(fileVersions.id, [...versionIds]))
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const offsets = new Map<string, Vec3 | null>();
  const offsetOf = async (versionId: string | undefined) => {
    if (!versionId) return null;
    if (!offsets.has(versionId)) offsets.set(versionId, await versionSceneOffset(db, storage, versionId));
    return offsets.get(versionId) ?? null;
  };

  let unknownFrame = 0;
  const bundles: IssueBundle[] = [];
  for (const r of rows) {
    const imp = r.importedFrom;
    const vps: { guid: string; vp: IssueViewpoint; primary: boolean }[] = [];
    if (r.viewpoint) vps.push({ guid: primaryViewpointGuid(r), vp: r.viewpoint, primary: true });
    for (const x of extras.filter((e) => e.issueId === r.id)) vps.push({ guid: x.guid, vp: x.viewpoint, primary: false });

    const viewpoints: BcfViewpoint[] = [];
    for (const [i, { guid, vp, primary }] of vps.entries()) {
      let fallbackOffset: Vec3 | undefined;
      if (!vp.sceneOffset && !vp.snapshotOnly) {
        fallbackOffset = (await offsetOf(vp.fileVersionIds[0])) ?? undefined;
        if (!fallbackOffset) unknownFrame++;
      }
      const snap = fromDataUrl(vp.snapshot);
      const out = viewpointToBcf(vp, { guid, index: i, fallbackOffset, pin: primary ? r.pin?.position : null });
      if (snap) out.snapshot = { snapshot_type: snap.type, snapshot_data: snap.data.toString("base64") };
      viewpoints.push(out);
    }

    const fileRefs: BcfFileRef[] = [];
    const seen = new Set<string>();
    for (const { vp } of vps) {
      for (const vid of vp.fileVersionIds) {
        const v = versionById.get(vid);
        if (!v || seen.has(vid)) continue;
        seen.add(vid);
        fileRefs.push({
          filename: v.name,
          date: v.uploadedAt.toISOString(),
          reference: v.id,
          ifc_project: v.summary?.projectGuid ?? null,
          is_external: true,
        });
      }
    }
    // Header files of an imported topic that matched no model here travel on unchanged.
    for (const f of imp?.files ?? []) {
      if (f.fileVersionId) continue;
      fileRefs.push({ filename: f.filename ?? null, ifc_project: f.ifcProject ?? null, reference: f.reference ?? null, date: f.date ?? null, is_external: true });
    }

    const creationAuthor = imp?.creationAuthor ?? emails.get(r.createdBy) ?? "bilinmiyor";
    const topic: BcfTopic = {
      guid: r.guid,
      server_assigned_id: String(r.number),
      topic_type: r.type?.trim() || BCF_DEFAULT_TYPE,
      // An imported value that still means our status / priority is written back as it came.
      topic_status: imp?.topicStatus && suggestIssueStatus(imp.topicStatus) === r.status ? imp.topicStatus : BCF_STATUS_OUT[r.status],
      priority: imp?.priority && suggestIssuePriority(imp.priority) === r.priority ? imp.priority : BCF_PRIORITY_OUT[r.priority],
      title: r.title,
      description: r.description,
      labels: r.labels,
      stage: r.stage,
      reference_links: r.referenceLinks,
      creation_date: r.createdAt.toISOString(),
      creation_author: creationAuthor,
      modified_date: r.updatedAt.toISOString(),
      modified_author: emails.get(r.modifiedBy ?? "") ?? imp?.modifiedAuthor ?? emails.get(r.createdBy) ?? creationAuthor,
      due_date: dueDateToBcf(r.dueDate),
      assigned_to: emails.get(r.assigneeUserId ?? "") ?? imp?.assignedTo ?? null,
      related_topics: related.filter((x) => x.issueId === r.id).map((x) => ({ related_topic_guid: x.relatedGuid })),
      document_references: (imp?.documentReferences ?? []).filter((d) => d.url).map((d) => ({ guid: d.guid, url: d.url, description: d.description })),
    };
    const vpGuids = new Set(vps.map((v) => v.guid));
    const bcfComments: BcfComment[] = comments
      .filter((c) => c.issueId === r.id)
      .map((c) => ({
        guid: c.guid,
        date: c.createdAt.toISOString(),
        author: c.importedAuthor ?? emails.get(c.authorId) ?? "bilinmiyor",
        comment: c.body,
        viewpoint_guid: c.viewpointGuid && vpGuids.has(c.viewpointGuid) ? c.viewpointGuid : null,
        modified_date: c.modifiedAt?.toISOString() ?? null,
        modified_author: c.modifiedBy ? (emails.get(c.modifiedBy) ?? null) : null,
      }));
    bundles.push({ issueId: r.id, number: r.number, topic, files: fileRefs, comments: bcfComments, viewpoints });
  }
  if (unknownFrame) {
    warnings.push(render(lang, msg("bcf:warnings.unknownFrame", { count: unknownFrame })));
  }
  return { bundles, warnings };
}
