/**
 * One local test project with hundreds of forms, reviews, documents and works,
 * most of them past their due date, so Bugün and the lists can be judged under load.
 *
 *   npm run seed:load
 *   npm run seed:load -- --remove
 *
 * Uses the same DATA_DIR as `npm run dev`. Stop that server first: PGlite allows one process.
 * The project code is YUK-TEST. The same tag is created once.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { AskBridge } from "../core/platform/ask-bridge.js";
import { buildApp } from "../app/build-app.js";
import type { ResolvedDeps } from "../app/deps.js";
import { hashPassword } from "../core/security/auth.js";
import { loadSecretKey } from "../core/platform/secrets.js";
import { LocalStorage } from "../core/platform/storage.js";
import type { AuthUser } from "../core/security/access.js";
import { openDb } from "../db/index.js";
import { files, users } from "../db/schema.js";
import { ensureActors, ensureSeedFolder } from "../dev/actors.js";
import { createDevContext } from "../dev/context.js";
import { devProject } from "../dev/project.js";
import { findProject } from "../dev/registry.js";
import { devSeed } from "../dev/seed.js";
import { uploadFile } from "../dev/upload.js";
import { JobQueue } from "../jobs/queue.js";

const CODE = "YUK-TEST";
const TAG = "yuk";
const DOCUMENTS = 200;
const COUNTS = {
  incomingLetters: 140,
  outgoingLetters: 40,
  rfis: 80,
  submittals: 40,
  meetings: 8,
  transmittals: 8,
  issues: 180,
  reviews: 100,
  forms: 120,
  schedule: false,
  clashes: false,
};

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, "data"));
const dbUrl = process.env.DATABASE_URL || path.join(dataDir, "db");
const remove = process.argv.includes("--remove");

const tinyPdf = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 40 100 Td (Yuk dosyasi) Tj ET\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const handle = await openDb(dbUrl);
const storage = new LocalStorage(path.join(dataDir, "storage"));
const jobs = new JobQueue(handle.db, storage);
await ensureAdmin(handle.db);
const webUrl = process.env.CDE_WEB_URL ?? "http://localhost:5173";
const askBridge = new AskBridge();
const app = await buildApp({
  db: handle.db,
  storage,
  jobs,
  askBridge,
  secretKey: loadSecretKey(dataDir),
  logger: false,
  dbKind: handle.kind,
  webUrl,
});
try {
  const admin = await adminUser(handle.db);
  const ctx = createDevContext(app, { db: handle.db, askBridge, webUrl } as ResolvedDeps, admin);
  try {
    const project = await ensureProject(ctx);
    if (remove) {
      const removed = await devSeed(ctx, { project: project.code, tag: TAG, action: "remove", confirm: true });
      console.log(JSON.stringify({ ok: true, removed }, null, 2));
    } else {
      console.log(`Seeding ${project.code}. Forms, reviews and letters go through the real routes; this takes several minutes.`);
      const seeded = await devSeed(ctx, {
        project: project.code,
        tag: TAG,
        counts: COUNTS,
        overdueRatio: 0.92,
        backdateDays: 120,
        confirm: true,
      });
      console.log(JSON.stringify(seeded, null, 2));
      const documents = await documentsSeed(ctx, project.id);
      const today = await ctx.call<{ counts: { mine: number; overdue: number; upcoming: number } }>("GET", `/projects/${project.id}/today?ai=0`);
      console.log(
        JSON.stringify(
          {
            ok: true,
            projectId: project.id,
            code: project.code,
            documents,
            today: today.counts,
            url: `http://localhost:5173/projects/${project.id}/today`,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    ctx.close();
  }
} finally {
  await app.close();
  await handle.close();
}

async function ensureAdmin(db: typeof handle.db) {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length) return;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Veritabanında kullanıcı yok. ADMIN_EMAIL ve ADMIN_PASSWORD gerekli.");
  await db.insert(users).values({ email, name: "Yönetici", passwordHash: await hashPassword(password), isAdmin: true });
}

async function adminUser(db: typeof handle.db): Promise<AuthUser> {
  const [u] = await db.select().from(users).where(eq(users.isAdmin, true)).limit(1);
  if (!u) throw new Error("Sistem yöneticisi bulunamadı.");
  return { id: u.id, email: u.email, name: u.name, isAdmin: true, companyId: u.companyId };
}

async function ensureProject(ctx: ReturnType<typeof createDevContext>) {
  try {
    const found = await findProject(ctx.db, CODE);
    return { id: found.id, code: found.code };
  } catch {
    const created = (await devProject(ctx, {
      action: "create",
      code: CODE,
      name: "Arayüz Yük Testi",
      template: "iso19650",
      members: true,
    })) as { id: string; code: string };
    console.log(`Created ${created.code}`);
    return created;
  }
}

/** Extra files in the seed folder, so Dokümanlar is long even apart from review drawings. */
async function documentsSeed(ctx: ReturnType<typeof createDevContext>, projectId: string) {
  const actors = await ensureActors(ctx, projectId);
  const folderId = await ensureSeedFolder(ctx, projectId, actors.all.map((x) => x.companyId));
  const [have] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.folderId, folderId), sql`${files.name} like 'YUK-DOK-%'`, sql`${files.deletedAt} is null`));
  const already = Number(have?.n ?? 0);
  const call = await ctx.as(actors.contractor.userId);
  let added = 0;
  for (let i = already; i < DOCUMENTS; i++) {
    const name = `YUK-DOK-${String(i + 1).padStart(3, "0")}.pdf`;
    await uploadFile(call, projectId, folderId, { name, data: tinyPdf }, { comment: "Arayüz yük testi" });
    added++;
    if (added % 50 === 0) console.log(`documents ${already + added}/${DOCUMENTS}`);
  }
  const specs = await specRegistersSeed(ctx, call, projectId, folderId);
  return { folderId, total: already + added, added, specs };
}

type SpecPage = (readonly [string, number])[];

const SAMPLE_SPECS: { name: string; title: string; pages: SpecPage[] }[] = [
  {
    name: "YUK-SARTNAME-01-Betonarme-ve-Celik-Yapilar-Teknik-Sartnamesi.pdf",
    title: "YUK-TEST Insaat ve Betonarme Isleri Teknik Sartnamesi",
    pages: [
      [
        ["BOLUM 1 - GENEL HUKUMLER VE KALITE KONTROL", 12],
        ["1.1 Kapsam ve Kalite Plani", 11],
        ["Yuklenici, ise baslamadan once detayli is programini ve kalite planini idarenin onayina sunacaktir.", 10],
        ["Saha mobilizasyonu oncesinde is sagligi ve guvenligi plani ile risk analizi onaya sunulacaktir.", 10],
        ["03 30 00 YERINDE DOKME BETON ISLERI", 12],
        ["Yuklenici, kullanilacak beton siniflari icin karisim tasarimini ve katki malzemelerinin teknik foylerini", 10],
        ["idareye sunacaktir. Her dokum oncesi imalat kontrol onay formu duzenlenecektir.", 10],
        ["Beton numuneleri icin 7 ve 28 gunluk basinc deney raporlari kontrol teskilatina sunulacaktir.", 10],
        ["Kalip ve iskele sistemleri icin atolye cizimleri ve statik hesap raporu onaya sunulacaktir.", 10],
      ],
      [
        ["05 12 00 YAPISAL CELIK ISLERI", 12],
        ["Celik profiller ve bulonlar icin fabrika test sertifikalari ve CE uygunluk belgesi onaya sunulacaktir.", 10],
        ["Celik birlesim detaylari icin imalat resimleri ve kaynak yontem beyani musavire sunulacaktir.", 10],
        ["Yangin boyasi uygulamasi oncesi urun katalogu ve ornek uygulama numunesi onaya verilecektir.", 10],
        ["07 10 00 SU VE ISI YALITIMI", 12],
        ["Temel ve perde su yalitim membranlari icin teknik foy, TSE belgesi ve numune onaya sunulacaktir.", 10],
        ["Yalitim uygulama yontemi icin detayli yontem beyani hazirlanarak idareye sunulacaktir.", 10],
      ],
    ],
  },
  {
    name: "YUK-SARTNAME-02-Mekanik-Tesisat-HVAC-Teknik-Sartnamesi.pdf",
    title: "YUK-TEST Mekanik Tesisat ve Iklimlendirme Teknik Sartnamesi",
    pages: [
      [
        ["23 00 00 ISITMA SOGUTMA VE HAVALANDIRMA (HVAC)", 12],
        ["Klima santralleri, sogutma gruplari (chiller) ve fan-coil cihazlari icin teknik foy ve kataloglar", 10],
        ["idarenin onayina sunulacaktir.", 10],
        ["Havalandirma kanallari ve mekanik tesisat borulama guzergahlari icin uygulama cizimleri (shop drawing)", 10],
        ["hazirlanacak ve imalata baslamadan once onaya sunulacaktir.", 10],
        ["Isi kaybi, isi kazanci ve kanal basinc kaybi hesap raporu kontrol muhendisine sunulacaktir.", 10],
      ],
      [
        ["21 10 00 YANGIN SONDURME SISTEMLERI", 12],
        ["Yangin pompalari ve sprinkler basliklari icin UL/FM sertifikasi ve urun bilgi foyu onaya sunulacaktir.", 10],
        ["Hidrolik hesap raporu ve saha montaj yontem beyani idareye sunulacaktir.", 10],
        ["22 00 00 SIHHI TESISAT ISLERI", 12],
        ["Temiz su ve atik su borulari icin malzeme numunesi ve basinc test raporu onaya sunulacaktir.", 10],
        ["Basincli kaplar ve genlesme tanklari icin periyodik muayene raporu teslim edilecektir.", 10],
      ],
    ],
  },
  {
    name: "YUK-SARTNAME-03-Elektrik-ve-Zayif-Akim-Teknik-Sartnamesi.pdf",
    title: "YUK-TEST Elektrik ve Zayif Akim Sistemleri Teknik Sartnamesi",
    pages: [
      [
        ["26 00 00 KUVVETLI AKIM ELEKTRIK TESISATI", 12],
        ["Ana dagitim panolari, trafo, jenerator ve UPS sistemleri icin teknik foy ve kataloglar onaya sunulacaktir.", 10],
        ["Pano tek hat semalari ve kablo tavasi guzergahlari icin atolye cizimleri onaya sunulacaktir.", 10],
        ["Kisa devre, gerilim dusumu ve aydinlatma hesap raporu idareye sunulacaktir.", 10],
        ["Aydinlatma armaturleri ve anahtar-priz gruplari icin numune ve TSE uygunluk belgesi onaya sunulacaktir.", 10],
      ],
      [
        ["27 00 00 ZAYIF AKIM VE OTOMASYON SISTEMLERI", 12],
        ["Yangin algilama, kamera (CCTV) ve kartli gecis ekipmanlari icin teknik dokuman onaya sunulacaktir.", 10],
        ["Topraklama ve paratoner tesisati icin olcum ve test raporu kontrol teskilatina sunulacaktir.", 10],
        ["Kablo cekimi ve devreye alma calismalari icin yontem beyani ve ITP kalite plani onaya sunulacaktir.", 10],
      ],
    ],
  },
];

async function buildSpecPdf(title: string, pages: SpecPage[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((lines, idx) => {
    const page = doc.addPage([595, 842]);
    page.drawText(title, { x: 50, y: 810, size: 9, font });
    lines.forEach(([text, size], i) => page.drawText(text, { x: 50, y: 765 - i * 20, size, font }));
    page.drawText(`Sayfa ${idx + 1} / ${pages.length}`, { x: 265, y: 24, size: 8, font });
  });
  return Buffer.from(await doc.save());
}

async function specRegistersSeed(
  ctx: ReturnType<typeof createDevContext>,
  call: Awaited<ReturnType<ReturnType<typeof createDevContext>["as"]>>,
  projectId: string,
  folderId: string,
) {
  let built = 0;
  for (const s of SAMPLE_SPECS) {
    const [existing] = await ctx.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.folderId, folderId), eq(files.name, s.name), sql`${files.deletedAt} is null`));
    const fileId =
      existing?.id ??
      (await uploadFile(call, projectId, folderId, { name: s.name, data: await buildSpecPdf(s.title, s.pages) }, { comment: "Teknik şartname" })).fileId;
    const detail = await call<{ latest: { id: string } }>("GET", `/projects/${projectId}/files/${fileId}`);
    await call("POST", `/projects/${projectId}/docintel/spec-register`, { versionId: detail.latest.id, ai: false });
    built++;
  }
  return built;
}
