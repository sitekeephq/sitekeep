/**
 * cde_bcf_export / cde_bcf_import: BCF .bcfzip (2.1 / 3.0) for issues, through the REST layer
 * (POST /projects/:pid/bcf/export, /bcf/import/preview, /bcf/import). The hosted MCP endpoint
 * passes files as base64; the stdio server (localFiles) can also read and write local paths.
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { CdeCall } from "../core/types.js";

type Shape = Record<string, z.ZodType>;
export type BcfToolAdder = <S extends Shape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  o?: { write?: boolean; local?: boolean },
) => void;

/** Tool output is cut at about 60 000 characters: inline only what fits. */
const MAX_INLINE_BASE64 = 45_000;

interface ExportInfo {
  fileName: string;
  version: string;
  topics: number;
  size: number;
  downloadUrl: string;
  base64?: string;
  warnings: string[];
}

export function registerBcfTools(
  tool: BcfToolAdder,
  call: CdeCall,
  opts: { localFiles?: boolean; download?: (url: string) => Promise<Response> } = {},
): void {
  const pid = z.string().uuid().describe("Project id (from cde_projects_list).");
  const version = z.enum(["2.1", "3.0"]).default("2.1").describe("BCF version: 2.1 (default, most compatible: Navisworks, Revit plug-ins, BIMcollab, Solibri) or 3.0.");
  const local = !!opts.localFiles;

  tool(
    "cde_bcf_export",
    "Exports issues as a BCF .bcfzip (topics with comments, viewpoints in IFC coordinates and snapshots). " +
      "Select issues by id or by status / assigned-to-me (default: every issue). Returns the file name, a download link " +
      "(GET with the same token) and the file as base64 when it is small; set snapshots: false to keep it small." +
      (local ? " With outputPath the file is saved locally." : ""),
    {
      projectId: pid,
      version,
      issueIds: z.array(z.string().uuid()).max(2000).optional().describe("Issues to export (default: all matching the filters)."),
      status: z.enum(["open", "in_progress", "in_review", "closed"]).optional(),
      assignedToMe: z.boolean().optional(),
      snapshots: z.boolean().default(true).describe("Include snapshot images."),
      ...(local && { outputPath: z.string().min(1).optional().describe("Absolute local path for the .bcfzip.") }),
    },
    async (a) => {
      const args = a as typeof a & { outputPath?: string };
      const info = await call<ExportInfo>("POST", `/projects/${a.projectId}/bcf/export`, {
        version: a.version,
        issueIds: a.issueIds,
        status: a.status,
        assignedToMe: a.assignedToMe,
        snapshots: a.snapshots,
      });
      if (args.outputPath) {
        let bytes: Buffer;
        if (info.base64) bytes = Buffer.from(info.base64, "base64");
        else if (opts.download) {
          const res = await opts.download(info.downloadUrl.replace(/^\/api\/v1/, ""));
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          bytes = Buffer.from(await res.arrayBuffer());
        } else throw new Error("Dosya satır içi dönmeyecek kadar büyük; downloadUrl ile indirin.");
        await writeFile(args.outputPath, bytes);
        const { base64: _omit, ...rest } = info;
        return { ...rest, saved: args.outputPath };
      }
      if (info.base64 && info.base64.length > MAX_INLINE_BASE64) {
        const { base64: _omit, ...rest } = info;
        return { ...rest, note: "Dosya satır içi gösterilemeyecek kadar büyük: downloadUrl ile indirin ya da snapshots: false ile tekrar deneyin." };
      }
      return info;
    },
  );

  const mapping = z
    .object({
      statuses: z.record(z.string(), z.enum(["open", "in_progress", "in_review", "closed"])).optional().describe("BCF status → our status."),
      types: z.record(z.string(), z.string().nullable()).optional().describe("BCF topic type → our type text (null = none)."),
      priorities: z.record(z.string(), z.enum(["low", "normal", "high", "critical"])).optional(),
      users: z.record(z.string(), z.string().uuid().nullable()).optional().describe("E-mail (lower case) → project member id, null = unmatched."),
      files: z.record(z.string(), z.string().uuid().nullable()).optional().describe("Header file key (from the preview) → model version id."),
      conflicts: z.enum(["keep", "overwrite"]).optional().describe("Topics changed both here and in the file: keep ours (default) or overwrite."),
      topics: z.array(z.string()).optional().describe("Import only these topic GUIDs."),
    })
    .optional();

  tool(
    "cde_bcf_import",
    "Imports a BCF .bcfzip (2.0 / 2.1 / 3.0) into the project's issues, idempotent by topic GUID. Run with commit: false first " +
      "(default): returns a preview (new / update / unchanged / conflict per topic, suggested status / type / priority / user / model mappings). " +
      "Then call again with commit: true and an optional mapping. Confirm with the user before committing." +
      (local ? " Pass a local path or the file as base64." : " Pass the file as base64."),
    {
      projectId: pid,
      base64: z.string().min(1).optional().describe("The .bcfzip file, base64-encoded."),
      ...(local && { path: z.string().min(1).optional().describe("Absolute local path of the .bcfzip.") }),
      fileName: z.string().max(200).optional(),
      commit: z.boolean().default(false).describe("false: preview only; true: create / update issues."),
      mapping,
    },
    async (a) => {
      const args = a as typeof a & { path?: string };
      let data = a.base64;
      let fileName = a.fileName;
      if (args.path) {
        data = (await readFile(args.path)).toString("base64");
        fileName ??= args.path.split(/[\\/]/).pop();
      }
      if (!data) throw new Error(local ? "path ya da base64 gerekli." : "base64 gerekli.");
      const url = `/projects/${a.projectId}/bcf/import${a.commit ? "" : "/preview"}`;
      return call("POST", url, { fileName, data, ...(a.commit && a.mapping && { mapping: a.mapping }) });
    },
    { write: true },
  );
}
