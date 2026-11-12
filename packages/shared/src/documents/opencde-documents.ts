/**
 * OpenCDE Documents API 1.0 (https://github.com/buildingSMART/documents-API, docs/features/OPENCDE.md):
 * scope rules, limits and the DTOs of the two CDE pages an authoring tool opens in the browser,
 * "Dış Uygulamadan Yükleme" (upload) and "Dış Uygulama İçin Belge Seç" (select).
 */
import type { EffectiveAttributeDto } from "../kernel/attributes.js";
import type { NamingStandard } from "../kernel/naming.js";
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";

/** What a token may do with the Documents API: select/download (read) or also upload (write). */
export type DocumentsAccess = "read" | "write";

/**
 * OAuth scopes → Documents API access: `documents` uploads and reads (authoring tools such as AEC
 * Pilot ask for exactly this scope), `documents:read` only selects and downloads. The /api/v1
 * scopes (read, write) give no Documents API access.
 */
export function documentsScopeAccess(scopes: readonly string[]): DocumentsAccess | null {
  if (scopes.includes("documents")) return "write";
  if (scopes.includes("documents:read")) return "read";
  return null;
}

export const OPENCDE_DOCS_LIMITS = {
  /** The browser page link (upload_ui_url / select_documents_url) must be opened within this time. */
  uiSeconds: 600,
  /** Longest callback lifetime the CDE accepts (callback.expires_in is capped to it). */
  callbackMaxSeconds: 24 * 3600,
  /** Upload instructions, parts and completion; selection results: valid this long after the page. */
  sessionSeconds: 24 * 3600,
  /** Size of one upload part (the last one is shorter). */
  partBytes: 16 * 1024 * 1024,
  /** Files in one upload session, documents in one selection. */
  maxFiles: 50,
  maxSelected: 200,
} as const;

export type OpenCdeSessionKind = "upload" | "select";
/** pending: page not finished · ready: user finished the page · completed / cancelled: closed. */
export type OpenCdeSessionStatus = "pending" | "ready" | "completed" | "cancelled";

/**
 * ISO 19650 suitability codes for "Durum / Uygunluk" (stored as the file attribute "Uygunluk"
 * unless the project defines its own attribute of that name). The code is stored, not the label.
 */
export const SUITABILITY_CODES = ["S0", "S1", "S2", "S3", "S4", "A", "B"] as const;

/** Suitability choices with their labels in the reader's language ("S2 · Bilgi İçin"). */
export function suitabilityOptions(lang: string = SHARED_DEFAULT_LANGUAGE): { code: string; label: string }[] {
  return SUITABILITY_CODES.map((code) => ({ code, label: sharedText(lang, `documents.suitability.${code}`) }));
}

/** Attribute keys the upload page writes for the fixed fields. */
export const OPENCDE_REVISION_KEY = "Revizyon";
export const OPENCDE_SUITABILITY_KEY = "Uygunluk";

/** An incoming file on the upload page. */
export interface OpenCdeSessionFileDto {
  /** Row id in the CDE (not the client's session_file_id). */
  id: string;
  sessionFileId: string;
  /** Name the application sent. */
  fileName: string;
  /** Name chosen on the page (null until the page is sent). */
  targetName: string | null;
  /** New version of an existing document (document_id was sent). */
  existing: { fileId: string; name: string; projectId: string; folderId: string; folderPath: string; version: number } | null;
  /** The document_id could not be resolved for this user. */
  existingError: string | null;
}

export interface OpenCdeSessionDto {
  kind: OpenCdeSessionKind;
  status: OpenCdeSessionStatus;
  /** Requesting application (OAuth client name or the API token name). */
  client: { name: string; description: string | null };
  /** Where the browser returns: host, "(bu bilgisayar)" for loopback. */
  callbackTarget: string;
  expiresAt: string;
  files: OpenCdeSessionFileDto[];
  /** select: extensions the application prefers (".ifc"); a hint, not a filter guarantee. */
  supportedExtensions: string[];
  /** server_context of an earlier exchange: where to open the page. */
  context: { projectId: string | null; folderId: string | null };
  maxSizeInBytes: number;
}

/** A folder of the chosen project, flat with its path (both pages). */
export interface OpenCdeFolderDto {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  /** The user may upload here (upload page lists only these as targets). */
  canUpload: boolean;
  /** The user may see the files here. */
  canView: boolean;
}

/** Rules of the chosen target folder: naming standard (checked live), attributes, review gate. */
export interface OpenCdeUploadRulesDto {
  standard: NamingStandard | null;
  attributes: EffectiveAttributeDto[];
  /** Direct uploads are closed (only approved reviews publish here). */
  gateMessage: string | null;
}

export interface OpenCdeUploadInput {
  projectId: string;
  folderId: string;
  comment?: string | null;
  revision?: string | null;
  suitability?: string | null;
  attributes?: Record<string, string>;
  /** Names per incoming file (row id → name); new versions keep their existing name. */
  names: Record<string, string>;
}

/** A document version in the select page lists. */
export interface OpenCdeDocumentRowDto {
  fileId: string;
  versionId: string;
  name: string;
  folderId: string;
  folderPath: string;
  version: number;
  size: number;
  uploadedAt: string;
  uploadedByName: string | null;
  canDownload: boolean;
}

/** After the page: the browser goes to the application's callback with the result parameter. */
export interface OpenCdeRedirectDto {
  redirectTo: string;
}

/**
 * One-click registration of AEC Pilot (Revit / Civil 3D "CDE'ye Gönder") in Yönetim → OAuth
 * Uygulamaları: public client (PKCE), loopback redirect on any port, the `documents` scope.
 */
export const AECPILOT_OAUTH_PRESET = {
  name: "AEC Pilot",
  description: "Revit / Civil 3D eklentisi: CDE'ye Gönder ve CDE'den Seç (OpenCDE Documents API).", // i18n-ok: stored as the registered client's description (data)
  type: "public" as const,
  redirectUris: ["http://127.0.0.1/aecpilot/opencde/oauth"],
  scopes: ["documents" as const],
};
