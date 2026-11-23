/**
 * The installation's licence (docs/onprem/lisanslama.md §4–5, adapted to SiteKeep editions):
 *
 * - Without a licence the installation is SiteKeep Community: the core is free (AGPL-3.0) and is never
 *   limited. A licence turns on Enterprise modules; when it lapses only those modules become read-only.
 * - Enforcement is opt-in while the release pipeline is built (SITEKEEP_LICENSE_ENFORCE=1, set by the
 *   Enterprise image): without it the status is computed and shown, and modules follow the installed
 *   packages as before.
 *
 * Stored in system_settings: the installation id, the licence file as uploaded and the latest time seen
 * (clock rollback guard, §4.4), and the state of online activation (licensing-online.md): whether the
 * licence came online, the last check and its result. Status is computed on read from the cached payload.
 */
import { randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { users } from "../db/schema.js";
import { getSetting, putSetting } from "../ai/settings.js";
import { parseLicense, type LicensePayload, type ParsedLicense } from "./format.js";

export type LicenseStatus = "none" | "not_yet" | "active" | "expiring" | "grace" | "read_only" | "invalid";

export interface LicenseView {
  installationId: string;
  status: LicenseStatus;
  /** Why the file was refused (invalid) or does not apply. */
  problem: ParsedLicenseProblem | null;
  payload: LicensePayload | null;
  /** Days until validUntil (negative after it); null for perpetual or no licence. */
  daysLeft: number | null;
  /** Read-only from this moment (validUntil + graceDays); null when not applicable. */
  readOnlyAt: string | null;
  /** The local clock is more than 48 hours behind the latest time seen. */
  clockBehind: boolean;
  enforced: boolean;
  /** Active user accounts beyond the licence's seats (0 when within or unlimited). */
  seatsOver: number;
  /**
   * Why the dates were brought forward: the licensing service revoked the licence (grace from that day),
   * or a licence that requires online checks has not reached the service for 30 days.
   */
  onlineProblem: "revoked" | "offline_too_long" | null;
}

/** Online activation state (licensing-online.md §4, lisanslama.md §6.3). */
export interface LicenseOnlineState {
  /** The stored licence came from the licensing service (activate): nightly refresh applies. */
  activated: boolean;
  lastCheckAt: string | null;
  /** Last answer the service gave (valid or unchanged); the 30-day clock of `online: required` counts from it. */
  lastOkAt: string | null;
  lastResult: "valid" | "unchanged" | "invalid" | "unreachable" | null;
  /** Reason of the last `invalid` reply, or the information next to a valid one. */
  lastReason: string | null;
  /** First `invalid` reply on a refresh: the grace period starts here (cleared by a later valid reply). */
  revokedAt: string | null;
}

export const NO_ONLINE: LicenseOnlineState = { activated: false, lastCheckAt: null, lastOkAt: null, lastResult: null, lastReason: null, revokedAt: null };
/** `online: required`: grace after 30 days without an answer, read-only 14 days later (lisanslama.md §6.3). */
const REQUIRED_OFFLINE_DAYS = 30;
const REQUIRED_OFFLINE_GRACE_DAYS = 14;
export type ParsedLicenseProblem = Extract<ParsedLicense, { ok: false }>["reason"] | "other_installation" | "build_after_support";

const DAY = 86_400_000;
const EXPIRING_DAYS = 30;
const KEY_INSTALLATION = "license.installation";
const KEY_FILE = "license.file";
const KEY_MAX_SEEN = "license.maxSeenAt";
const KEY_ONLINE = "license.online";

/** Licences decide the modules: SITEKEEP_LICENSE_ENFORCE=1, or the Enterprise image (SITEKEEP_EDITION=enterprise) unless =0. */
export const licenseEnforced = (): boolean =>
  process.env.SITEKEEP_LICENSE_ENFORCE === "1" || (process.env.SITEKEEP_EDITION === "enterprise" && process.env.SITEKEEP_LICENSE_ENFORCE !== "0");
/**
 * The development key is refused in production and in every edition image (SITEKEEP_EDITION set): an
 * image must not accept self-made licences because someone overrides NODE_ENV.
 */
const production = (): boolean => process.env.NODE_ENV === "production" || !!process.env.SITEKEEP_EDITION;

let state: { installationId: string; file: string | null; parsed: ParsedLicense | null; maxSeenAt: number; online: LicenseOnlineState } | null = null;
/** Active (not disabled) user accounts, refreshed at start and whenever accounts change (refreshSeats). */
let activeUsers = 0;

/** Counts active accounts; call after creating, enabling or disabling one. */
export async function refreshSeats(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.disabled, false));
  activeUsers = Number(row?.n ?? 0);
  return activeUsers;
}

/**
 * The stored licence file as text. The licence is stored as a JSON string, but a JSON string that is itself JSON
 * comes back from node-postgres already parsed (drizzle parses jsonb text once more), while PGlite returns the
 * string. Both shapes give the same text: the signature covers only the `payload` string, which survives.
 */
export function storedLicenceText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/** SITEKEEP_INSTALLATION_ID, written by the installation bundle (install.sh), when it has the expected shape. */
export function presetInstallationId(env: string | undefined = process.env.SITEKEEP_INSTALLATION_ID): string | null {
  const id = env?.trim();
  return id && /^inst_[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

/**
 * Loads (or creates) the installation id and the stored licence. Called once at start (index.ts, tests). A new
 * installation takes the id the installer printed (SITEKEEP_INSTALLATION_ID); once stored, the id never changes,
 * because licences are bound to it.
 */
export async function initLicense(db: Db): Promise<void> {
  let installationId = await getSetting<string | null>(db, KEY_INSTALLATION, null);
  if (!installationId) {
    installationId = presetInstallationId() ?? `inst_${randomBytes(15).toString("base64url")}`;
    await putSetting(db, KEY_INSTALLATION, installationId, null);
  }
  const file = storedLicenceText(await getSetting<unknown>(db, KEY_FILE, null));
  const maxSeenAt = Date.parse(await getSetting<string>(db, KEY_MAX_SEEN, new Date(0).toISOString())) || 0;
  const online = { ...NO_ONLINE, ...(await getSetting<Partial<LicenseOnlineState> | null>(db, KEY_ONLINE, null)) };
  state = { installationId, file, parsed: file ? parseLicense(file, { production: production() }) : null, maxSeenAt, online };
  await touchClock(db);
  await refreshSeats(db);
}

/** Records the latest time seen (at most hourly writes). */
export async function touchClock(db: Db, now = Date.now()): Promise<void> {
  if (!state || now < state.maxSeenAt + 3_600_000) return;
  state.maxSeenAt = now;
  await putSetting(db, KEY_MAX_SEEN, new Date(now).toISOString(), null);
}

/** The installation id (after initLicense). */
export function installationId(): string {
  if (!state) throw new Error("licence state not initialised");
  return state.installationId;
}

/** The stored licence's payload when it verifies, else null. */
export function storedLicense(): LicensePayload | null {
  return state?.parsed?.ok ? state.parsed.payload : null;
}

export function onlineState(): LicenseOnlineState {
  return state ? { ...state.online } : { ...NO_ONLINE };
}

/** Merges into the online state and stores it. */
export async function saveOnlineState(db: Db, patch: Partial<LicenseOnlineState>, userId: string | null = null): Promise<LicenseOnlineState> {
  if (!state) throw new Error("licence state not initialised");
  state.online = { ...state.online, ...patch };
  await putSetting(db, KEY_ONLINE, state.online, userId);
  return { ...state.online };
}

/**
 * Stores a new licence after checking it; refuses one that does not verify or is for another installation.
 * `online`: it came from the licensing service (activation / refresh), so nightly refresh applies; a file
 * uploaded by hand ends online activation.
 */
export async function installLicense(
  db: Db,
  text: string,
  userId: string | null,
  online = false,
): Promise<{ ok: true } | { ok: false; problem: ParsedLicenseProblem }> {
  if (!state) throw new Error("licence state not initialised");
  const parsed = parseLicense(text, { production: production() });
  if (!parsed.ok) return { ok: false, problem: parsed.reason };
  if (!appliesHere(parsed.payload, state.installationId)) return { ok: false, problem: "other_installation" };
  await putSetting(db, KEY_FILE, text, userId);
  state.file = text;
  state.parsed = parsed;
  if (!online && state.online.activated) await saveOnlineState(db, { ...NO_ONLINE }, userId);
  return { ok: true };
}

export async function removeLicense(db: Db, userId: string): Promise<void> {
  await putSetting(db, KEY_FILE, null, userId);
  await putSetting(db, KEY_ONLINE, null, userId);
  if (state) {
    state.file = null;
    state.parsed = null;
    state.online = { ...NO_ONLINE };
  }
}

const appliesHere = (p: LicensePayload, installationId: string) => p.installation === "*" || p.installation === installationId;

/** The status at `now` (pure; exported for tests). */
export function computeLicense(
  input: { installationId: string; parsed: ParsedLicense | null; maxSeenAt: number; online?: LicenseOnlineState },
  now: number,
  buildDate: string | undefined = process.env.SITEKEEP_BUILD_DATE,
  usersActive: number = activeUsers,
): LicenseView {
  const clockBehind = now < input.maxSeenAt - 2 * DAY;
  const at = clockBehind ? input.maxSeenAt : now;
  const seats = input.parsed?.ok ? input.parsed.payload.seats : null;
  const seatsOver = seats === null ? 0 : Math.max(0, usersActive - seats);
  const base = { installationId: input.installationId, enforced: licenseEnforced(), clockBehind, daysLeft: null, readOnlyAt: null, seatsOver, onlineProblem: null };
  if (!input.parsed) return { ...base, status: "none", problem: null, payload: null };
  if (!input.parsed.ok) return { ...base, status: "invalid", problem: input.parsed.reason, payload: null };
  const p = input.parsed.payload;
  if (!appliesHere(p, input.installationId)) return { ...base, status: "invalid", problem: "other_installation", payload: p };
  if (buildDate && Date.parse(buildDate) > Date.parse(p.supportUntil)) return { ...base, status: "invalid", problem: "build_after_support", payload: p };
  if (at < Date.parse(p.validFrom)) return { ...base, status: "not_yet", problem: null, payload: p };
  // The licence's own dates, brought forward by the online state (lisanslama.md §6.3).
  let until = p.validUntil === null ? Infinity : Date.parse(p.validUntil);
  let readOnlyAt = until + p.graceDays * DAY;
  let onlineProblem: LicenseView["onlineProblem"] = null;
  const online = input.online ?? NO_ONLINE;
  const revokedAt = online.revokedAt ? Date.parse(online.revokedAt) : NaN;
  if (Number.isFinite(revokedAt) && revokedAt < until) {
    until = revokedAt;
    readOnlyAt = revokedAt + p.graceDays * DAY;
    onlineProblem = "revoked";
  }
  if (p.online === "required") {
    const lastOk = Math.max(online.lastOkAt ? Date.parse(online.lastOkAt) || 0 : 0, Date.parse(p.issuedAt) || 0);
    const offlineUntil = lastOk + REQUIRED_OFFLINE_DAYS * DAY;
    if (offlineUntil < until) {
      until = offlineUntil;
      readOnlyAt = Math.min(readOnlyAt, offlineUntil + REQUIRED_OFFLINE_GRACE_DAYS * DAY);
      if (at >= offlineUntil) onlineProblem = "offline_too_long";
    }
  }
  if (until === Infinity) return { ...base, status: "active", problem: null, payload: p };
  const view = { ...base, problem: null, payload: p, onlineProblem, daysLeft: Math.ceil((until - at) / DAY), readOnlyAt: new Date(readOnlyAt).toISOString() };
  if (at >= readOnlyAt) return { ...view, status: "read_only" };
  if (at >= until) return { ...view, status: "grace" };
  if (until - at <= EXPIRING_DAYS * DAY) return { ...view, status: "expiring" };
  return { ...view, status: "active" };
}

/** The current licence view (Community defaults before initLicense, e.g. in tools). */
export function currentLicense(now = Date.now()): LicenseView {
  if (!state) return computeLicense({ installationId: "inst_unset", parsed: null, maxSeenAt: 0, online: NO_ONLINE }, now);
  return computeLicense(state, now);
}

/** Modules the licence turns on (full use or read-only), or null when licences are not enforced. */
export function licensedModules(now = Date.now()): readonly string[] | null {
  if (!licenseEnforced()) return null;
  const v = currentLicense(now);
  if (!v.payload || !["active", "expiring", "grace", "read_only"].includes(v.status)) return [];
  return v.payload.modules;
}

/**
 * The module is on but only reads: its licence has lapsed, or more accounts are active than the licence
 * has seats. The core is free and never limited, so seats do not stop new accounts (lisanslama.md, top).
 */
export function moduleReadOnly(id: string, now = Date.now()): boolean {
  if (!licenseEnforced()) return false;
  const v = currentLicense(now);
  if (!v.payload?.modules.includes(id)) return false;
  return v.status === "read_only" || v.seatsOver > 0;
}
