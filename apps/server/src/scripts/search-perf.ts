/**
 * Document search load test (issue #191): seeds a project with 100 000 file versions (50 000 files,
 * two versions each, text for every current version) into an EMPTY database and times searches
 * through the API, as a project-wide reader and as a user who can read half of the folders.
 *
 *   createdb sk_search_perf
 *   DATABASE_URL=postgres://localhost/sk_search_perf npm run perf:search -w @sitekeep/server
 *   dropdb sk_search_perf
 *
 * FILES=… changes the number of files (versions = 2 × files). Runs on PGlite too (DATABASE_URL
 * unset: in memory), which has no trigram indexes; expect it to be much slower there.
 */
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../app/build-app.js";
import { hashPassword } from "../core/security/auth.js";
import { LocalStorage } from "../core/platform/storage.js";
import { openDb } from "../db/index.js";
import { projects, users } from "../db/schema.js";
import { JobQueue } from "../jobs/queue.js";

const FILES = Number(process.env.FILES ?? 50_000);
const FOLDERS = 200;
const PW = "Sifre-1234567";

const WORDS = (
  "istasyon kolon kiriş döşeme temel perde duvar beton donatı çelik kalıp iskele aks kot plan kesit görünüş detay " +
  "mimari statik mekanik elektrik tesisat yangın havalandırma iklimlendirme aydınlatma topraklama pano kablo tava " +
  "zemin etüdü sondaj kazık radye bodrum çatı cephe pencere kapı merdiven asansör rampa otopark peron ray hat tünel " +
  "viyadük köprü menfez drenaj yağmur suyu atık su içme suyu yol kaplama asfalt bordür tretuvar peyzaj ağaç sulama " +
  "rapor hesap şartname metraj keşif hakediş tutanak toplantı yazı onay revizyon teslim sözleşme program iş takvim"
).split(" ");

async function main() {
  const url = process.env.DATABASE_URL || "memory://";
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-search-perf-"));
  const handle = await openDb(url);
  const db = handle.db;
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const app = await buildApp({ db, storage, jobs: new JobQueue(db, storage) });
  const call = async (cookie: string, method: string, u: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url: `/api/v1${u}`, headers: { cookie }, payload: payload as object });
    if (res.statusCode >= 400) throw new Error(`${method} ${u}: ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    return `cde_session=${res.cookies.find((c) => c.name === "cde_session")!.value}`;
  };

  try {
    // A second run reuses the seeded project (same database).
    const [seeded] = await db.select({ id: projects.id }).from(projects).where(eq(projects.code, "PERF"));
    let pid = seeded?.id ?? "";
    if (!seeded) {
      const [existing] = await db.select({ id: users.id }).from(users).limit(1);
      if (existing) throw new Error("Use an empty database: this script creates its own users and project.");
      await db.insert(users).values({ email: "admin@perf.test", name: "Admin", passwordHash: await hashPassword(PW), isAdmin: true });
      const admin = await login("admin@perf.test");
      const reader = (await call(admin, "POST", "/users", { email: "reader@perf.test", name: "Reader", password: PW })).id as string;
      const partial = (await call(admin, "POST", "/users", { email: "partial@perf.test", name: "Partial", password: PW })).id as string;
      const project = await call(admin, "POST", "/projects", { code: "PERF", name: "Arama yük testi" });
      pid = project.id as string;
      for (const email of ["reader@perf.test", "partial@perf.test"]) await call(admin, "POST", `/projects/${pid}/members`, { email });
      const root = await call(admin, "GET", `/projects/${pid}/folders/${project.rootFolderId}/contents`);
      const stateFolders = (root.folders as { id: string; state: string | null }[]).filter((f) => f.state);
      await call(admin, "PUT", `/projects/${pid}/folders/${project.rootFolderId}/permissions`, {
        entries: [{ subjectType: "user", subjectId: reader, level: "view" }],
      });

      const t0 = Date.now();
      // Folders: FOLDERS under the state folders; the partial user reads every second one.
      const folderIds: string[] = [];
      for (let i = 0; i < FOLDERS; i++) {
        const parent = stateFolders[i % stateFolders.length]!;
        const f = await call(admin, "POST", `/projects/${pid}/folders`, { parentId: parent.id, name: `Paket ${String(i).padStart(3, "0")}` });
        folderIds.push(f.id);
        if (i % 2 === 0)
          await call(admin, "PUT", `/projects/${pid}/folders/${f.id}/permissions`, { entries: [{ subjectType: "user", subjectId: partial, level: "view" }] });
      }
      const [adm] = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@perf.test"));
      const adminId = adm!.id;
      const words = `{${WORDS.map((w) => `"${w}"`).join(",")}}`;
      const exts = `{pdf,dwg,docx,xlsx,ifc,txt}`;
      const folderArr = `{${folderIds.join(",")}}`;
      // Files, in batches (one statement per 10 000 files).
      for (let start = 0; start < FILES; start += 10_000) {
        const end = Math.min(FILES, start + 10_000);
        await db.execute(sql`
          insert into files (project_id, folder_id, name, current_version, attributes, created_by)
          select ${pid}::uuid,
            (${folderArr}::uuid[])[1 + (g % ${FOLDERS})],
            'PRJ-ZN-' || lpad(g::text, 6, '0') || ' ' || (${words}::text[])[1 + (g * 7) % ${WORDS.length}] || ' ' ||
              (${words}::text[])[1 + (g * 13) % ${WORDS.length}] || '.' || (${exts}::text[])[1 + g % 6],
            2,
            jsonb_build_object('Disiplin', (array['MİM','STA','MEK','ELK'])[1 + g % 4], 'Bölge', 'Z' || (g % 20)),
            ${adminId}::uuid
          from generate_series(${start}::int, ${end - 1}::int) g`);
        process.stdout.write(`files ${end}\r`);
      }
      await db.execute(sql`
        insert into file_versions (file_id, version, storage_key, size, sha256, uploaded_by, uploaded_at, suitability_code, revision_code)
        select f.id, v, 'perf/' || f.id || '/' || v, (abs(hashtext(f.id::text)) % 5000000) + 1000, 'x', ${adminId}::uuid,
          now() - ((abs(hashtext(f.id::text || v)) % 700) || ' days')::interval,
          (array['S0','S1','S2','S3','A1'])[1 + abs(hashtext(f.id::text)) % 5], 'P0' || v || '.01'
        from files f cross join generate_series(1, 2) v where f.project_id = ${pid}::uuid`);
      // Text of each current version: ~250 words (about 2 000 characters), PDF-like with page breaks.
      await db.execute(sql`
        insert into version_texts (version_id, project_id, source, content)
        select fv.id, ${pid}::uuid, 'pdf',
          (select string_agg(
                    case when i % 80 = 0 then E'\\n\\f\\n' else '' end ||
                    (${words}::text[])[1 + abs(hashtext(fv.id::text || i)) % ${WORDS.length}], ' ')
             from generate_series(1, 250) i)
        from file_versions fv join files f on f.id = fv.file_id
        where f.project_id = ${pid}::uuid and fv.version = 2`);
      // A rare phrase in a few texts.
      await db.execute(sql`
        update version_texts set content = content || ' nadir-ifade kırmızı zürafa'
        where version_id in (select version_id from version_texts where project_id = ${pid}::uuid limit 5)`);
      await db.execute(sql`analyze`);
      console.log(`\nseeded ${FILES} files / ${FILES * 2} versions / ${FILES} texts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }

    const cases: [string, string][] = [
      ["common word (content)", "q=istasyon&limit=50"],
      ["exact code in name", "q=PRJ-ZN-004217&limit=50"],
      ["rare phrase in content", `q=${encodeURIComponent('"kırmızı zürafa"')}&limit=50`],
      ["OR / NOT", `q=${encodeURIComponent("(kolon OR kiriş) NOT taslak")}&limit=50`],
      ["inner wildcard (every text)", "q=ista*on&limit=50"],
      ["leading wildcard (every text)", "q=*tasyon&limit=50"],
      ["leading wildcard (rare)", "q=*rafa&limit=50"],
      ["names + attributes only", "q=kolon&content=0&limit=50"],
      ["filters only, sort by date", "ext=dwg&state=shared&suitability=S2&sort=date&limit=50"],
      ["query + filters", "q=temel&ext=dwg,docx&attr.Disiplin=STA&limit=50"],
      ["page 20", "q=beton&sort=name&limit=50&offset=950"],
    ];
    const users_ = { reader: await login("reader@perf.test"), partial: await login("partial@perf.test") };
    console.log(`\n${"case".padEnd(30)} ${"user".padEnd(8)} ${"total".padStart(7)} ${"median".padStart(8)} ${"max".padStart(8)}`);
    for (const [label, qs] of cases) {
      for (const [who, cookie] of Object.entries(users_)) {
        await call(cookie, "GET", `/projects/${pid}/search?${qs}`); // warm-up
        const times: number[] = [];
        let total = 0;
        for (let i = 0; i < 5; i++) {
          const s = performance.now();
          const r = await call(cookie, "GET", `/projects/${pid}/search?${qs}`);
          times.push(performance.now() - s);
          total = r.total;
        }
        times.sort((x, y) => x - y);
        console.log(
          `${label.padEnd(30)} ${who.padEnd(8)} ${String(total).padStart(7)} ${`${times[2]!.toFixed(0)} ms`.padStart(8)} ${`${times[4]!.toFixed(0)} ms`.padStart(8)}`,
        );
      }
    }
  } finally {
    await app.close();
    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
