import { createWriteStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PERMISSION_LEVELS } from "@sitekeep/shared";
import { z } from "zod";
import type { CdeCall } from "../core/types.js";
import type { ToolAdder } from "../core/define.js";
import { CdeError } from "../core/result.js";
export function registerCoreRestTools(tool: ToolAdder, call: CdeCall, options: { download?: (url: string) => Promise<Response> }): void {
const id = (what: string) => z.string().uuid().describe(what);
const pid = id("Project id (from cde_projects_list).");
const level = z
  .enum(["none", "view", "view_download", "view_download_markup", "upload_only", "edit", "manage"])
  .describe("Permission level; none removes the subject's direct grant.");

// ---- Projects & members --------------------------------------------------------------

tool("cde_projects_list", "Lists projects the token's user belongs to (code, name, root folder id).", {}, () =>
  call("GET", "/projects"),
);

tool("cde_members_list", "Lists project members with company and project-admin flag.", { projectId: pid }, (a) =>
  call("GET", `/projects/${a.projectId}/members`),
);

tool(
  "cde_member_add",
  "Adds an existing user (by e-mail) to a project. Project admins only.",
  { projectId: pid, email: z.string().email(), companyId: id("Company id").optional(), isProjectAdmin: z.boolean().default(false) },
  (a) => call("POST", `/projects/${a.projectId}/members`, { email: a.email, companyId: a.companyId, isProjectAdmin: a.isProjectAdmin }),
  { write: true },
);

tool("cde_companies_list", "Lists companies (for company-level folder permissions).", {}, () => call("GET", "/companies"));

tool(
  "cde_activity",
  "Recent audit log of a project (project admins only).",
  { projectId: pid, limit: z.number().int().min(1).max(500).default(100) },
  (a) => call("GET", `/projects/${a.projectId}/activity?limit=${a.limit}`),
);

// ---- Folders -------------------------------------------------------------------------

async function rootOf(projectId: string): Promise<string> {
  const p = await call<{ rootFolderId: string }>("GET", `/projects/${projectId}`);
  return p.rootFolderId;
}

tool(
  "cde_folder_contents",
  "Lists subfolders and files (latest version, size, uploader, IFC status) of a folder. Omit folderId for the project root.",
  { projectId: pid, folderId: id("Folder id").optional() },
  async (a) => call("GET", `/projects/${a.projectId}/folders/${a.folderId ?? (await rootOf(a.projectId))}/contents`),
);

tool(
  "cde_folder_tree",
  "Folder tree (names, ids, ISO 19650 state, naming standard, caller's level, number of files directly in each folder) down to a depth. Use cde_folder_contents to list the files.",
  { projectId: pid, folderId: id("Start folder id").optional(), depth: z.number().int().min(1).max(10).default(3) },
  async (a) => {
    type Node = {
      id: string;
      name: string;
      state: string | null;
      namingStandardId: string | null;
      myLevel?: string;
      fileCount?: number;
      children?: Node[];
    };
    const walk = async (fid: string, d: number): Promise<Node> => {
      const c = await call<{ folder: Node; folders: Node[]; files?: unknown[] }>("GET", `/projects/${a.projectId}/folders/${fid}/contents`);
      const node: Node = {
        id: c.folder.id,
        name: c.folder.name,
        state: c.folder.state,
        namingStandardId: c.folder.namingStandardId,
        myLevel: c.folder.myLevel,
        fileCount: c.files?.length ?? 0,
      };
      if (d > 0) node.children = await Promise.all(c.folders.map((f) => walk(f.id, d - 1)));
      return node;
    };
    return walk(a.folderId ?? (await rootOf(a.projectId)), a.depth);
  },
);

tool(
  "cde_folder_create",
  "Creates a subfolder (needs manage on the parent). Inherits the parent's permissions.",
  { projectId: pid, parentId: id("Parent folder id"), name: z.string().min(1) },
  (a) => call("POST", `/projects/${a.projectId}/folders`, { parentId: a.parentId, name: a.name }),
  { write: true },
);

tool(
  "cde_folder_update",
  "Renames a folder, sets its ISO 19650 state (wip/shared/published/archived) or binds a naming standard (null to unbind).",
  {
    projectId: pid,
    folderId: id("Folder id"),
    name: z.string().optional(),
    state: z.enum(["wip", "shared", "published", "archived"]).nullable().optional(),
    namingStandardId: z.string().uuid().nullable().optional(),
  },
  (a) =>
    call("PATCH", `/projects/${a.projectId}/folders/${a.folderId}`, { name: a.name, state: a.state, namingStandardId: a.namingStandardId }),
  { write: true },
);

tool(
  "cde_folder_permissions_get",
  "Who has which level on a folder, including inherited grants (needs manage).",
  { projectId: pid, folderId: id("Folder id") },
  (a) => call("GET", `/projects/${a.projectId}/folders/${a.folderId}/permissions`),
);

tool(
  "cde_folder_permissions_set",
  "Grants users or companies a level on a folder. mode add = only subjects without a direct grant; replace = overwrite. " +
    "A subfolder grant lower than the inherited one is rejected (as in Forma).",
  {
    projectId: pid,
    folderId: id("Folder id"),
    entries: z.array(z.object({ subjectType: z.enum(["user", "company"]), subjectId: z.string().uuid(), level })).min(1),
    mode: z.enum(["add", "replace"]).default("add"),
  },
  (a) => call("PUT", `/projects/${a.projectId}/folders/${a.folderId}/permissions`, { entries: a.entries, mode: a.mode }),
  { write: true },
);

// ---- Naming standards ----------------------------------------------------------------

tool("cde_naming_standards_list", "Naming standards of a project (fields, delimiter, allowed codes).", { projectId: pid }, (a) =>
  call("GET", `/projects/${a.projectId}/naming-standards`),
);

tool(
  "cde_naming_validate",
  "Checks file names against the naming standard that applies to a folder, without uploading.",
  { projectId: pid, folderId: id("Target folder id"), names: z.array(z.string().min(1)).min(1).max(1000) },
  (a) => call("POST", `/projects/${a.projectId}/naming/validate`, { folderId: a.folderId, names: a.names }),
);

// ---- Files ---------------------------------------------------------------------------

tool("cde_file_get", "File details with all versions, attributes and IFC summary.", { projectId: pid, fileId: id("File id") }, (a) =>
  call("GET", `/projects/${a.projectId}/files/${a.fileId}`),
);

tool(
  "cde_file_upload",
  "Uploads local files into a folder. Same name = new version. Names are checked against the folder's naming standard first. " +
    "IFC files are converted for the viewer automatically.",
  {
    projectId: pid,
    folderId: id("Target folder id"),
    paths: z.array(z.string().min(1)).min(1).max(50).describe("Absolute local file paths."),
    comment: z.string().optional().describe("Version comment."),
    attributes: z.record(z.string(), z.string()).optional().describe("Attributes, e.g. {\"Revizyon\": \"P02\"}."),
  },
  async (a) => {
    const form = new FormData();
    if (a.comment) form.append("comment", a.comment);
    if (a.attributes) form.append("attributes", JSON.stringify(a.attributes));
    for (const p of a.paths) {
      await stat(p);
      form.append("file", await openAsBlob(p), path.basename(p));
    }
    return call("POST", `/projects/${a.projectId}/folders/${a.folderId}/files`, form);
  },
  { write: true, local: true },
);

if (options.download) {
  const download = options.download;
  tool(
    "cde_file_download",
    "Downloads a file version to a local path.",
    { projectId: pid, versionId: id("Version id (from cde_file_get)"), outputPath: z.string().min(1) },
    async (a) => {
      const res = await download(`/projects/${a.projectId}/versions/${a.versionId}/download`);
      if (!res.ok || !res.body) throw new CdeError(`HTTP ${res.status}: ${await res.text()}`, res.status);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(a.outputPath));
      return { saved: a.outputPath, bytes: (await stat(a.outputPath)).size };
    },
    { local: true },
  );
}

tool(
  "cde_file_update",
  "Renames or moves a file, or merges attributes (needs edit). New names are checked against the naming standard.",
  {
    projectId: pid,
    fileId: id("File id"),
    name: z.string().optional(),
    folderId: z.string().uuid().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  },
  (a) => call("PATCH", `/projects/${a.projectId}/files/${a.fileId}`, { name: a.name, folderId: a.folderId, attributes: a.attributes }),
  { write: true },
);

tool("cde_models_list", "IFC model versions the user can open in the viewer, with element counts by class.", { projectId: pid }, (a) =>
  call("GET", `/projects/${a.projectId}/models`),
);

// ---- Issues --------------------------------------------------------------------------

const status = z.enum(["open", "in_progress", "in_review", "closed"]);
const priority = z.enum(["low", "normal", "high", "critical"]);

tool("cde_issues_list", "Lists issues (without snapshots).", { projectId: pid, status: status.optional() }, (a) =>
  call("GET", `/projects/${a.projectId}/issues${a.status ? `?status=${a.status}` : ""}`),
);

tool(
  "cde_issue_get",
  "Issue details including viewpoint (camera, models, selected GlobalIds).",
  { projectId: pid, issueId: id("Issue id") },
  async (a) => {
    const issue = await call<{ viewpoint?: { snapshot?: string } | null }>("GET", `/projects/${a.projectId}/issues/${a.issueId}`);
    if (issue.viewpoint?.snapshot) issue.viewpoint.snapshot = "(görüntü var — web arayüzünde)";
    return issue;
  },
);

tool(
  "cde_issue_create",
  "Creates an issue. For a 3D location pass pin.position (and globalId of the element if known).",
  {
    projectId: pid,
    title: z.string().min(1),
    description: z.string().optional(),
    priority: priority.optional(),
    type: z.string().optional(),
    assigneeUserId: z.string().uuid().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pin: z
      .object({
        position: z.tuple([z.number(), z.number(), z.number()]),
        fileVersionId: z.string().uuid().optional(),
        globalId: z.string().optional(),
      })
      .optional(),
  },
  (a) => {
    const { projectId, ...body } = a;
    return call("POST", `/projects/${projectId}/issues`, body);
  },
  { write: true },
);

tool(
  "cde_issue_update",
  "Updates status, priority, assignee, due date, title or description of an issue.",
  {
    projectId: pid,
    issueId: id("Issue id"),
    status: status.optional(),
    priority: priority.optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    dueDate: z.string().nullable().optional(),
  },
  (a) => {
    const { projectId, issueId, ...body } = a;
    return call("PATCH", `/projects/${projectId}/issues/${issueId}`, body);
  },
  { write: true },
);

tool("cde_issue_comments_list", "Comments of an issue.", { projectId: pid, issueId: id("Issue id") }, (a) =>
  call("GET", `/projects/${a.projectId}/issues/${a.issueId}/comments`),
);

tool(
  "cde_issue_comment_add",
  "Adds a comment to an issue.",
  { projectId: pid, issueId: id("Issue id"), body: z.string().min(1) },
  (a) => call("POST", `/projects/${a.projectId}/issues/${a.issueId}/comments`, { body: a.body }),
  { write: true },
);
}
