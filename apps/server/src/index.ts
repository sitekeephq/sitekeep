import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { buildApp } from "./app/build-app.js";
import { activeModules } from "./app/modules.js";
import { hashPassword } from "./core/security/auth.js";
import { adminPasswordProblem, adminPrefs } from "./auth/bootstrap-admin.js";
import { openDb } from "./db/index.js";
import { migrateLegacyCodes } from "./cde/codes-migration.js";
import { recordServerError } from "./core/platform/error-ring.js";
import { users } from "./db/schema.js";
import { JobQueue } from "./jobs/queue.js";
import { Converters } from "./previews/converters.js";
import { loadSecretKey } from "./core/platform/secrets.js";
import { upgradeSeededLabels } from "./projects/seeded-labels.js";
import { seedTaskTeamsOnce } from "./cde/teams.js";
import { startDueReminders } from "./workflow/reminders.js";
import { LocalStorage } from "./core/platform/storage.js";
import { mailerFromEnv } from "./works/letter.js";
import { startRetention } from "./privacy/retention.js";
import { startLicenseRefresh } from "./license/online.js";
import { startSecurityAlerts } from "./audit/security-alerts.js";
import { SignInSecurity } from "./auth/sign-in-security.js";
import { startCloseoutCleanup } from "./closeout/build.js";
import { startPortabilityCleanup } from "./portability/export.js";
import { DEFAULT_LANGUAGE, FALLBACK_LANGUAGE, render, tFor } from "./i18n/index.js";
import { editionName } from "./app/module-ids.js";
import { backfillDocumentCodesAtStart } from "./cde/document-code.js";
import { queueModelBackfill, queueModelReconversion } from "./files/model-backfill.js";

/**
 * Configuration (environment):
 *   PORT               default 8080
 *   HOST               default 0.0.0.0
 *   DATA_DIR           default ./data — files, derivatives and the embedded database
 *   DATABASE_URL       postgres://… ; when unset an embedded PGlite database in DATA_DIR/db is used
 *   ADMIN_EMAIL        first administrator, created when the user table is empty
 *   ADMIN_PASSWORD     at least 10 characters, not common, not the temporary password 1234567890
 *   ADMIN_MUST_CHANGE_PASSWORD  default on: the first administrator changes the password at first sign-in;
 *                      0 turns it off (development, e2e, an installer password the person chose)
 *   WEB_DIST           built web app to serve (default ../web/dist)
 *   SECURE_COOKIES     "1" behind HTTPS
 *   CDE_SECRET_KEY     32-byte key (hex or base64) encrypting AI provider API keys at rest;
 *                      when unset, DATA_DIR/secret.key is generated once (back it up with the database)
 *   AI_BASE_URL        Platform module: OpenAI-compatible endpoint for the report builder (default http://127.0.0.1:11434/v1)
 *   AI_MODEL           default qwen3:8b; the builder is on when AI_BASE_URL or AI_MODEL is set, or AI_ENABLED=1
 *   AI_API_KEY         optional bearer key; AI_TIMEOUT_MS optional; AI_ENABLED=0 turns the builder off
 *   REPORT_TZ          time zone of report date buckets (default Europe/Istanbul)
 *   CDE_SMTP_URL       optional SMTP server for official letters and invitations, e.g. smtp://user:pass@mail.local:587
 *   CDE_SMTP_FROM      sender address for those e-mails; without both, letters are e-mailed by hand (.eml)
 *                      and invitation links are handed to the inviter
 *   CDE_SOFFICE_PATH   LibreOffice soffice, last-resort office → PDF converter (default: install paths, then PATH)
 *   CDE_DWG2DXF_PATH   LibreDWG dwg2dxf for DWG previews (default: install paths, then PATH)
 *   CDE_CONVERT_TIMEOUT_MS  max time of one conversion (default 180000)
 *   Office integration defaults (the admin page overrides them; docs/features/OFFICE_INTEGRATION.md):
 *   CDE_OFFICE_EDITOR  onlyoffice | collabora      CDE_OFFICE_EDITOR_URL, CDE_OFFICE_EDITOR_PUBLIC_URL
 *   CDE_OFFICE_CONVERTER  auto | onlyoffice | collabora | gotenberg | local | none
 *   CDE_OFFICE_CONVERTER_URL   CDE_OFFICE_JWT_SECRET (ONLYOFFICE)   CDE_GOTENBERG_AUTH (user:password)
 *   CDE_WOPI_BASE_URL  CDE address as the editor/converter reaches it (e.g. http://app:8080)
 *   CDE_WOPI_VERIFY_PROOF  "0" turns off X-WOPI-Proof checks
 *   CDE_DEV_TOOLS      "1" turns on the developer tools (cde_dev_* over MCP, /api/v1/dev/*) for system
 *                      administrators' write tokens; ignored when NODE_ENV=production (docs/onboarding/DEVELOPER_MCP.md)
 *   CDE_WEB_URL        web app address used in developer tool links (default http://localhost:5173)
 *   OpenCDE Foundation API and OAuth2 server (docs/features/OPENCDE.md):
 *   CDE_PUBLIC_URL     public HTTPS root, e.g. https://cde.firma.local (absolute URLs; else the request host)
 *   CDE_TRUST_PROXY    "1" or addresses/CIDRs of the reverse proxy (client IP and HTTPS from X-Forwarded-*)
 *   CDE_OAUTH_AUTH_URL / CDE_OAUTH_TOKEN_URL   endpoints advertised by /foundation/1.1/auth (future external IdP)
 *   CDE_OPENCDE_APIS   extra APIs in /foundation/versions once they exist: bcf, documents (comma separated)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL
 *                      optional Google Workspace login; all three are required
 *   AUTODESK_CLIENT_ID / AUTODESK_CALLBACK_URL
 *                      optional Autodesk APS 3-legged PKCE integration
 *   CDE_CLOSEOUT_MAX_GB / CDE_CLOSEOUT_RETENTION_DAYS / CDE_CLOSEOUT_MIN_FREE_GB
 *                      close-out archive: largest archive (unset = no limit), days a ZIP stays
 *                      downloadable (default 14), free disk space to keep (default 2)
 *   CDE_IFC_CIRCLE_SEGMENTS
 *                      straight pieces per circle in viewer models (12–128, default 48)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const dbUrl = process.env.DATABASE_URL || path.join(dataDir, "db");

const { db, kind, close } = await openDb(dbUrl);
const storage = new LocalStorage(path.join(dataDir, "storage"));
const circleSegments = Number(process.env.CDE_IFC_CIRCLE_SEGMENTS);
const jobs = new JobQueue(db, storage, {
  ...(Number.isInteger(circleSegments) && circleSegments >= 12 && circleSegments <= 128 ? { circleSegments } : {}),
  log: (m, e) => {
    recordServerError("job", e ?? m, { message: m });
    console.error(m, e);
  },
});

await bootstrapAdmin();
// ISO-3: register the document codes of existing files (idempotent, batched).
await backfillDocumentCodesAtStart(db, (m, e) => (e ? console.error(m, e) : console.log(m)));
// Default labels templates wrote before they became Title Case ("İş sonu" → "İş Sonu").
await upgradeSeededLabels(db);
// ISO 19650 task teams: one per company in projects that have none yet (once per installation, batched).
await seedTaskTeamsOnce(db).catch((e) => console.error("task team seeding failed", e));
// ISO 19650 codes from the older free attributes (idempotent, batched; docs/features/CDE_STATES.md).
try {
  await migrateLegacyCodes(db, { log: (line) => console.log(line) });
} catch (err) {
  console.error("ISO 19650 codes migration failed; it runs again at the next start.", err);
}

const converters = new Converters();
const signInSecurity = new SignInSecurity(db);
const mailer = mailerFromEnv();
const app = await buildApp({
  db,
  signInSecurity,
  converters,
  storage,
  jobs,
  webDist: process.env.WEB_DIST ?? path.resolve(here, "../../web/dist"),
  secureCookies: process.env.SECURE_COOKIES === "1",
  trustProxy: trustProxyFromEnv(process.env.CDE_TRUST_PROXY),
  secretKey: loadSecretKey(dataDir),
  logger: true,
  mailer,
  dbKind: kind,
  dataLocation: { database: databaseLocation(), storage: `Yerel disk: ${path.join(dataDir, "storage")}` },
  googleAuth: googleAuthFromEnv(),
  autodeskAuth: autodeskAuthFromEnv(),
});

await jobs.start();
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
{
  const c = converters.status();
  app.log.info(`viewers: soffice ${c.soffice.path ?? "yok"}, dwg2dxf ${c.dwg2dxf.path ?? "yok"}`);
}
app.log.info(`${editionName()} ready on :${port} (database: ${kind}, data: ${dataDir})`);
// Review step due-date reminders ("termin yaklaşıyor" / "termin geçti"), every 15 minutes.
const stopReminders = startDueReminders(db, { log: (m, e) => console.error(m, e) });
// Privacy Centre → Retention, daily: outbound log (default 90 days), personal part of the audit log
// (default 12 months), audit log (default unlimited), recycle bin (default off), expired sessions,
// keys and invitations, old personal data exports; writes the disposal record (privacy/retention.ts).
const stopRetention = startRetention(db, storage, { log: (m, e) => console.error(m, e) });
// Online licence (docs/onprem/licensing-online.md): once a day the licence is refreshed from the licensing
// service when it was activated online; off with the kill switch or the "Licence Activation" connection.
const stopLicenseRefresh = startLicenseRefresh(db, { log: (m, e) => console.error(m, e) });
// Security alerts (docs/features/SECURITY_LOG.md#alerts): the audit log is scanned every minute
// against the alert rules, the hash chain is checked daily; new alerts optionally go out by e-mail.
const stopSecurityAlerts = startSecurityAlerts({ db, mailer, log: (m, e) => console.error(m, e) });
// Close-out archives past their download period (CDE_CLOSEOUT_RETENTION_DAYS): the ZIP is deleted, hourly.
const stopCloseoutCleanup = startCloseoutCleanup(db, storage, { log: (m, e) => console.error(m, e) });
// Full project exports past their download period (same retention): the ZIP is deleted, hourly.
const stopPortabilityCleanup = startPortabilityCleanup(db, storage, { log: (m, e) => console.error(m, e) });
// Modules' background work (Connect: Autodesk sync scheduler and interrupted file imports).
const stopModules: (() => void)[] = [];
for (const m of activeModules()) if (m.start) stopModules.push(await m.start({ db, jobs, log: (msg, e) => console.error(msg, e) }));
// Model files stored before a module converted their format (.rvt before Connect 0.5.0): converted once, in the queue.
// Then models from another converter version (a new rvt-rs) and failed ones: converted again once per converter version.
try {
  const queued = await queueModelBackfill(db, jobs);
  if (queued) app.log.info(`model formats: ${queued} stored version(s) queued for conversion`);
  const again = await queueModelReconversion(db, jobs);
  if (again) app.log.info(`model formats: ${again} version(s) queued to convert again (new converter or failed before)`);
} catch (err) {
  app.log.error({ err }, "model formats: queueing stored versions failed");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopReminders();
    stopRetention();
    stopLicenseRefresh();
    stopSecurityAlerts();
    stopCloseoutCleanup();
    stopPortabilityCleanup();
    for (const stop of stopModules) stop();
    jobs.stop();
    await app.close();
    await close();
    process.exit(0);
  });
}

async function bootstrapAdmin() {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length) return;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first administrator.");
    process.exit(1);
  }
  const problem = adminPasswordProblem(password, email);
  if (problem) {
    console.error(`ADMIN_PASSWORD: ${render(FALLBACK_LANGUAGE, problem)} The first administrator was not created; fix ADMIN_PASSWORD and restart.`);
    process.exit(1);
  }
  // The display name is data: written once in the installation's language (CDE_DEFAULT_LANGUAGE).
  const name = tFor(DEFAULT_LANGUAGE)("auth:seed.adminName");
  await db.insert(users).values({ email, name, passwordHash: await hashPassword(password), isAdmin: true, prefs: adminPrefs() });
  const [u] = await db.select().from(users).where(eq(users.email, email));
  console.log(`Created administrator ${u?.email}`);
}

/** Database location for Gizlilik Merkezi, without credentials. */
function databaseLocation(): string {
  if (kind === "pglite") return `PGlite: ${dbUrl}`;
  try {
    const u = new URL(dbUrl);
    return `PostgreSQL: ${u.host}${u.pathname}`;
  } catch {
    return "PostgreSQL";
  }
}

function googleAuthFromEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const callbackUrl = process.env.GOOGLE_CALLBACK_URL?.trim();
  return clientId && clientSecret && callbackUrl ? { clientId, clientSecret, callbackUrl } : undefined;
}

function trustProxyFromEnv(value: string | undefined): boolean | string[] | undefined {
  const v = value?.trim();
  if (!v || v === "0") return undefined;
  return v === "1" || v === "true" ? true : v.split(",").map((s) => s.trim()).filter(Boolean);
}

function autodeskAuthFromEnv() {
  const clientId = process.env.AUTODESK_CLIENT_ID?.trim();
  const callbackUrl = process.env.AUTODESK_CALLBACK_URL?.trim();
  const clientSecret = process.env.AUTODESK_CLIENT_SECRET?.trim() || undefined;
  return clientId && callbackUrl ? { clientId, callbackUrl, clientSecret } : undefined;
}
