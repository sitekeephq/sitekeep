/**
 * Privacy settings (Yönetim → Gizlilik Merkezi), stored in system_settings and mirrored in memory:
 * host checks and the outbound helper are synchronous and run on every external call.
 *
 *   privacy.settings    log retention, "iç ağ" hosts, redaction switches, disabled connections
 *   privacy.killSwitch  "Tüm Dış Bağlantıları Kapat": { on, at, by }
 *
 * The in-memory copy is loaded when the app starts, replaced on every save and re-read at most
 * every 30 seconds by the outbound helper (refreshPrivacyState), so a second server process
 * follows a change within half a minute.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { systemSettings } from "../db/schema.js";
import { normalizeLanList, setLanAllowlist } from "../ai/hosts.js";
import { AUDIT_PERSONAL_RETENTION } from "@sitekeep/shared";
import { connectionDefaultEnabled } from "./connections.js";

export interface PrivacySettings {
  /** Outbound log rows are kept this many days (daily cleanup). */
  logRetentionDays: number;
  /**
   * Personal part of the audit log (IP address, user agent, e-mail; audit_personal) is kept this
   * many months, then deleted by the daily job (audit/personal.ts). The chained rows stay.
   */
  auditPersonalRetentionMonths: number;
  /** "İç ağ" list: hosts treated as inside the network (see ai/hosts.ts). */
  lanHosts: string[];
  /** Redact personal data also before prompts go to a local (LAN) model ("Yerel modelde de maskele"). */
  redactLocal: boolean;
  /** Replace project members' names with their role and company before prompts leave. */
  redactNames: boolean;
  /** Connection ids switched off in "Dış Bağlantılar" ("ai:<providerId>", "smtp", "office:editor"…). */
  disabledConnections: string[];
  /** Connections that are off until turned on (a module's defaultEnabled: false) and were turned on. */
  enabledConnections: string[];
}

export interface KillSwitchState {
  on: boolean;
  /** ISO time of the last change. */
  at: string | null;
  /** User id of the last change. */
  by: string | null;
}

export const PRIVACY_DEFAULTS: PrivacySettings = {
  logRetentionDays: 90,
  auditPersonalRetentionMonths: AUDIT_PERSONAL_RETENTION.default,
  lanHosts: [],
  redactLocal: false,
  redactNames: true,
  disabledConnections: [],
  enabledConnections: [],
};

const KILL_DEFAULT: KillSwitchState = { on: false, at: null, by: null };

export interface PrivacyState {
  settings: PrivacySettings;
  killSwitch: KillSwitchState;
  loadedAt: number;
}

let state: PrivacyState = { settings: { ...PRIVACY_DEFAULTS }, killSwitch: { ...KILL_DEFAULT }, loadedAt: 0 };

export function privacyState(): PrivacyState {
  return state;
}

/** "Tüm Dış Bağlantıları Kapat" is on. */
export function killSwitchOn(): boolean {
  return state.killSwitch.on;
}

export function connectionDisabled(id: string | null | undefined): boolean {
  if (!id) return false;
  if (state.settings.disabledConnections.includes(id)) return true;
  return !connectionDefaultEnabled(id) && !state.settings.enabledConnections.includes(id);
}

async function read<T>(db: Db, key: string): Promise<T | undefined> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return row ? (row.value as T) : undefined;
}

async function write(db: Db, key: string, value: unknown, userId: string | null): Promise<void> {
  const now = new Date();
  await db
    .insert(systemSettings)
    .values({ key, value, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedBy: userId, updatedAt: now } });
}

function clean(s: Partial<PrivacySettings> | undefined): PrivacySettings {
  const v = { ...PRIVACY_DEFAULTS, ...(s ?? {}) };
  const days = Math.round(Number(v.logRetentionDays));
  const months = Math.round(Number(v.auditPersonalRetentionMonths));
  return {
    logRetentionDays: Number.isFinite(days) ? Math.min(Math.max(days, 1), 3650) : PRIVACY_DEFAULTS.logRetentionDays,
    auditPersonalRetentionMonths: Number.isFinite(months)
      ? Math.min(Math.max(months, AUDIT_PERSONAL_RETENTION.min), AUDIT_PERSONAL_RETENTION.max)
      : PRIVACY_DEFAULTS.auditPersonalRetentionMonths,
    lanHosts: normalizeLanList(Array.isArray(v.lanHosts) ? v.lanHosts.map(String) : []),
    redactLocal: !!v.redactLocal,
    redactNames: v.redactNames !== false,
    disabledConnections: Array.isArray(v.disabledConnections) ? [...new Set(v.disabledConnections.map(String))] : [],
    enabledConnections: Array.isArray(v.enabledConnections) ? [...new Set(v.enabledConnections.map(String))] : [],
  };
}

function apply(next: Omit<PrivacyState, "loadedAt">): PrivacyState {
  state = { ...next, loadedAt: Date.now() };
  setLanAllowlist(state.settings.lanHosts);
  return state;
}

/** Reads the settings from the database into memory. */
export async function loadPrivacyState(db: Db): Promise<PrivacyState> {
  const [settings, kill] = await Promise.all([
    read<Partial<PrivacySettings>>(db, "privacy.settings"),
    read<Partial<KillSwitchState>>(db, "privacy.killSwitch"),
  ]);
  return apply({ settings: clean(settings), killSwitch: { ...KILL_DEFAULT, ...(kill ?? {}), on: !!kill?.on } });
}

const REFRESH_MS = 30_000;

/** Re-reads the settings when the in-memory copy is older than 30 s; keeps the old copy on errors. */
export async function refreshPrivacyState(db: Db | null): Promise<PrivacyState> {
  if (!db || Date.now() - state.loadedAt < REFRESH_MS) return state;
  try {
    return await loadPrivacyState(db);
  } catch {
    return state;
  }
}

export async function savePrivacySettings(db: Db, patch: Partial<PrivacySettings>, userId: string | null): Promise<PrivacySettings> {
  const current = clean(await read<Partial<PrivacySettings>>(db, "privacy.settings"));
  const next = clean({ ...current, ...patch });
  await write(db, "privacy.settings", next, userId);
  apply({ settings: next, killSwitch: state.killSwitch });
  return next;
}

export async function setKillSwitch(db: Db, on: boolean, userId: string | null): Promise<KillSwitchState> {
  const next: KillSwitchState = { on, at: new Date().toISOString(), by: userId };
  await write(db, "privacy.killSwitch", next, userId);
  const settings = clean(await read<Partial<PrivacySettings>>(db, "privacy.settings"));
  apply({ settings, killSwitch: next });
  return next;
}

export async function setConnectionEnabled(db: Db, id: string, enabled: boolean, userId: string | null): Promise<PrivacySettings> {
  const current = clean(await read<Partial<PrivacySettings>>(db, "privacy.settings"));
  const off = new Set(current.disabledConnections);
  const on = new Set(current.enabledConnections);
  if (enabled) {
    off.delete(id);
    on.add(id);
  } else {
    off.add(id);
    on.delete(id);
  }
  return savePrivacySettings(db, { disabledConnections: [...off], enabledConnections: [...on] }, userId);
}

/** Audit rows older than this lose their personal part (calendar months before `now`, UTC). */
export function auditPersonalCutoff(now = new Date(), months = state.settings.auditPersonalRetentionMonths): Date {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  // 31 March minus one month is 28/29 February, not 3 March.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
