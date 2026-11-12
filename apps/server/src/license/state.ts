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
 * (clock rollback guard, §4.4). Status is computed on read from the cached payload.
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
}
export type ParsedLicenseProblem = Extract<ParsedLicense, { ok: false }>["reason"] | "other_installation" | "build_after_support";

const DAY = 86_400_000;
const EXPIRING_DAYS = 30;
const KEY_INSTALLATION = "license.installation";
const KEY_FILE = "license.file";
const KEY_MAX_SEEN = "license.maxSeenAt";

/** Licences decide the modules: SITEKEEP_LICENSE_ENFORCE=1, or the Enterprise image (SITEKEEP_EDITION=enterprise) unless =0. */
export const licenseEnforced = (): boolean =>
  process.env.SITEKEEP_LICENSE_ENFORCE === "1" || (process.env.SITEKEEP_EDITION === "enterprise" && process.env.SITEKEEP_LICENSE_ENFORCE !== "0");
/**
 * The development key is refused in production and in every edition image (SITEKEEP_EDITION set): an
 * image must not accept self-made licences because someone overrides NODE_ENV.
 */
const production = (): boolean => process.env.NODE_ENV === "production" || !!process.env.SITEKEEP_EDITION;

let state: { installationId: string; file: string | null; parsed: ParsedLicense | null; maxSeenAt: number } | null = null;
/** Active (not disabled) user accounts, refreshed at start and whenever accounts change (refreshSeats). */
let activeUsers = 0;

/** Counts active accounts; call after creating, enabling or disabling one. */
export async function refreshSeats(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.disabled, false));
  activeUsers = Number(row?.n ?? 0);
  return activeUsers;
}

/** Loads (or creates) the installation id and the stored licence. Called once at start (index.ts, tests). */
export async function initLicense(db: Db): Promise<void> {
  let installationId = await getSetting<string | null>(db, KEY_INSTALLATION, null);
  if (!installationId) {
    installationId = `inst_${randomBytes(15).toString("base64url")}`;
    await putSetting(db, KEY_INSTALLATION, installationId, null);
  }
  const file = await getSetting<string | null>(db, KEY_FILE, null);
  const maxSeenAt = Date.parse(await getSetting<string>(db, KEY_MAX_SEEN, new Date(0).toISOString())) || 0;
  state = { installationId, file, parsed: file ? parseLicense(file, { production: production() }) : null, maxSeenAt };
  await touchClock(db);
  await refreshSeats(db);
}

/** Records the latest time seen (at most hourly writes). */
export async function touchClock(db: Db, now = Date.now()): Promise<void> {
  if (!state || now < state.maxSeenAt + 3_600_000) return;
  state.maxSeenAt = now;
  await putSetting(db, KEY_MAX_SEEN, new Date(now).toISOString(), null);
}

/** Stores a new licence after checking it; refuses one that does not verify or is for another installation. */
export async function installLicense(db: Db, text: string, userId: string): Promise<{ ok: true } | { ok: false; problem: ParsedLicenseProblem }> {
  if (!state) throw new Error("licence state not initialised");
  const parsed = parseLicense(text, { production: production() });
  if (!parsed.ok) return { ok: false, problem: parsed.reason };
  if (!appliesHere(parsed.payload, state.installationId)) return { ok: false, problem: "other_installation" };
  await putSetting(db, KEY_FILE, text, userId);
  state.file = text;
  state.parsed = parsed;
  return { ok: true };
}

export async function removeLicense(db: Db, userId: string): Promise<void> {
  await putSetting(db, KEY_FILE, null, userId);
  if (state) {
    state.file = null;
    state.parsed = null;
  }
}

const appliesHere = (p: LicensePayload, installationId: string) => p.installation === "*" || p.installation === installationId;

/** The status at `now` (pure; exported for tests). */
export function computeLicense(
  input: { installationId: string; parsed: ParsedLicense | null; maxSeenAt: number },
  now: number,
  buildDate: string | undefined = process.env.SITEKEEP_BUILD_DATE,
  usersActive: number = activeUsers,
): LicenseView {
  const clockBehind = now < input.maxSeenAt - 2 * DAY;
  const at = clockBehind ? input.maxSeenAt : now;
  const seats = input.parsed?.ok ? input.parsed.payload.seats : null;
  const seatsOver = seats === null ? 0 : Math.max(0, usersActive - seats);
  const base = { installationId: input.installationId, enforced: licenseEnforced(), clockBehind, daysLeft: null, readOnlyAt: null, seatsOver };
  if (!input.parsed) return { ...base, status: "none", problem: null, payload: null };
  if (!input.parsed.ok) return { ...base, status: "invalid", problem: input.parsed.reason, payload: null };
  const p = input.parsed.payload;
  if (!appliesHere(p, input.installationId)) return { ...base, status: "invalid", problem: "other_installation", payload: p };
  if (buildDate && Date.parse(buildDate) > Date.parse(p.supportUntil)) return { ...base, status: "invalid", problem: "build_after_support", payload: p };
  if (at < Date.parse(p.validFrom)) return { ...base, status: "not_yet", problem: null, payload: p };
  if (p.validUntil === null) return { ...base, status: "active", problem: null, payload: p };
  const until = Date.parse(p.validUntil);
  const readOnlyAt = until + p.graceDays * DAY;
  const view = { ...base, problem: null, payload: p, daysLeft: Math.ceil((until - at) / DAY), readOnlyAt: new Date(readOnlyAt).toISOString() };
  if (at >= readOnlyAt) return { ...view, status: "read_only" };
  if (at >= until) return { ...view, status: "grace" };
  if (until - at <= EXPIRING_DAYS * DAY) return { ...view, status: "expiring" };
  return { ...view, status: "active" };
}

/** The current licence view (Community defaults before initLicense, e.g. in tools). */
export function currentLicense(now = Date.now()): LicenseView {
  if (!state) return computeLicense({ installationId: "inst_unset", parsed: null, maxSeenAt: 0 }, now);
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
