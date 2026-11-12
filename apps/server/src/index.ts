import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { buildApp } from "./app/build-app.js";
import { activeModules } from "./app/modules.js";
import { hashPassword, passwordProblem } from "./core/security/auth.js";
import { openDb } from "./db/index.js";
import { recordServerError } from "./core/platform/error-ring.js";
import { users } from "./db/schema.js";
import { JobQueue } from "./jobs/queue.js";
import { Converters } from "./previews/converters.js";
import { loadSecretKey } from "./core/platform/secrets.js";
import { upgradeSeededLabels } from "./projects/seeded-labels.js";
import { startDueReminders } from "./workflow/reminders.js";
import { LocalStorage } from "./core/platform/storage.js";
import { reportLlmFromEnv } from "./reports/llm.js";
import { mailerFromEnv } from "./works/letter.js";
import { startOutboundCleanup } from "./privacy/outbound.js";
import { FALLBACK_LANGUAGE, render } from "./i18n/index.js";
import { editionName } from "./app/module-ids.js";

/**
 * Configuration (environment):
 *   PORT               default 8080
 *   HOST               default 0.0.0.0
 *   DATA_DIR           default ./data — files, derivatives and the embedded database
 *   DATABASE_URL       postgres://… ; when unset an embedded PGlite database in DATA_DIR/db is used
 *   ADMIN_EMAIL        first administrator, created when the user table is empty
 *   ADMIN_PASSWORD
 *   WEB_DIST           built web app to serve (default ../web/dist)
 *   SECURE_COOKIES     "1" behind HTTPS
 *   CDE_SECRET_KEY     32-byte key (hex or base64) encrypting AI provider API keys at rest;
 *                      when unset, DATA_DIR/secret.key is generated once (back it up with the database)
 *   AI_BASE_URL        OpenAI-compatible endpoint for the report builder (default http://127.0.0.1:11434/v1)
 *   AI_MODEL           default qwen3:8b; the builder is on when AI_BASE_URL or AI_MODEL is set, or AI_ENABLED=1
 *   AI_API_KEY         optional bearer key; AI_TIMEOUT_MS optional; AI_ENABLED=0 turns the builder off
 *   REPORT_TZ          time zone of report date buckets (default Europe/Istanbul)
 *   CDE_SMTP_URL       optional SMTP server for official letters, e.g. smtp://user:pass@mail.local:587
 *   CDE_SMTP_FROM      sender address for those e-mails; without both, letters are e-mailed by hand (.eml)
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
// Default labels templates wrote before they became Title Case ("İş sonu" → "İş Sonu").
await upgradeSeededLabels(db);

const converters = new Converters();
const app = await buildApp({
  db,
  converters,
  storage,
  jobs,
  webDist: process.env.WEB_DIST ?? path.resolve(here, "../../web/dist"),
  secureCookies: process.env.SECURE_COOKIES === "1",
  trustProxy: trustProxyFromEnv(process.env.CDE_TRUST_PROXY),
  secretKey: loadSecretKey(dataDir),
  logger: true,
  reportLlm: reportLlmFromEnv(),
  mailer: mailerFromEnv(),
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
// Gizlilik Merkezi: outbound log rows older than the retention setting (default 90 days), daily.
const stopOutboundCleanup = startOutboundCleanup(db, { log: (m, e) => console.error(m, e) });
// Modules' background work (Connect: Autodesk sync scheduler and interrupted file imports).
const stopModules: (() => void)[] = [];
for (const m of activeModules()) if (m.start) stopModules.push(await m.start({ db, jobs, log: (msg, e) => console.error(msg, e) }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopReminders();
    stopOutboundCleanup();
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
  const problem = passwordProblem(password);
  if (problem) {
    console.error(`ADMIN_PASSWORD: ${render(FALLBACK_LANGUAGE, problem)}`);
    process.exit(1);
  }
  await db.insert(users).values({ email, name: "Yönetici", passwordHash: await hashPassword(password), isAdmin: true }); // i18n-ok: stored display name
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
