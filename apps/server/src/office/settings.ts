/**
 * Office integration settings ("office.integration" in system_settings). Order: defaults,
 * then environment variables (docker-compose profiles), then what the administrator saved.
 * Secrets (ONLYOFFICE JWT, Gotenberg basic auth) are encrypted at rest like AI keys (secrets.ts).
 */
import {
  OFFICE_CONVERTER_KINDS,
  OFFICE_EDITOR_KINDS,
  type OfficeConverterKind,
  type OfficeEditorKind,
  type OfficeSettingsDto,
} from "@sitekeep/shared";
import { getSetting } from "../ai/settings.js";
import type { Db } from "../db/index.js";
import { decryptSecret } from "../core/platform/secrets.js";

export const OFFICE_SETTINGS_KEY = "office.integration";

export interface StoredOfficeSettings {
  editor?: { kind?: OfficeEditorKind; url?: string | null; publicUrl?: string | null; verifyProof?: boolean };
  converter?: {
    kind?: OfficeConverterKind;
    url?: string | null;
    timeoutSec?: number;
    maxFileMb?: number;
    concurrency?: number;
    retries?: number;
  };
  wopiBaseUrl?: string | null;
  tokenTtlMinutes?: number;
  jwtSecretEnc?: string | null;
  gotenbergAuthEnc?: string | null;
}

export interface OfficeConfig {
  editor: { kind: OfficeEditorKind; url: string | null; publicUrl: string | null; verifyProof: boolean };
  converter: {
    kind: OfficeConverterKind;
    url: string | null;
    timeoutSec: number;
    maxFileMb: number;
    concurrency: number;
    retries: number;
  };
  wopiBaseUrl: string | null;
  tokenTtlMinutes: number;
  jwtSecret: string | null;
  gotenbergAuth: string | null;
  fromEnv: string[];
}

export const TOKEN_TTL_MAX_MINUTES = 24 * 60;

const trimUrl = (u: string | null | undefined) => (u ? u.trim().replace(/\/+$/, "") || null : null);

export function officeDefaults(env: NodeJS.ProcessEnv = process.env): OfficeConfig {
  const fromEnv: string[] = [];
  const pick = <T>(name: string, value: T | undefined, fallback: T): T => {
    if (value === undefined || value === "" || value === null) return fallback;
    fromEnv.push(name);
    return value;
  };
  const editorKind = env.CDE_OFFICE_EDITOR?.trim().toLowerCase() as OfficeEditorKind | undefined;
  const converterKind = env.CDE_OFFICE_CONVERTER?.trim().toLowerCase() as OfficeConverterKind | undefined;
  const timeoutMs = Number(env.CDE_CONVERT_TIMEOUT_MS);
  return {
    editor: {
      kind: pick("CDE_OFFICE_EDITOR", editorKind && OFFICE_EDITOR_KINDS.includes(editorKind) ? editorKind : undefined, "none"),
      url: pick("CDE_OFFICE_EDITOR_URL", trimUrl(env.CDE_OFFICE_EDITOR_URL), null),
      publicUrl: pick("CDE_OFFICE_EDITOR_PUBLIC_URL", trimUrl(env.CDE_OFFICE_EDITOR_PUBLIC_URL), null),
      verifyProof: env.CDE_WOPI_VERIFY_PROOF === "0" ? (fromEnv.push("CDE_WOPI_VERIFY_PROOF"), false) : true,
    },
    converter: {
      kind: pick(
        "CDE_OFFICE_CONVERTER",
        converterKind && OFFICE_CONVERTER_KINDS.includes(converterKind) ? converterKind : undefined,
        "auto",
      ),
      url: pick("CDE_OFFICE_CONVERTER_URL", trimUrl(env.CDE_OFFICE_CONVERTER_URL), null),
      timeoutSec: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 1000)) : 180,
      maxFileMb: 100,
      concurrency: 2,
      retries: 2,
    },
    wopiBaseUrl: pick("CDE_WOPI_BASE_URL", trimUrl(env.CDE_WOPI_BASE_URL), null),
    tokenTtlMinutes: 600,
    jwtSecret: pick("CDE_OFFICE_JWT_SECRET", env.CDE_OFFICE_JWT_SECRET?.trim(), null),
    gotenbergAuth: pick("CDE_GOTENBERG_AUTH", env.CDE_GOTENBERG_AUTH?.trim(), null),
    fromEnv,
  };
}

export async function getStoredOfficeSettings(db: Db): Promise<StoredOfficeSettings> {
  return getSetting<StoredOfficeSettings>(db, OFFICE_SETTINGS_KEY, {});
}

const def = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);

/** Effective configuration: stored values win over environment defaults. */
export function resolveOfficeConfig(stored: StoredOfficeSettings, secretKey: Buffer, env: NodeJS.ProcessEnv = process.env): OfficeConfig {
  const d = officeDefaults(env);
  const secret = (enc: string | null | undefined, fallback: string | null) => {
    if (enc === undefined) return fallback;
    if (!enc) return null;
    try {
      return decryptSecret(secretKey, enc);
    } catch {
      return null;
    }
  };
  return {
    editor: {
      kind: def(stored.editor?.kind, d.editor.kind),
      url: def(stored.editor?.url, d.editor.url),
      publicUrl: def(stored.editor?.publicUrl, d.editor.publicUrl),
      verifyProof: def(stored.editor?.verifyProof, d.editor.verifyProof),
    },
    converter: {
      kind: def(stored.converter?.kind, d.converter.kind),
      url: def(stored.converter?.url, d.converter.url),
      timeoutSec: def(stored.converter?.timeoutSec, d.converter.timeoutSec),
      maxFileMb: def(stored.converter?.maxFileMb, d.converter.maxFileMb),
      concurrency: def(stored.converter?.concurrency, d.converter.concurrency),
      retries: def(stored.converter?.retries, d.converter.retries),
    },
    wopiBaseUrl: def(stored.wopiBaseUrl, d.wopiBaseUrl),
    tokenTtlMinutes: Math.min(TOKEN_TTL_MAX_MINUTES, def(stored.tokenTtlMinutes, d.tokenTtlMinutes)),
    jwtSecret: secret(stored.jwtSecretEnc, d.jwtSecret),
    gotenbergAuth: secret(stored.gotenbergAuthEnc, d.gotenbergAuth),
    fromEnv: d.fromEnv,
  };
}

export function toOfficeSettingsDto(c: OfficeConfig): OfficeSettingsDto {
  return {
    editor: { ...c.editor },
    converter: { ...c.converter },
    wopiBaseUrl: c.wopiBaseUrl,
    tokenTtlMinutes: c.tokenTtlMinutes,
    hasJwtSecret: !!c.jwtSecret,
    hasGotenbergAuth: !!c.gotenbergAuth,
    fromEnv: c.fromEnv,
  };
}
