/**
 * In-browser viewers: preview status and derivatives of a version.
 *   GET  /projects/:pid/versions/:vid/preview          viewer kind + derivative statuses (queues missing ones)
 *   GET  /projects/:pid/versions/:vid/preview/:kind    the derivative (pdf | sheet JSON | dxf | scene | text);
 *                                                      scene: gzip container, ETag, ?space=model for model space only
 *   POST /projects/:pid/versions/:vid/preview/:kind    build on demand / retry
 *   GET  /projects/:pid/versions/:vid/pdf              PDF for the PDF viewer: the file itself or its office PDF
 *   GET  /projects/:pid/versions/:vid/media            inline content with Range (images, video, audio, text, DXF, office)
 *   GET  /admin/converters                             office → PDF converter and LibreDWG status (administrators)
 * All need view permission on the file only (like /content); nothing here is a download.
 */
import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  PREVIEW_KINDS,
  can,
  splitExtension,
  viewerFor,
  type PreviewDto,
  type PreviewKind,
  type PreviewMeta,
  type ConvertersStatusDto,
  type VersionPreviewDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { versionPreviews, versionTexts } from "../db/schema.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { officePdfAvailable, previewsOf, queuePreview, registerPreviewJobs, sceneWanted } from "../previews/service.js";
import { loadVersion, requireView } from "../modules/documents/files.js";
import { msg, requestLanguage } from "../i18n/index.js";

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};
/** Viewers whose original file is served by /media (text kinds as text/plain; office files are rendered in the browser). */
const MEDIA_VIEWERS = new Set(["image", "video", "audio", "text", "markdown", "email", "cad", "sheet", "document", "slides"]);

const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

function inlineHeaders(reply: FastifyReply, name: string, type: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  reply.header("Content-Disposition", `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header("Content-Type", type);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", SANDBOX);
  reply.header("Cache-Control", "private, max-age=3600");
}

/** Storage keys stay on the server. */
function publicMeta(meta: PreviewMeta): PreviewMeta {
  const { sceneModelKey: _key, ...rest } = meta;
  return rest;
}

function parseKind(raw: string): PreviewKind {
  if (!(PREVIEW_KINDS as readonly string[]).includes(raw)) throw notFound(msg("previews:entities.preview"));
  return raw as PreviewKind;
}

export async function previewRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage, jobs, converters, office } = deps;
  registerPreviewJobs(jobs, { db, storage, converters, office, log: (m, e) => api.log.warn({ e }, m) });

  async function dto(pid: string, vid: string, user: NonNullable<import("fastify").FastifyRequest["user"]>, lang: string): Promise<VersionPreviewDto> {
    const { a, file, version, tree } = await loadVersion(db, pid, vid, user);
    requireView(tree, a, file);
    const spec = viewerFor(file.name, lang);
    let rows = await previewsOf(db, version.id);
    // Versions uploaded before the viewers (or whose job was lost) are queued when first opened.
    const missing = spec.previews.filter((k) => !rows.some((r) => r.kind === k));
    // Drawings converted before the prebuilt 2D scene existed get it now.
    const dxf = rows.find((r) => r.kind === "dxf");
    if (dxf?.status === "ready" && sceneWanted(dxf.meta) && !rows.some((r) => r.kind === "scene")) missing.push("scene");
    if (missing.length) {
      for (const k of missing) await queuePreview(db, jobs, version.id, k);
      rows = await previewsOf(db, version.id);
    }
    const perm = tree.permission(a.principal, file.folderId);
    const previews: PreviewDto[] = rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      error: r.status === "unavailable" ? null : r.error,
      hint: r.status === "unavailable" ? r.error : null,
      meta: publicMeta(r.meta),
      updatedAt: r.updatedAt.toISOString(),
    }));
    const requestable = [...spec.previews, ...spec.onDemand];
    return {
      versionId: version.id,
      fileId: file.id,
      folderId: file.folderId,
      fileName: file.name,
      extension: splitExtension(file.name).extension.toLowerCase(),
      version: version.version,
      currentVersion: file.currentVersion,
      size: version.size,
      uploadedAt: version.uploadedAt.toISOString(),
      viewer: spec.kind,
      viewerLabel: spec.label,
      previews,
      canRequest: requestable.filter((k) => {
        const s = previews.find((p) => p.kind === k)?.status;
        return !s || s === "failed" || s === "unavailable";
      }),
      canDownload: can(perm.level, "download") || (perm.canUpload && file.createdBy === a.user.id),
      pdfConverter: await officePdfAvailable(office),
    };
  }

  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/preview", async (req) =>
    dto(req.params.pid, req.params.vid, req.user!, requestLanguage(req)),
  );

  api.post<{ Params: { pid: string; vid: string; kind: string } }>("/projects/:pid/versions/:vid/preview/:kind", async (req) => {
    const kind = parseKind(req.params.kind);
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const spec = viewerFor(file.name);
    if (![...spec.previews, ...spec.onDemand].includes(kind)) throw badRequest(msg("previews:errors.notForFile"));
    const [row] = await db
      .select({ status: versionPreviews.status })
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, version.id), eq(versionPreviews.kind, kind)));
    if (!row || row.status === "failed" || row.status === "unavailable") await queuePreview(db, jobs, version.id, kind);
    return dto(req.params.pid, req.params.vid, req.user!, requestLanguage(req));
  });

  api.get<{ Params: { pid: string; vid: string; kind: string }; Querystring: { space?: string } }>("/projects/:pid/versions/:vid/preview/:kind", async (req, reply) => {
    const kind = parseKind(req.params.kind);
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const [row] = await db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, version.id), eq(versionPreviews.kind, kind)));
    if (!row || row.status !== "ready") throw conflict(msg("previews:errors.notReady", { status: row?.status ?? msg("previews:status.none") }));
    const base = splitExtension(file.name).base;
    if (kind === "text") {
      const [t] = await db.select().from(versionTexts).where(eq(versionTexts.versionId, version.id));
      inlineHeaders(reply, `${base}.txt`, "text/plain; charset=utf-8");
      return reply.send(t?.content ?? "");
    }
    if (kind === "dxf" && row.meta.original) {
      inlineHeaders(reply, file.name, "application/octet-stream");
      reply.header("Content-Length", String(version.size));
      return reply.send(storage.get(version.storageKey));
    }
    if (!row.storageKey) throw conflict(msg("previews:errors.noFile"));
    if (kind === "scene") {
      // The prebuilt 2D scene: gzip as stored (the browser inflates it natively). A rebuild gets a new
      // storage key, so the key is the ETag; the browser revalidates and gets 304 while it holds.
      const key = req.query.space === "model" && row.meta.sceneModelKey ? row.meta.sceneModelKey : row.storageKey;
      const etag = `"${key.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
      inlineHeaders(reply, `${base}.7dscene`, "application/octet-stream");
      reply.header("Cache-Control", "private, no-cache");
      reply.header("ETag", etag);
      reply.header("Vary", "Accept-Encoding");
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      const scene = row.meta.scene;
      const bytes = key === row.storageKey ? scene?.bytes : scene?.model?.bytes;
      if (bytes) reply.header("X-Scene-Bytes", String(bytes));
      reply.header("Content-Encoding", "gzip");
      reply.header("Content-Length", String(await storage.size(key)));
      return reply.send(storage.get(key));
    }
    if (kind === "pdf") inlineHeaders(reply, `${base}.pdf`, "application/pdf");
    else if (kind === "sheet") {
      inlineHeaders(reply, `${base}.json`, "application/json; charset=utf-8");
      reply.header("Content-Encoding", "gzip");
    } else inlineHeaders(reply, `${base}.dxf`, "application/octet-stream");
    reply.header("Content-Length", String(await storage.size(row.storageKey)));
    return reply.send(storage.get(row.storageKey));
  });

  /** PDF for the PDF viewer (markups work on office files through their PDF). */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/pdf", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const ext = splitExtension(file.name).extension.toLowerCase();
    if (ext === "pdf") {
      inlineHeaders(reply, file.name, "application/pdf");
      reply.header("Content-Length", String(version.size));
      return reply.send(storage.get(version.storageKey));
    }
    const [row] = await db
      .select()
      .from(versionPreviews)
      .where(and(eq(versionPreviews.versionId, version.id), eq(versionPreviews.kind, "pdf")));
    if (!row) throw notFound(msg("previews:entities.pdfPreview"));
    if (row.status !== "ready" || !row.storageKey) throw conflict(msg("previews:errors.pdfNotReady", { status: row.status }));
    inlineHeaders(reply, `${splitExtension(file.name).base}.pdf`, "application/pdf");
    reply.header("Content-Length", String(await storage.size(row.storageKey)));
    return reply.send(storage.get(row.storageKey));
  });

  /** Original content for the simple viewers, with byte ranges (video seeking). */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/media", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    const ext = splitExtension(file.name).extension.toLowerCase();
    const spec = viewerFor(file.name);
    if (!MEDIA_VIEWERS.has(spec.kind)) throw new HttpError(415, "unsupported", msg("previews:errors.unsupportedType"));
    const binary = spec.kind === "cad" || spec.kind === "sheet" || spec.kind === "document" || spec.kind === "slides";
    const type = MEDIA_TYPES[ext] ?? (binary ? "application/octet-stream" : "text/plain; charset=utf-8");
    inlineHeaders(reply, file.name, type);
    reply.header("Accept-Ranges", "bytes");
    const size = version.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        reply.header("Content-Range", `bytes */${size}`);
        return reply.status(416).send();
      }
      start = Math.max(0, start);
      reply.status(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(storage.localPath(version.storageKey), { start, end }));
    }
    reply.header("Content-Length", String(size));
    return reply.send(storage.get(version.storageKey));
  });

  api.get("/admin/converters", async (req): Promise<ConvertersStatusDto> => {
    if (!req.user?.isAdmin) throw forbidden(msg("previews:errors.adminOnly"));
    return { ...converters.status(), office: (await office.status(requestLanguage(req))).converter };
  });
}
