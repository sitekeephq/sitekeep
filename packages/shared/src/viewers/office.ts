/**
 * Office integration (optional plug-ins, set by the system administrator):
 * - editing in the browser through WOPI (ONLYOFFICE Docs or Collabora Online)
 * - server-side office → PDF conversion (ONLYOFFICE, Collabora, Gotenberg; local soffice as a last resort)
 * See docs/features/OFFICE_INTEGRATION.md.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "../platform/i18n.js";
import type { ConvertersDto } from "./viewers.js";

export type OfficeEditorKind = "none" | "onlyoffice" | "collabora";
export const OFFICE_EDITOR_KINDS: readonly OfficeEditorKind[] = ["none", "onlyoffice", "collabora"];

/**
 * auto: the editor server when one is set, else local soffice when installed.
 * none: no conversion (office PDFs stay "unavailable").
 */
export type OfficeConverterKind = "auto" | "none" | "onlyoffice" | "collabora" | "gotenberg" | "local";
export const OFFICE_CONVERTER_KINDS: readonly OfficeConverterKind[] = ["auto", "none", "onlyoffice", "collabora", "gotenberg", "local"];

/** Name of an editor kind ("ONLYOFFICE Docs"; "none" in `lang`). */
export function officeEditorLabel(kind: OfficeEditorKind, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `office.editors.${kind}`);
}

/** Name of a converter kind ("Gotenberg"; "auto", "none", "local" in `lang`). */
export function officeConverterLabel(kind: OfficeConverterKind, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `office.converters.${kind}`);
}

/** Limits of the converter (admin settings). */
export interface OfficeConvertLimits {
  /** One conversion may take this long (seconds). */
  timeoutSec: number;
  /** Larger files are not sent to the converter (MB). */
  maxFileMb: number;
  /** Conversions running at the same time. */
  concurrency: number;
  /** Retries after a network error or a 5xx answer. */
  retries: number;
}

/** Admin view of the settings; secrets are never returned, only whether they are set. */
export interface OfficeSettingsDto {
  editor: {
    kind: OfficeEditorKind;
    /** Address the CDE server uses (discovery, conversion), e.g. http://onlyoffice. */
    url: string | null;
    /** Address the browser uses when different (e.g. https://office.example.com). */
    publicUrl: string | null;
    /** Check X-WOPI-Proof signatures with the discovery public key. */
    verifyProof: boolean;
  };
  converter: {
    kind: OfficeConverterKind;
    /** Converter address; empty = the editor address when the kinds match. */
    url: string | null;
  } & OfficeConvertLimits;
  /** CDE address as the editor/converter server reaches it (WOPISrc, conversion source). */
  wopiBaseUrl: string | null;
  /** Lifetime of one editor access token (minutes). */
  tokenTtlMinutes: number;
  hasJwtSecret: boolean;
  hasGotenbergAuth: boolean;
  /** Values that come from environment variables (shown read-only hints in the admin page). */
  fromEnv: string[];
}

export interface OfficeSettingsInput {
  editor?: Partial<OfficeSettingsDto["editor"]>;
  converter?: Partial<OfficeSettingsDto["converter"]>;
  wopiBaseUrl?: string | null;
  tokenTtlMinutes?: number;
  /** ONLYOFFICE JWT secret: undefined keeps, "" or null removes. */
  jwtSecret?: string | null;
  /** Gotenberg basic auth "user:password": undefined keeps, "" or null removes. */
  gotenbergAuth?: string | null;
}

export interface OfficeCheckStep {
  name: string;
  ok: boolean;
  message: string;
}

/** "Bağlantıyı test et" result. */
export interface OfficeTestResultDto {
  ok: boolean;
  latencyMs: number;
  steps: OfficeCheckStep[];
}

/** Effective status (admin page and /admin/converters). */
export interface OfficeStatusDto {
  editor: {
    kind: OfficeEditorKind;
    label: string;
    configured: boolean;
    /** Extensions with an edit action in the editor's discovery. */
    editExtensions: string[];
    viewExtensions: string[];
    proofKey: boolean;
    error: string | null;
  };
  converter: {
    kind: Exclude<OfficeConverterKind, "auto"> | null;
    label: string;
    /** "auto" resolved to this provider. */
    auto: boolean;
    available: boolean;
    message: string;
  };
}

/** Office edit state of a file (file drawer). */
export interface FileOfficeDto {
  /** An editor is configured and the extension has an edit action. */
  editable: boolean;
  /** The caller may save new versions from the editor. */
  canEdit: boolean;
  /** Why editing is not possible (shown as a tooltip). */
  reason: string | null;
  editor: { kind: OfficeEditorKind; label: string } | null;
  /** The file is open for editing (WOPI lock). */
  lock: { userId: string | null; userName: string | null; since: string; expiresAt: string } | null;
  /** Version id of the current version (the drawer reloads when it changes). */
  currentVersionId: string;
}

/** Editor session for the host page (form POST into the iframe). */
export interface OfficeSessionDto {
  mode: "edit" | "view";
  editor: OfficeEditorKind;
  editorLabel: string;
  actionUrl: string;
  accessToken: string;
  /** Expiry of the token, milliseconds since the epoch (WOPI access_token_ttl). */
  accessTokenTtl: number;
  fileId: string;
  fileName: string;
  folderId: string;
  versionId: string;
  favIconUrl: string | null;
  /** Origin of the editor (for postMessage checks). */
  editorOrigin: string;
}

/** GET /admin/converters: local tools plus the effective office → PDF converter. */
export interface ConvertersStatusDto extends ConvertersDto {
  office: OfficeStatusDto["converter"];
}
