/**
 * OpenCDE Documents API 1.0 helpers shared by the API (documents.ts) and the CDE pages
 * (pages.ts): access rules, callback rules, server_context, DocumentVersion objects.
 */
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq, inArray, lt } from "drizzle-orm";
import { documentsScopeAccess, splitExtension, type DocumentsAccess, projectPath } from "@sitekeep/shared";
import type { AuthUser, FolderTree } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import { oauthClients, opencdeDocSessionFiles, opencdeDocSessions, opencdeUploadParts } from "../db/schema.js";
import type { FileRow, VersionRow } from "../files/new-version.js";
import { HttpError, forbidden, notFound } from "../core/platform/http.js";
import { publicBaseUrl, type ResolvedOAuthOptions } from "../oauth/config.js";
import { isLoopbackUri, matchRegisteredRedirect } from "../oauth/redirect.js";
import type { Storage } from "../core/platform/storage.js";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

export type DocSessionRow = typeof opencdeDocSessions.$inferSelect;
export type DocSessionFileRow = typeof opencdeDocSessionFiles.$inferSelect;

export const DOCUMENTS_VERSION = "1.0";

/** https://cde.firma.local/documents/1.0 (api_base_url in /foundation/versions). */
export function documentsBase(opts: ResolvedOAuthOptions, req: FastifyRequest): string {
  return `${publicBaseUrl(opts, req)}/documents/${DOCUMENTS_VERSION}`;
}

export const newKey = () => randomBytes(32).toString("base64url");

export const unauthorized = () => new HttpError(401, "unauthorized", msg("opencde:errors.bearerRequired"));
/** 410: the session, the page link or the application's wait for the callback ran out. */
export const expired = (what: "session" | "link" | "callback") => new HttpError(410, "expired", msg(`opencde:errors.expired.${what}`));

/**
 * The caller of a Documents API endpoint: a Bearer token (OAuth `documents` / `documents:read`,
 * or a personal API token: read → select/download, write → also upload). Browser cookies are not
 * accepted (the endpoints allow any origin).
 */
export function requireDocumentsAccess(req: FastifyRequest, need: DocumentsAccess): AuthUser {
  const user = req.user;
  const token = user?.token;
  if (!user || !token || token.kind === "session" || !req.headers.authorization?.startsWith("Bearer ")) throw unauthorized();
  const access = token.kind === "oauth" ? documentsScopeAccess(token.oauthScopes ?? []) : token.scope;
  if (!access) throw forbidden(msg("opencde:errors.noDocumentsScope"));
  if (need === "write" && access !== "write")
    throw forbidden(msg("opencde:errors.readOnlyScope"));
  return user;
}

/**
 * Why the callback URL cannot be used, or null. OAuth clients: a registered redirect URI (exact),
 * or for native clients with a loopback registration any loopback http address (RFC 8252: the
 * tool listens on a free port of the user's machine). Personal API tokens: loopback only.
 * Never an arbitrary web address (no open redirect).
 */
export async function callbackProblem(db: Db, user: AuthUser, url: string): Promise<Msg | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return msg("opencde:errors.callbackInvalid");
  }
  if (url.length > 2000) return msg("opencde:errors.callbackTooLong");
  if (u.hash || url.includes("#") || u.username || u.password) return msg("opencde:errors.callbackParts");
  const clientId = user.token?.oauthClientId;
  if (!clientId) return isLoopbackUri(u) ? null : msg("opencde:errors.callbackLoopbackOnly");
  const [client] = await db.select({ redirectUris: oauthClients.redirectUris }).from(oauthClients).where(eq(oauthClients.id, clientId));
  if (!client) return msg("opencde:errors.clientNotFound");
  if (matchRegisteredRedirect(client.redirectUris, url)) return null;
  const nativeClient = client.redirectUris.some((r) => {
    try {
      return isLoopbackUri(new URL(r));
    } catch {
      return false;
    }
  });
  if (nativeClient && isLoopbackUri(u)) return null;
  return msg("opencde:errors.callbackNotRegistered");
}

/** Host the browser returns to, for the pages. */
export function callbackTarget(url: string, lang: string = DEFAULT_LANGUAGE): string {
  try {
    const u = new URL(url);
    return isLoopbackUri(u) ? render(lang, msg("opencde:thisComputer", { host: `${u.hostname}:${u.port || "80"}` })) : u.host || u.protocol.slice(0, -1);
  } catch {
    return url;
  }
}

/** server_context: opaque to clients; here the project and folder the user last worked in. */
export function encodeContext(projectId: string | null, folderId: string | null): string | null {
  if (!projectId) return null;
  return `7d1.${Buffer.from(JSON.stringify({ p: projectId, f: folderId ?? null })).toString("base64url")}`;
}

export function decodeContext(value: string | null | undefined): { projectId: string | null; folderId: string | null } {
  const none = { projectId: null, folderId: null };
  if (!value?.startsWith("7d1.")) return none;
  try {
    const o = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8")) as { p?: unknown; f?: unknown };
    const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
    return { projectId: uuid(o.p), folderId: uuid(o.f) };
  } catch {
    return none;
  }
}

/** Session started by this token's user and client (404 otherwise); 410 when it expired. */
export async function loadApiSession(db: Db, id: string, user: AuthUser, kind: DocSessionRow["kind"]): Promise<DocSessionRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(msg("opencde:entities.session"));
  const [s] = await db.select().from(opencdeDocSessions).where(eq(opencdeDocSessions.id, id));
  if (!s || s.kind !== kind || s.userId !== user.id || (s.oauthClientId ?? null) !== (user.token?.oauthClientId ?? null)) throw notFound(msg("opencde:entities.session"));
  if (s.expiresAt.getTime() <= Date.now()) throw expired("session");
  return s;
}

/** Version label for clients ("v3"). */
export const versionNumber = (n: number) => `v${n}`;

/** DocumentVersion (documents-API swagger): links, version, title, file description, document_id. */
export function documentVersionDto(api: string, web: string, file: FileRow, version: VersionRow) {
  const doc = `${api}/documents/${file.id}`;
  return {
    links: {
      document_version: { url: `${doc}/versions/${version.version}` },
      document_version_metadata: { url: `${doc}/versions/${version.version}/metadata` },
      document_version_download: { url: `${doc}/versions/${version.version}/download` },
      document_versions: { url: `${doc}/versions` },
      document_details: { url: `${web}${projectPath(file.projectId, `files/${file.folderId}?file=${file.id}`)}` },
    },
    version_number: versionNumber(version.version),
    version_index: version.version,
    creation_date: version.uploadedAt.toISOString(),
    title: splitExtension(file.name).base || file.name,
    file_description: { name: file.name, size_in_bytes: version.size },
    document_id: file.id,
  };
}

export type MetadataEntry = { name: string; value: string[]; data_type: "string" | "date-time" | "date" | "integer64" | "number" | "url" };

const METADATA_LABELS = {
  project: "opencde:metadata.project",
  folder: "opencde:metadata.folder",
  fileName: "opencde:metadata.fileName",
  version: "opencde:metadata.version",
  uploadedBy: "opencde:metadata.uploadedBy",
  uploadedAt: "opencde:metadata.uploadedAt",
  size: "opencde:metadata.size",
  description: "opencde:metadata.description",
} as const;

/** DocumentMetadata entries (names in the reader's language): CDE fields plus the file attributes (typed when defined). */
export function metadataEntries(
  file: FileRow,
  version: VersionRow,
  tree: FolderTree,
  extras: { projectName: string; uploadedByName: string | null; attributeTypes: Map<string, string> },
  lang: string = DEFAULT_LANGUAGE,
): MetadataEntry[] {
  const label = (key: keyof typeof METADATA_LABELS) => render(lang, msg(METADATA_LABELS[key]));
  const out: MetadataEntry[] = [];
  const add = (name: string, value: string | null | undefined, data_type: MetadataEntry["data_type"] = "string") => {
    if (value !== null && value !== undefined && value !== "") out.push({ name, value: [value], data_type });
  };
  add(label("project"), extras.projectName);
  add(
    label("folder"),
    tree
      .ancestry(file.folderId)
      .map((id) => tree.get(id).name)
      .join(" / "),
  );
  add(label("fileName"), file.name);
  add(label("version"), String(version.version), "integer64");
  add(label("uploadedBy"), extras.uploadedByName);
  add(label("uploadedAt"), version.uploadedAt.toISOString(), "date-time");
  add(label("size"), String(version.size), "integer64");
  add("SHA-256", version.sha256);
  add(label("description"), version.comment);
  for (const [k, v] of Object.entries(file.attributes)) {
    const t = extras.attributeTypes.get(k);
    add(k, v, t === "date" ? "date" : t === "number" ? "number" : "string");
  }
  return out;
}

/** Removes parts (storage objects and rows) of session files. */
export async function dropParts(db: Db, storage: Storage, fileRowIds: string[]): Promise<void> {
  if (!fileRowIds.length) return;
  const parts = await db.select().from(opencdeUploadParts).where(inArray(opencdeUploadParts.fileRowId, fileRowIds));
  for (const p of parts) await storage.remove(p.storageKey).catch(() => undefined);
  await db.delete(opencdeUploadParts).where(inArray(opencdeUploadParts.fileRowId, fileRowIds));
}

/** Expired sessions: parts removed, rows deleted (kept for an hour after expiry for late errors). */
export async function purgeExpiredSessions(db: Db, storage: Storage): Promise<void> {
  const old = await db
    .select({ id: opencdeDocSessions.id })
    .from(opencdeDocSessions)
    .where(lt(opencdeDocSessions.expiresAt, new Date(Date.now() - 3600_000)));
  if (!old.length) return;
  const ids = old.map((s) => s.id);
  const rows = await db.select({ id: opencdeDocSessionFiles.id }).from(opencdeDocSessionFiles).where(inArray(opencdeDocSessionFiles.sessionId, ids));
  await dropParts(
    db,
    storage,
    rows.map((r) => r.id),
  );
  await db.delete(opencdeDocSessions).where(and(inArray(opencdeDocSessions.id, ids)));
}
