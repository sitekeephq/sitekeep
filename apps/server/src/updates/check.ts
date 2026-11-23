/**
 * Update check (docs/features/PRIVACY.md → Update Check): once a day, when an administrator turned it on, SiteKeep asks
 * GitHub for the number of the latest release. Sent: one GET with the product name and version in the
 * User-Agent; nothing about the installation (no id, no counts, no cookies). Calls go through the outbound
 * registry as the "updates" connection (Privacy Centre: listed, switchable, stopped by the kill switch).
 *
 * SITEKEEP_UPDATE_URL replaces the address (a mirror in a closed network, tests). Enterprise installations with
 * online licensing also learn the latest version from the licence reply (license/online.ts), without this call.
 */
import type { Db } from "../db/index.js";
import { appVersion } from "../app/about.js";
import { outboundFetch, outboundRefusalMsg } from "../privacy/outbound.js";
import { refreshPrivacyState } from "../privacy/settings.js";
import type { Msg } from "../i18n/index.js";
import { releaseVersion } from "./semver.js";
import { getUpdateState, noteLatest, saveUpdateState } from "./state.js";

/** The Privacy Centre connection id of these calls. */
export const UPDATES_CONNECTION = "updates";
export const UPDATES_PURPOSE = "guncelleme";
const DEFAULT_URL = "https://api.github.com/repos/sitekeephq/sitekeep/releases/latest";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1_000_000;
const DAY = 86_400_000;

export function updateUrl(env: string | undefined = process.env.SITEKEEP_UPDATE_URL): string {
  return env?.trim() || DEFAULT_URL;
}

export type CheckOutcome =
  | { ok: true; found: string | null }
  /** The Privacy Centre (connection switch or kill switch) forbids the call; nothing was sent. */
  | { ok: false; kind: "blocked"; reason: Msg }
  | { ok: false; kind: "failed"; detail: string };

/** Body text up to MAX_BYTES; throws when the answer is larger. */
async function readLimited(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("reply too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("reply too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Why the Privacy Centre forbids the call right now, or null. */
export async function updateCheckBlocked(db: Db): Promise<Msg | null> {
  await refreshPrivacyState(db);
  return outboundRefusalMsg(updateUrl(), UPDATES_CONNECTION, UPDATES_PURPOSE);
}

/**
 * Asks for the latest release now. The caller decides whether it may (enabled, or an administrator pressed
 * the button); the Privacy Centre is always respected. A failure is recorded (lastError) and changes nothing else.
 */
export async function checkForUpdates(db: Db, userId: string | null = null, now = Date.now()): Promise<CheckOutcome> {
  const blocked = await updateCheckBlocked(db);
  if (blocked) return { ok: false, kind: "blocked", reason: blocked };
  const at = new Date(now).toISOString();
  try {
    const res = await outboundFetch(
      UPDATES_PURPOSE,
      updateUrl(),
      {
        method: "GET",
        headers: { accept: "application/vnd.github+json", "user-agent": `SiteKeep/${appVersion() ?? "dev"}` },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      { connection: UPDATES_CONNECTION, userId },
    );
    const text = await readLimited(res);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(text) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown };
    if (!body || typeof body !== "object" || typeof body.tag_name !== "string") throw new Error("unexpected reply");
    // "latest" never names a draft or pre-release; a mirror might, so check again.
    const version = body.draft === true || body.prerelease === true ? null : releaseVersion(body.tag_name);
    const published = typeof body.published_at === "string" && !Number.isNaN(Date.parse(body.published_at)) ? new Date(body.published_at).toISOString() : null;
    if (version) await noteLatest(db, { version, url: body.html_url as string, publishedAt: published }, "github", { lastCheckAt: at, lastError: null });
    else await saveUpdateState(db, { lastCheckAt: at, lastError: null }, userId);
    return { ok: true, found: version };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await saveUpdateState(db, { lastCheckAt: at, lastError: detail.slice(0, 200) }, userId);
    return { ok: false, kind: "failed", detail };
  }
}

/**
 * Daily check: looks hourly, asks once a day plus a delay chosen at start (up to six hours), so installations do not
 * all call at the same moment. Does nothing while the check is off, the kill switch or the connection is off.
 * Returns stop().
 */
export function startUpdateCheck(db: Db, opts: { log?: (m: string, e?: unknown) => void; intervalMs?: number; jitterMs?: number } = {}): () => void {
  const jitter = opts.jitterMs ?? Math.floor(Math.random() * 6 * 3_600_000);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await getUpdateState(db);
      if (!state.enabled) return;
      const last = Date.parse(state.lastCheckAt ?? "") || 0;
      if (Date.now() < last + DAY + jitter) return;
      const r = await checkForUpdates(db);
      if (!r.ok && r.kind === "failed") opts.log?.("update check", r.detail);
    } catch (err) {
      opts.log?.("update check failed", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 3_600_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
