/**
 * Online activation and refresh of the licence (docs/onprem/licensing-online.md): Administration → Licence
 * activates a key, the installation refreshes it nightly. The licensing service (a Worker in front of Odoo)
 * answers with a signed reply; nothing unsigned changes the stored licence.
 *
 * Sent: the key or licence id, the installation id, a random nonce, version and build date, coarse hardware
 * hints and the number of active accounts. No names, e-mail addresses or project data. Calls go through the
 * outbound registry as the "license" connection (Privacy Centre: listed, switchable, stopped by the kill switch).
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import type { Db } from "../db/index.js";
import { appVersion } from "../app/about.js";
import { outboundFetch, outboundRefusal } from "../privacy/outbound.js";
import { parseLicenceReply, type LicenceReply } from "./format.js";
import {
  installationId,
  installLicense,
  onlineState,
  refreshSeats,
  saveOnlineState,
  storedLicense,
  type LicenseOnlineState,
  type ParsedLicenseProblem,
} from "./state.js";

/** The Privacy Centre connection id of these calls. */
export const LICENSE_CONNECTION = "license";

/** The service and its fallback (some networks block *.workers.dev, others the custom domain). */
const DEFAULT_URLS = ["https://licensing.aecpilot.com", "https://aec-licensing.aecpilot.workers.dev"];
const TIMEOUT_MS = 20_000;
const DAY = 86_400_000;

/** SITEKEEP_LICENSING_URL (comma-separated) replaces the service, for staging and tests. */
export function licensingUrls(env: string | undefined = process.env.SITEKEEP_LICENSING_URL): string[] {
  const list = (env ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : DEFAULT_URLS;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * The activation key in its canonical form `SK-XXXX-XXXX-XXXX-XXXX` (licensing-online.md §3), or "TRIAL";
 * null when it is not a key. Accepts lower case, spaces and missing dashes.
 */
export function normaliseKey(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  if (raw === "TRIAL") return "TRIAL";
  const body = raw.startsWith("SK") ? raw.slice(2) : raw;
  if (body.length !== 16 || [...body].some((c) => !ALPHABET.includes(c))) return null;
  return `SK-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
}

const production = (): boolean => process.env.NODE_ENV === "production" || !!process.env.SITEKEEP_EDITION;

function hardwareHints(): string[] {
  return [`cpu:${os.cpus().length}`, `ram:${Math.round(os.totalmem() / 1024 ** 3)}`];
}

/** The service could not give a trustworthy answer (network, HTTP status, signature, nonce): keep everything. */
export class LicensingUnreachable extends Error {}

/** POSTs to each URL in turn until one gives a signed reply for this request. */
async function call(route: "activate" | "refresh", body: Record<string, unknown>, nonce: string): Promise<Extract<LicenceReply, { ok: true }>> {
  const inst = installationId();
  let last = "unreachable";
  for (const base of licensingUrls()) {
    const url = `${base}/cde/v1/${route}`;
    const refused = outboundRefusal(url, LICENSE_CONNECTION, "lisans");
    if (refused) throw new LicensingUnreachable(refused);
    try {
      const res = await outboundFetch(
        "lisans",
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
        { connection: LICENSE_CONNECTION, details: { route } },
      );
      const text = await res.text();
      if (res.status !== 200) {
        last = `HTTP ${res.status}`;
        continue;
      }
      const reply = parseLicenceReply(text, { nonce, installation: inst }, { production: production() });
      if (!reply.ok) {
        last = `reply ${reply.reason}`;
        continue;
      }
      return reply;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new LicensingUnreachable(last);
}

async function requestBody(db: Db, nonce: string): Promise<Record<string, unknown>> {
  return {
    installation: installationId(),
    nonce,
    version: appVersion() ?? "dev",
    buildDate: process.env.SITEKEEP_BUILD_DATE ?? null,
    hardware: hardwareHints(),
    counts: { users: await refreshSeats(db) },
  };
}

export type OnlineOutcome =
  | { ok: true; status: "valid" | "unchanged"; changed: boolean; notice: string | null }
  | { ok: false; kind: "rejected"; reason: string }
  | { ok: false; kind: "unreachable"; detail: string }
  /** The service sent a licence this installation refuses (signature key unknown to this version, other installation…). */
  | { ok: false; kind: "invalid_licence"; problem: ParsedLicenseProblem };

/** First activation of a key (Administration → Licence). */
export async function activateLicense(db: Db, rawKey: string, userId: string, now = Date.now()): Promise<OnlineOutcome> {
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, kind: "rejected", reason: "key_format" };
  const nonce = randomBytes(16).toString("hex");
  const at = new Date(now).toISOString();
  let reply: Extract<LicenceReply, { ok: true }>;
  try {
    reply = await call("activate", { key, ...(await requestBody(db, nonce)) }, nonce);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await saveOnlineState(db, { lastCheckAt: at, lastResult: "unreachable", lastReason: null }, userId);
    return { ok: false, kind: "unreachable", detail };
  }
  if (reply.status !== "valid") {
    const reason = reply.status === "invalid" ? reply.reason : "rejected";
    await saveOnlineState(db, { lastCheckAt: at, lastResult: "invalid", lastReason: reason }, userId);
    return { ok: false, kind: "rejected", reason };
  }
  const installed = await installLicense(db, reply.licence, userId, true);
  if (!installed.ok) return { ok: false, kind: "invalid_licence", problem: installed.problem };
  await saveOnlineState(db, { activated: true, lastCheckAt: at, lastOkAt: at, lastResult: "valid", lastReason: reply.notice, revokedAt: null }, userId);
  return { ok: true, status: "valid", changed: true, notice: reply.notice };
}

/** Whether a refresh applies now: an online-activated licence that allows online checks. */
export function refreshApplies(): boolean {
  const p = storedLicense();
  return !!p && onlineState().activated && p.online !== "off";
}

/**
 * Refresh (nightly, or "Check now"): a newer licence replaces the stored one; `invalid` starts the grace
 * period from today (never locks at once, lisanslama.md §6.3); unreachable changes nothing.
 */
export async function refreshLicense(db: Db, userId: string | null = null, now = Date.now()): Promise<OnlineOutcome> {
  const p = storedLicense();
  if (!p || !refreshApplies()) return { ok: false, kind: "rejected", reason: "not_online" };
  const nonce = randomBytes(16).toString("hex");
  const at = new Date(now).toISOString();
  let reply: Extract<LicenceReply, { ok: true }>;
  try {
    reply = await call("refresh", { lid: p.lid, have: p.issuedAt, ...(await requestBody(db, nonce)) }, nonce);
  } catch (err) {
    await saveOnlineState(db, { lastCheckAt: at, lastResult: "unreachable" }, userId);
    return { ok: false, kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (reply.status === "invalid") {
    const before = onlineState();
    await saveOnlineState(db, { lastCheckAt: at, lastResult: "invalid", lastReason: reply.reason, revokedAt: before.revokedAt ?? at }, userId);
    return { ok: false, kind: "rejected", reason: reply.reason };
  }
  const patch: Partial<LicenseOnlineState> = { lastCheckAt: at, lastOkAt: at, lastResult: reply.status, lastReason: null, revokedAt: null };
  if (reply.status === "unchanged") {
    await saveOnlineState(db, patch, userId);
    return { ok: true, status: "unchanged", changed: false, notice: null };
  }
  const installed = await installLicense(db, reply.licence, userId, true);
  if (!installed.ok) {
    await saveOnlineState(db, { lastCheckAt: at, lastResult: "invalid", lastReason: installed.problem }, userId);
    return { ok: false, kind: "invalid_licence", problem: installed.problem };
  }
  await saveOnlineState(db, { ...patch, lastReason: reply.notice }, userId);
  return { ok: true, status: "valid", changed: true, notice: reply.notice };
}

/**
 * Nightly refresh: checks hourly and refreshes once a day plus a delay chosen at start (up to six hours), so installations do
 * not all call at the same moment. Skipped while the kill switch or the connection is off. Returns stop().
 */
export function startLicenseRefresh(db: Db, opts: { log?: (m: string, e?: unknown) => void; intervalMs?: number } = {}): () => void {
  const jitter = Math.floor(Math.random() * 6 * 3_600_000);
  let busy = false;
  const tick = async () => {
    if (busy || !refreshApplies()) return;
    const last = Date.parse(onlineState().lastCheckAt ?? "") || 0;
    if (Date.now() < last + DAY + jitter) return;
    if (outboundRefusal(licensingUrls()[0]!, LICENSE_CONNECTION, "lisans")) return;
    busy = true;
    try {
      const r = await refreshLicense(db);
      if (!r.ok && r.kind !== "rejected") opts.log?.("licence refresh", r.kind === "unreachable" ? r.detail : r.problem);
    } catch (err) {
      opts.log?.("licence refresh failed", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 3_600_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
