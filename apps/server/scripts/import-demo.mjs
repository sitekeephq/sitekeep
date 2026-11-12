// Creates realistic DEMO projects in a running SiteKeep server from structure snapshots.
//
//   node --env-file=apps/server/.env.development apps/server/scripts/import-demo.mjs [options]
//
// Snapshots (data-import/<KOD>.json, gitignored) hold only STRUCTURE and AGGREGATES read from
// Forma: folder paths with file counts, naming standard, attribute definitions, review template
// structure, companies and their roles, totals and distributions. Every record created here
// (files, versions, attribute values, reviews, issues) is synthetic.
//
// Options:
//   --dir <path>       snapshot folder (default: <repo>/data-import)
//   --only <KOD>       only this project code (e.g. PKF-DEMO); repeatable
//   --cap <n>          max files per project (default 4000; real counts are scaled down)
//   --reviews <n>      max reviews per project (default 150)
//   --issues <n>       issues per project (default 100)
//   --concurrency <n>  parallel requests (default 4)
//   --suffix <text>    appended to every project code (e.g. "-2" → PKF-DEMO-2), for a second copy
//   --resume           continue a project with the same code whose import stopped half-way
//   --dry-run          build the plan and print counts without calling the server
//
// Demo users get the password ADMIN_PASSWORD (development only). A project whose code already
// exists is skipped (or completed with --resume). When the dev server restarts (tsx watch), requests
// wait for /health and are retried.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const args = parseArgs(process.argv.slice(2));
const dir = path.resolve(args.dir ?? path.join(repo, "data-import"));
const CAP = Number(args.cap ?? 4000);
const MAX_REVIEWS = Number(args.reviews ?? 150);
const ISSUES = Number(args.issues ?? 100);
const CONCURRENCY = Number(args.concurrency ?? 4);
const DRY = !!args["dry-run"];
const base = `http://127.0.0.1:${process.env.PORT ?? 8787}/api/v1`;
const password = process.env.ADMIN_PASSWORD;
const TODAY = new Date().toISOString().slice(0, 10);
const BODY = "SiteKeep demo verisi — üretilmiş";

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    const value = next && !next.startsWith("--") ? (i++, next) : true;
    if (key === "only") (out.only ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

// ---- HTTP ---------------------------------------------------------------------------------------

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = "";
  }
  async call(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const isForm = body instanceof FormData;
      let res;
      try {
        res = await fetch(base + url, {
          method,
          headers: { cookie: this.cookie, ...(body && !isForm ? { "content-type": "application/json" } : {}) },
          body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // The dev server restarts when its code changes (tsx watch): wait and retry. A folder POST
        // may have been applied before the connection dropped, so the caller checks before retrying.
        if (attempt >= 5) throw e;
        await waitHealthy();
        if (method === "POST" && /\/folders$/.test(url)) {
          const err = new Error(`${this.label}: ${method} ${url} → bağlantı koptu`);
          err.code = "NET";
          throw err;
        }
        continue;
      }
      const set = res.headers.get("set-cookie");
      if (set) this.cookie = set.split(";")[0];
      const text = await res.text();
      if ((res.status === 429 || res.status >= 502) && attempt < 4) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const err = new Error(`${this.label}: ${method} ${url} → ${res.status} ${text.slice(0, 400)}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }
  }
  get(url) {
    return this.call("GET", url);
  }
  post(url, body) {
    return this.call("POST", url, body ?? {});
  }
  put(url, body) {
    return this.call("PUT", url, body);
  }
  patch(url, body) {
    return this.call("PATCH", url, body);
  }
}

/** JSON with sorted keys, to compare what the server stored with what was sent. */
const canonical = (v) =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    await sleep(2500);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // still restarting
    }
  }
  throw new Error("Sunucu 5 dakika içinde geri gelmedi.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email) {
  const c = new Client(email);
  await c.post("/auth/login", { email, password });
  return c;
}

/** Runs fn over items with at most n in flight; keeps order of results. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- Random -------------------------------------------------------------------------------------

function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const r = rng(seed);
  const api = {
    next: r,
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    pick: (list) => list[Math.floor(r() * list.length)],
    chance: (p) => r() < p,
    /** Picks a key of a { key: weight } object. */
    weighted(weights) {
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let x = r() * total;
      for (const [k, w] of entries) {
        x -= w;
        if (x <= 0) return k;
      }
      return entries.at(-1)?.[0];
    },
    /** Splits n into integer parts proportional to the weights (largest remainder). */
    apportion(n, weights) {
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      const total = entries.reduce((s, [, w]) => s + w, 0) || 1;
      const raw = entries.map(([k, w]) => [k, (n * w) / total]);
      const out = Object.fromEntries(raw.map(([k, v]) => [k, Math.floor(v)]));
      let left = n - Object.values(out).reduce((s, v) => s + v, 0);
      for (const [k] of [...raw].sort((a, b) => (b[1] % 1) - (a[1] % 1))) {
        if (left-- <= 0) break;
        out[k]++;
      }
      return out;
    },
  };
  return api;
}

// ---- Dates --------------------------------------------------------------------------------------

const toDate = (s) => new Date(`${s.length === 7 ? `${s}-01` : s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400_000);

function dateSampler(snapshot, R) {
  const start = toDate(snapshot.project.start);
  const endRaw = toDate(snapshot.project.activityEnd ?? snapshot.project.end ?? TODAY);
  const end = endRaw > toDate(TODAY) ? toDate(TODAY) : endRaw;
  const byMonth = snapshot.stats?.activityByMonth ?? snapshot.stats?.reviews?.byMonth;
  const months = byMonth
    ? Object.fromEntries(Object.entries(byMonth).filter(([m]) => toDate(m) <= end && addDays(toDate(m), 31) >= start))
    : null;
  return () => {
    if (months && Object.keys(months).length) {
      const m = toDate(R.weighted(months));
      const d = addDays(m, R.int(0, 27));
      return d > end ? end : d < start ? start : d;
    }
    // Uniform over the project, slightly more towards the middle.
    const t = (R.next() + R.next()) / 2;
    return new Date(start.getTime() + t * (end.getTime() - start.getTime()));
  };
}

// ---- Snapshot -> plan -----------------------------------------------------------------------------

const BAD_CHARS = /[\\/:*?"<>|]/g;
const cleanName = (n) => n.replace(BAD_CHARS, "-").replace(/\s+/g, " ").trim().slice(0, 200) || "-";

/** Parses the indented tree ("  name [12]" / "<<synthetic …>>") into folder entries. */
function parseTree(lines) {
  const folders = [];
  const stack = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const depth = (raw.length - raw.trimStart().length) / 2;
    const line = raw.trim();
    stack.length = depth;
    const parent = depth ? stack[depth - 1] : null;
    const synth = /^<<synthetic\s+(\d+)\s+(\d+)(?:\s+(.+))?>>$/.exec(line);
    if (synth) {
      // Placeholder for N record-named subfolders (names not taken): generate synthetic ones.
      parent.synthetic = { count: Number(synth[1]), files: Number(synth[2]), pattern: synth[3] ?? "Yazı DEMO-{yyyy}-{nnnn}" };
      continue;
    }
    const m = /^(.*?)(?:\s+\[(\d+)\])?$/.exec(line);
    const name = cleanName(m[1]);
    const entry = { name, path: parent ? `${parent.path}/${name}` : name, files: Number(m[2] ?? 0), parent };
    folders.push(entry);
    stack[depth] = entry;
  }
  return folders;
}

function underPath(p, prefix) {
  return p === prefix || p.startsWith(`${prefix}/`);
}

function longestRule(rules, p) {
  let best = null;
  for (const r of rules ?? []) if (underPath(p, r.path) && (!best || r.path.length > best.path.length)) best = r;
  return best;
}

// ---- Naming -----------------------------------------------------------------------------------------

function legacyStandard(def) {
  const fields = def.fields
    .filter((f) => f.inName !== false)
    .map((f) => {
      if (f.type === "list") return { name: f.name, type: "list", values: f.values.filter((v) => !v.code.includes(def.delimiter)) };
      if (f.type === "number") return { name: f.name, type: "number", digits: f.maxDigits ?? f.digits };
      const { inName, ...rest } = f;
      return rest;
    });
  return { name: def.name, delimiter: def.delimiter, fields, ...(def.allowSuffix ? { allowSuffix: true } : {}) };
}

const DISCIPLINE_SYSTEM = [
  [/mimari/i, ["00", "01"]],
  [/yapısal|statik|kaba/i, ["01"]],
  [/geoteknik|kazı|tünel|natm|tbm/i, ["01"]],
  [/elektronik|haberleşme|scada/i, ["04"]],
  [/elektrik|enerji|cer/i, ["02"]],
  [/mekanik|havalandırma|tesisat/i, ["05", "06"]],
  [/altyapı|deplase|trafik/i, ["01", "08"]],
  [/güzergah|hat üst|demiryolu|ray/i, ["08"]],
  [/sinyal/i, ["03"]],
  [/koordinasyon|bim/i, ["11", "10", "A1"]],
  [/asansör|yürüyen/i, ["07"]],
];

const DOC_CATEGORY = [
  [/model/i, "6", ["rvt", "nwd", "nwc"]],
  [/çizim|pafta|proje/i, "2", ["pdf", "dwg"]],
  [/rapor|hesap|data|veri/i, "1", ["pdf", "xlsx", "docx"]],
  [/tutanak|form|toplantı|yazı/i, "7", ["pdf"]],
];

class NameMaker {
  constructor(snapshot, R, v2) {
    this.snap = snapshot;
    this.R = R;
    this.v2 = v2;
    this.def = v2 ? snapshot.naming.definition : legacyStandard(snapshot.naming.definition);
    this.roles = snapshot.naming.fieldRoles ?? {};
    this.counters = new Map();
    this.fieldByName = new Map(this.def.fields.map((f) => [f.name, f]));
    this.zoneCodes = new Set(this.list("zone").map((v) => v.code));
  }
  list(role) {
    const f = this.fieldByName.get(this.roles[role]);
    return f?.type === "list" ? f.values : [];
  }
  codeIn(role, wanted) {
    const codes = new Set(this.list(role).map((v) => v.code));
    return wanted.find((c) => codes.has(c));
  }
  zoneFor(p) {
    const segs = p.split("/");
    let zone = null;
    for (const s of segs) {
      const tok = s.split(/\s+/)[0];
      for (const t of [tok, tok.split("-")[0], tok.split("_")[0], tok.replace(/[^A-Z0-9-]/g, "")]) if (this.zoneCodes.has(t)) zone = t;
    }
    if (zone) return zone;
    if (/istasyon/i.test(p)) return this.codeIn("zone", ["S00", "G00"]);
    if (/hat yap|tünel/i.test(p)) return this.codeIn("zone", ["L00"]);
    if (/güzergah/i.test(p)) return this.codeIn("zone", ["G00", "L00"]);
    return this.codeIn("zone", ["000"]);
  }
  /** Synthetic name + attributes derived from the name fields. */
  make(folderPath, company) {
    const R = this.R;
    const values = {};
    const docCat = DOC_CATEGORY.find(([re]) => re.test(folderPath.split("/").slice(-1)[0])) ??
      DOC_CATEGORY.find(([re]) => re.test(folderPath)) ?? [null, null, ["pdf"]];
    for (const f of this.def.fields) {
      if (f.inName === false) continue;
      const role = Object.entries(this.roles).find(([, n]) => n === f.name)?.[0];
      if (f.type === "number") continue;
      if (f.type === "text") {
        values[f.name] = "DEMO";
        continue;
      }
      const codes = f.values.map((v) => v.code);
      let code = null;
      switch (role) {
        case "contractor":
        case "project":
          code = codes[0];
          break;
        case "subcontractor":
          code = (company?.code && codes.includes(company.code) ? company.code : null) ?? (R.chance(0.8) ? codes[0] : R.pick(codes));
          break;
        case "zone":
          code = this.zoneFor(folderPath);
          break;
        case "system": {
          const hit = DISCIPLINE_SYSTEM.find(([re]) => re.test(folderPath));
          const opts = hit ? hit[1].filter((c) => codes.includes(c)) : [];
          code = opts.length ? R.pick(opts) : R.pick(codes);
          break;
        }
        case "phase": {
          const want = /as-?built|iş sonu/i.test(folderPath)
            ? ["A"]
            : /malzeme/i.test(folderPath)
              ? ["Y"]
              : /alt yüklenici/i.test(folderPath)
                ? ["Z"]
                : /kesin/i.test(folderPath)
                  ? ["K"]
                  : R.chance(0.6)
                    ? ["U"]
                    : ["K", "U", "G"];
          code = R.pick(want.filter((c) => codes.includes(c)).concat(codes.includes("U") ? [] : [codes[0]]));
          break;
        }
        case "language":
          code = codes.includes("T") && R.chance(0.9) ? "T" : R.pick(codes);
          break;
        case "docType": {
          const prefix = docCat[1];
          // Folders without a model/drawing/report hint get management documents (plans, reports, forms).
          const opts = codes.filter((c) => (prefix ? c.startsWith(prefix) : /^[179]/.test(c)));
          code = opts.length ? (prefix === "6" && R.chance(0.35) && opts.includes("6K") ? "6K" : R.pick(opts)) : R.pick(codes);
          break;
        }
        default:
          code = R.chance(0.5) ? codes[0] : R.pick(codes);
      }
      values[f.name] = code ?? codes[0];
    }
    const d = this.def.delimiter;
    const prefixParts = this.def.fields.filter((f) => f.inName !== false && f.type !== "number").map((f) => values[f.name]);
    const key = prefixParts.join(d);
    const numField = this.def.fields.find((f) => f.type === "number" && f.inName !== false);
    let n = this.counters.get(key) ?? R.int(1, 8) * 10;
    n += R.chance(0.7) ? 1 : R.int(2, 5);
    this.counters.set(key, n);
    if (numField) {
      const max = numField.maxDigits ?? numField.digits;
      const min = numField.minDigits ?? numField.digits;
      let s = String(n % 10 ** max).padStart(max, "0");
      if (this.v2 && min < max && n < 10 ** min && R.chance(0.2)) s = String(n).padStart(min, "0");
      values[numField.name] = s;
    }
    const parts = this.def.fields.filter((f) => f.inName !== false).map((f) => values[f.name]);
    const ext = values[this.roles.docType] === "6K" ? "nwd" : R.pick(docCat[2]);
    return { name: `${parts.join(d)}.${ext}`, values };
  }
}

function genericName(folder, R, seq, date) {
  const leaf = folder.path.split("/").pop();
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (/yazışma|yazı/i.test(folder.path)) {
    const dir = R.chance(0.5) ? "Giden" : "Gelen";
    return `${dir} Yazı DEMO-${y}-${String(seq).padStart(4, "0")}.pdf`;
  }
  if (/toplantı/i.test(folder.path)) return `Toplantı Tutanağı ${y}-${mm} No ${seq} (demo).pdf`;
  if (/form|tutanak/i.test(leaf)) return `${leaf} - Form ${String(seq).padStart(3, "0")} (demo).pdf`;
  if (/hakediş/i.test(folder.path)) return `${leaf} - Ek ${seq} (demo).${R.pick(["pdf", "xlsx"])}`;
  if (/model/i.test(folder.path)) return `${leaf} - Model ${seq} (demo).${R.pick(["rvt", "nwd", "nwc"])}`;
  if (/fotoğraf/i.test(folder.path)) return `Saha Fotoğrafı ${y}${mm}-${String(seq).padStart(3, "0")} (demo).jpg`;
  return `${leaf} - Belge ${String(seq).padStart(3, "0")} (demo).${R.pick(["pdf", "pdf", "pdf", "docx", "xlsx", "dwg"])}`;
}

const VERSION_WEIGHTS = { 1: 55, 2: 25, 3: 11, 4: 5, 5: 2.5, 6: 1.5 };

// ---- Import of one project ------------------------------------------------------------------------

async function importProject(snapshot, admin, existingProject = null) {
  const t0 = Date.now();
  const code = snapshot.project.code;
  const R = makeRandom(code);
  const result = { code, startedAt: new Date().toISOString(), notes: [] };
  const note = (s) => {
    result.notes.push(s);
    console.log(`  · ${s}`);
  };

  // Folder plan with scaled file counts.
  const folders = parseTree(snapshot.tree);
  const realFiles = folders.reduce((s, f) => s + f.files + (f.synthetic?.files ?? 0), 0);
  const scale = Math.min(1, CAP / Math.max(realFiles, 1));
  let synthFolders = 0;
  for (const f of folders) {
    if (!f.synthetic) continue;
    // Record-named folders (e.g. one per letter): a scaled number of synthetic folders.
    const n = Math.max(1, Math.min(f.synthetic.count, Math.round(f.synthetic.count * Math.max(scale, 0.07))));
    const per = f.synthetic.files / n;
    for (let i = 0; i < n; i++) {
      const y = 2021 + Math.floor((i / n) * 5);
      const name = f.synthetic.pattern.replace("{yyyy}", String(y)).replace("{nnnn}", String(1000 + i * 7).padStart(4, "0"));
      folders.push({ name, path: `${f.path}/${name}`, files: Math.round(per), parent: f, generated: true });
      synthFolders++;
    }
  }
  for (const f of folders) {
    const x = f.files * scale;
    f.target = Math.floor(x) + (R.next() < x % 1 ? 1 : 0);
  }
  const plannedFiles = folders.reduce((s, f) => s + f.target, 0);
  // Folder count in Forma (the snapshot may summarise record-named or deep repeated folders).
  result.realFolders = snapshot.stats?.realFolders ?? folders.length - synthFolders;
  result.folders = folders.length;
  result.realFiles = realFiles;
  result.scale = Number(scale.toFixed(4));
  result.plannedFiles = plannedFiles;
  console.log(`\n${code}: ${folders.length} klasör, gerçek ${realFiles} dosya → ${plannedFiles} (ölçek ${scale.toFixed(3)})`);
  if (DRY) return result;

  // Companies.
  const existingCompanies = await admin.get("/companies");
  const companies = {};
  for (const c of snapshot.companies) {
    const found = existingCompanies.find((x) => x.name === c.name);
    companies[c.key] = { ...c, id: found ? found.id : (await admin.post("/companies", { name: c.name })).id };
  }

  // Demo users: one per company, plus one per role that review templates use.
  const allUsers = await admin.get("/users");
  const slug = code.split("-")[0].toLowerCase();
  async function ensureUser(email, name, companyId) {
    const found = allUsers.find((u) => u.email === email);
    if (found) return found;
    const u = await admin.post("/users", { email, name, password, companyId });
    allUsers.push(u);
    return u;
  }
  const users = {};
  for (const c of Object.values(companies)) {
    const u = await ensureUser(
      `${c.userSlug}@${slug}.demo.localhost`,
      `${snapshot.project.short ?? code.split("-")[0]} ${c.label} (demo)`,
      c.id,
    );
    users[c.key] = { ...u, company: c.key, email: u.email };
  }
  const roleUsers = {};
  for (const [i, role] of (snapshot.roles ?? []).entries()) {
    const c = companies[role.company];
    const u = await ensureUser(
      `${role.userSlug ?? `rol${i + 1}`}@${slug}.demo.localhost`,
      `${snapshot.project.short ?? code.split("-")[0]} ${role.name} (demo)`,
      c.id,
    );
    roleUsers[role.name] = { ...u, company: role.company, email: u.email };
  }
  result.users = Object.keys(users).length + Object.keys(roleUsers).length;
  result.companies = Object.keys(companies).length;

  // Project and members.
  // --resume continues a project whose import stopped half-way (everything is looked up by name).
  const project =
    existingProject ??
    (await admin.post("/projects", {
      code,
      name: snapshot.project.name,
      description: snapshot.project.description,
      template: "empty",
    }));
  if (existingProject) note("Var olan proje kaldığı yerden tamamlandı (--resume)");
  const pid = project.id;
  result.projectId = pid;
  for (const u of [...Object.values(users), ...Object.values(roleUsers)]) {
    await admin.post(`/projects/${pid}/members`, {
      email: u.email,
      companyId: companies[u.company].id,
      isProjectAdmin: u === users[snapshot.projectAdminCompany],
    });
  }

  // Project roles (teams), when the server has them.
  const roles = {};
  try {
    const existingRoles = await admin.get(`/projects/${pid}/roles`);
    for (const role of snapshot.roles ?? []) {
      const r =
        existingRoles.find((x) => x.name === role.name) ??
        (await admin.post(`/projects/${pid}/roles`, { name: role.name, description: role.description ?? null }));
      roles[role.name] = r.id;
      await admin.post(`/projects/${pid}/roles/${r.id}/members/${roleUsers[role.name].id}`);
    }
    note(`${Object.keys(roles).length} proje rolü (ekip) oluşturuldu`);
  } catch (e) {
    if (e.status !== 404) throw e;
    note("Sunucuda proje rolleri yok; rol atamaları firmaya çevrildi");
  }
  const userFor = (party) => users[party];

  // Folders, parents first.
  const ids = new Map([["", project.rootFolderId]]);
  const existingFiles = new Map();
  if (existingProject) {
    // Walk the folders that already exist (path → id, and their file names).
    let level = [["", project.rootFolderId]];
    while (level.length) {
      const next = [];
      await pool(level, CONCURRENCY, async ([path, id]) => {
        const c = await admin.get(`/projects/${pid}/folders/${id}/contents`);
        existingFiles.set(path, new Set(c.files.map((f) => f.name)));
        for (const sub of c.folders) {
          const sp = path ? `${path}/${sub.name}` : sub.name;
          ids.set(sp, sub.id);
          next.push([sp, sub.id]);
        }
      });
      level = next;
    }
    for (const f of folders) if (ids.has(f.path)) f.id = ids.get(f.path);
  }
  const byDepth = new Map();
  for (const f of folders) {
    const d = f.path.split("/").length;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(f);
  }
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    await pool(byDepth.get(d).filter((f) => !f.id), CONCURRENCY, async (f) => {
      const parentId = ids.get(f.parent ? f.parent.path : "");
      let row;
      for (;;) {
        try {
          row = await admin.post(`/projects/${pid}/folders`, { parentId, name: f.name });
          break;
        } catch (e) {
          if (e.code !== "NET") throw e;
          const c = await admin.get(`/projects/${pid}/folders/${parentId}/contents`);
          row = c.folders.find((x) => x.name === f.name);
          if (row) break;
        }
      }
      ids.set(f.path, row.id);
      f.id = row.id;
    });
  }
  console.log(`  klasörler: ${folders.length}`);

  // ISO 19650 states.
  let stateCount = 0;
  for (const f of folders) {
    const rule = (snapshot.states ?? []).find((s) => new RegExp(s.match, "i").test(f.name) && (!s.under || underPath(f.path, s.under)));
    if (!rule) continue;
    // Only the topmost folder of a state gets the state (as in the ISO template).
    let p = f.parent;
    let inherited = false;
    while (p) {
      if (p.state === rule.state) inherited = true;
      p = p.parent;
    }
    f.state = rule.state;
    if (inherited) continue;
    await admin.patch(`/projects/${pid}/folders/${f.id}`, { state: rule.state });
    stateCount++;
  }
  for (const a of snapshot.areas ?? []) {
    const f = folders.find((x) => x.path === a.path);
    if (f && !f.state) {
      await admin.patch(`/projects/${pid}/folders/${f.id}`, { state: "wip" });
      f.state = "wip";
      stateCount++;
    }
  }
  const stateOf = (f) => {
    for (let p = f; p; p = p.parent) if (p.state) return p.state;
    return null;
  };

  // Naming standard: full definition (delimiter codes, digit ranges, metadata fields) when the
  // server supports it, otherwise a compatible subset.
  let namingV2 = false;
  let standardId = null;
  if (snapshot.naming) {
    const full = snapshot.naming.definition;
    const known = (await admin.get(`/projects/${pid}/naming-standards`)).find((x) => x.definition.name === full.name);
    if (known) {
      standardId = known.id;
      namingV2 = canonical(known.definition) === canonical(full);
    } else try {
      const res = await admin.post(`/projects/${pid}/naming-standards`, full);
      const back = res.definition;
      namingV2 = canonical(back) === canonical(full);
      standardId = res.id;
      if (!namingV2) await admin.put(`/projects/${pid}/naming-standards/${standardId}`, legacyStandard(full));
    } catch (e) {
      if (e.status !== 400) throw e;
      standardId = (await admin.post(`/projects/${pid}/naming-standards`, legacyStandard(full))).id;
    }
    if (!namingV2)
      note(
        "Sunucunun naming doğrulayıcısı eski (ayraç içeren kodlar, değişken haneli sayı alanı ve ada girmeyen alanlar desteklenmiyor): uyumlu bir alt küme bağlandı; üretilen adlar bu alt kümeye uyar",
      );
    for (const p of snapshot.naming.appliesTo ?? []) {
      const id = ids.get(p);
      if (id) await admin.patch(`/projects/${pid}/folders/${id}`, { namingStandardId: standardId });
      else note(`naming hedef klasörü yok: ${p}`);
    }
  }
  const names = snapshot.naming ? new NameMaker(snapshot, R, namingV2) : null;
  const namingFolder = (f) =>
    !!snapshot.naming &&
    [...(snapshot.naming.appliesTo ?? []), ...(snapshot.naming.alsoGenerateIn ?? [])].some((p) => underPath(f.path, p));

  // Attribute definitions and bindings.
  const defs = {};
  const bindings = new Map();
  const bind = (p, defId) => {
    const id = p === "" ? project.rootFolderId : ids.get(p);
    if (!id) return;
    if (!bindings.has(id)) bindings.set(id, new Set());
    bindings.get(id).add(defId);
  };
  const attrSpecs = [...(snapshot.attributes ?? [])];
  if (snapshot.naming) {
    for (const f of snapshot.naming.definition.fields) {
      if (f.type === "number") continue;
      if (attrSpecs.some((a) => a.name === f.name)) continue;
      const def = namingV2 ? f : snapshot.naming.definition.fields.find((x) => x.name === f.name);
      const options = f.type === "list" ? [...new Set(def.values.map((v) => v.code))] : undefined;
      attrSpecs.push({
        name: f.name,
        type: f.type === "list" ? "list" : "text",
        options,
        bindTo: [...(snapshot.naming.appliesTo ?? []), ...(snapshot.naming.alsoGenerateIn ?? [])],
        fromNaming: true,
      });
    }
  }
  if (!attrSpecs.some((a) => a.name === "Belge tarihi")) attrSpecs.push({ name: "Belge tarihi", type: "date", bindTo: [""] });
  const knownDefs = await admin.get(`/projects/${pid}/attribute-definitions`);
  for (const a of attrSpecs) {
    const res = knownDefs.find((x) => x.name === a.name) ?? await admin.post(`/projects/${pid}/attribute-definitions`, {
      name: a.name,
      type: a.type,
      ...(a.type === "list" ? { options: a.options } : {}),
    });
    defs[a.name] = { ...a, id: res.id };
    for (const p of a.bindTo ?? []) bind(p, res.id);
  }
  for (const [fid, set] of bindings) await admin.put(`/projects/${pid}/folders/${fid}/attribute-bindings`, { definitionIds: [...set] });
  result.attributeDefinitions = Object.keys(defs).length;

  // Company-level folder permissions.
  let grantCount = 0;
  const grantsByFolder = new Map();
  for (const g of snapshot.permissions ?? []) {
    const id = g.path === "" ? project.rootFolderId : ids.get(g.path);
    if (!id) {
      note(`yetki hedefi yok: ${g.path}`);
      continue;
    }
    const subjects = g.company === "*" ? Object.keys(companies) : [g.company];
    if (!grantsByFolder.has(id)) grantsByFolder.set(id, { depth: g.path.split("/").length, entries: new Map() });
    for (const s of subjects) grantsByFolder.get(id).entries.set(s, g.level);
  }
  for (const [id, { entries }] of [...grantsByFolder].sort((a, b) => a[1].depth - b[1].depth)) {
    const list = [...entries].map(([k, level]) => ({ subjectType: "company", subjectId: companies[k].id, level }));
    const res = await admin.put(`/projects/${pid}/folders/${id}/permissions`, { entries: list, mode: "replace" });
    grantCount += res.results.filter((r) => r.status === "ok").length;
    for (const r of res.results.filter((x) => x.status !== "ok")) note(`yetki atlandı (${r.status})`);
  }
  result.grants = grantCount;

  // Review templates (company / project-role assignees).
  const knownTemplates = await admin.get(`/projects/${pid}/workflow-templates?kind=review`);
  const templates = [];
  for (const t of snapshot.workflowTemplates ?? []) {
    const steps = t.steps.map((s) => {
      // Project role (team) when the server has roles, else the role's company. Duplicates
      // (two roles of one company without role support) collapse into one entry.
      const entries = new Map();
      for (const x of s.assignees) {
        const companyKey = x.company ?? (snapshot.roles ?? []).find((r) => r.name === x.role)?.company;
        const assignee = x.role && roles[x.role] ? { type: "role", id: roles[x.role] } : { type: "company", id: companies[companyKey].id };
        const actor = x.role && roles[x.role] ? roleUsers[x.role] : userFor(companyKey);
        entries.set(`${assignee.type}:${assignee.id}`, { assignee, actor });
      }
      return {
        name: s.name,
        rule: s.rule ?? "any",
        days: s.days,
        outcomes: s.outcomes ?? ["approved", "approved_with_comments", "rejected"],
        assignees: [...entries.values()].map((e) => e.assignee),
        // Who answers in this demo (role member, else the company's demo user).
        actors: [...entries.values()].map((e) => e.actor),
      };
    });
    const res = knownTemplates.find((x) => x.name === t.name) ?? await admin.post(`/projects/${pid}/workflow-templates`, {
      kind: "review",
      name: t.name,
      steps: steps.map(({ actors, ...s }) => s),
    });
    templates.push({ ...t, id: res.id, steps });
  }
  result.workflowTemplates = templates.length;

  // Upload rights: the uploading company needs at least upload on the folders it fills.
  const uploaderOf = (f) => longestRule(snapshot.uploaders, f.path)?.company ?? snapshot.defaultUploader ?? snapshot.projectAdminCompany;

  // ---- Files ----
  const sampleDate = dateSampler(snapshot, R);
  const clients = new Map();
  const as = async (u) => {
    if (!clients.has(u.email)) clients.set(u.email, await login(u.email));
    return clients.get(u.email);
  };
  const jobs = [];
  let seq = 0;
  for (const f of folders) {
    const party = uploaderOf(f);
    const company = companies[party];
    const state = stateOf(f);
    const usedNames = new Set();
    const already = existingFiles.get(f.path) ?? new Set();
    for (let i = 0; i < f.target; i++) {
      seq++;
      const date = sampleDate();
      let name;
      let attrs = {};
      if (names && namingFolder(f)) {
        let made;
        do made = names.make(f.path, company);
        while (usedNames.has(made.name));
        name = made.name;
        for (const [k, v] of Object.entries(made.values)) if (defs[k]) attrs[k] = v;
      } else {
        do name = cleanName(genericName(f, R, R.int(1, 9999), date));
        while (usedNames.has(name));
      }
      usedNames.add(name);
      if (already.has(name)) continue;
      const versions = Number(R.weighted(VERSION_WEIGHTS));
      const revSeries = state === "published" ? "C" : "P";
      const namingFile = names && namingFolder(f);
      for (const a of attrSpecs) {
        // Name fields come from the name; metadata fields (Pafta adı …) get synthetic values.
        if (attrs[a.name] !== undefined || a.name === snapshot.naming?.revisionAttribute) continue;
        if (a.fromNaming && (a.type !== "text" || !namingFile)) continue;
        if (!(a.bindTo ?? []).some((p) => p === "" || underPath(f.path, p))) continue;
        if (a.name === "Belge tarihi") continue;
        attrs[a.name] = syntheticAttr(a, R, date, seq);
      }
      jobs.push({ folder: f, party, name, versions, revSeries, date, attrs, revAttr: snapshot.naming?.revisionAttribute });
    }
  }
  // Every uploading company gets at least "edit" in its WIP area and "upload" where it delivers
  // (the snapshot's permission matrix sets this; check here so uploads do not fail).
  let uploaded = 0;
  let versionCount = 0;
  const fileRecords = [];
  const tUp = Date.now();
  await pool(jobs, CONCURRENCY, async (job) => {
    const c = await as(userFor(job.party));
    let fileId = null;
    let date = job.date;
    for (let v = 1; v <= job.versions; v++) {
      const attrs = { ...job.attrs, "Belge tarihi": iso(date) };
      if (job.revAttr)
        attrs[job.revAttr] =
          snapshot.naming?.revisionStyle === "NN" ? String(v - 1).padStart(2, "0") : `${job.revSeries}${String(v).padStart(2, "0")}`;
      const form = new FormData();
      form.append("comment", v === 1 ? "İlk yükleme (demo)" : `Revizyon ${attrs[job.revAttr] ?? v} (demo)`);
      form.append("attributes", JSON.stringify(attrs));
      form.append("file", new Blob([`${BODY}\nProje: ${code}\nDosya: ${job.name}\nVersiyon: ${v}\n`]), job.name);
      let res;
      try {
        res = await c.post(`/projects/${pid}/folders/${job.folder.id}/files`, form);
      } catch (e) {
        res = e.data;
      }
      const r = res?.results?.[0];
      if (!r?.ok) {
        if (result.uploadErrors === undefined) result.uploadErrors = [];
        if (result.uploadErrors.length < 10) result.uploadErrors.push(`${job.folder.path}: ${r?.errors?.join(" ") ?? "?"}`);
        break;
      }
      fileId = r.fileId;
      versionCount++;
      const next = addDays(date, R.int(7, 60));
      date = next > toDate(TODAY) ? toDate(TODAY) : next;
    }
    if (fileId) {
      uploaded++;
      fileRecords.push({ fileId, job });
      if (uploaded % 250 === 0) console.log(`  dosyalar: ${uploaded}/${jobs.length} (${Math.round((Date.now() - tUp) / 1000)} sn)`);
    }
  });
  result.files = uploaded;
  result.versions = versionCount;
  result.uploadSeconds = Math.round((Date.now() - tUp) / 1000);
  console.log(`  dosyalar: ${uploaded}, versiyonlar: ${versionCount}`);

  // ---- Reviews ----
  if (existingProject && (await admin.get(`/projects/${pid}/reviews`)).length) note("İncelemeler zaten var; atlandı (--resume)");
  else result.reviews = await makeReviews({ snapshot, R, pid, templates, fileRecords, as, admin, note, userFor });

  // ---- Issues ----
  if (existingProject && (await admin.get(`/projects/${pid}/issues`)).length) note("Sorunlar zaten var; atlandı (--resume)");
  else result.issues = await makeIssues({ snapshot, R, pid, companies, users, as, sampleDate, folders });

  // Published areas accept approved reviews only (as in the real projects, where files reach them by review copy).
  for (const p of snapshot.gatedFolders ?? []) {
    const id = ids.get(p);
    if (id) await admin.put(`/projects/${pid}/folders/${id}/settings`, { requireApprovedReview: true });
  }
  result.seconds = Math.round((Date.now() - t0) / 1000);
  return result;
}

function syntheticAttr(a, R, date, seq) {
  switch (a.type) {
    case "list":
      return R.pick(a.options);
    case "date":
      return iso(date);
    case "number":
      return String(R.int(1, 99));
    default:
      if (/sayı|numara|no$/i.test(a.name)) return `DEMO-${date.getUTCFullYear()}/${String(seq).padStart(4, "0")}`;
      if (/rev/i.test(a.name)) return `P0${R.int(1, 3)}`;
      if (/pafta|doküman adı/i.test(a.name)) return `Örnek pafta ${seq} (demo)`;
      if (/ilgi/i.test(a.name)) return `DEMO-${date.getUTCFullYear() - 1}/${String(R.int(1, 999)).padStart(4, "0")}`;
      if (/konu/i.test(a.name)) return `Demo konu ${seq} (üretilmiş)`;
      if (/ek$/i.test(a.name)) return `${R.int(1, 6)} ek`;
      return "demo";
  }
}

async function makeReviews({ snapshot, R, pid, templates, fileRecords, as, admin, note, userFor }) {
  const stats = snapshot.stats?.reviews ?? {};
  const out = { total: 0, completed: {}, running: 0, runningAdvanced: 0, cancelled: 0, overdueNow: 0 };
  if (!templates.length || !fileRecords.length) return out;
  // Without real reviews the snapshot gives an assumed number (limits.reviews).
  const total = Math.min(MAX_REVIEWS, stats.total ?? snapshot.limits?.reviews ?? MAX_REVIEWS);
  const statusWeights = { closed: stats.closed ?? 55, open: stats.open ?? 40, void: stats.void ?? 3 };
  const plan = R.apportion(total, statusWeights);
  const outcomeWeights = stats.outcomes ?? { approved: 50, approved_with_comments: 30, rejected: 20 };
  const usageWeights = Object.fromEntries(templates.map((t, i) => [i, t.share ?? 1]));
  const statuses = [
    ...Array(plan.closed ?? 0).fill("closed"),
    ...Array(plan.open ?? 0).fill("open"),
    ...Array(plan.void ?? 0).fill("void"),
  ].sort(() => R.next() - 0.5);

  const used = new Set();
  const versionOf = async (c, fileId) => {
    const file = await c.get(`/projects/${pid}/files/${fileId}`);
    return file.versions[0].id;
  };
  await pool(statuses, Math.max(1, Math.floor(CONCURRENCY / 2)), async (status, idx) => {
    try {
      await oneReview(status, idx);
    } catch (e) {
      out.errors = (out.errors ?? 0) + 1;
      if ((out.errorSamples ??= []).length < 5) out.errorSamples.push(String(e.message).slice(0, 300));
    }
  });
  async function oneReview(status, idx) {
    const t = templates[Number(R.weighted(usageWeights))];
    const inPaths = (r) => (t.sourcePaths ?? [""]).some((p) => p === "" || underPath(r.job.folder.path, p));
    // Optional discipline filter on the folder path (e.g. "Elektrik|Elektronik" for an E&M template).
    const re = t.match ? new RegExp(t.match, "i") : null;
    const matching = re ? fileRecords.filter((r) => inPaths(r) && re.test(r.job.folder.path)) : [];
    const inSource = re && matching.length ? (r) => inPaths(r) && re.test(r.job.folder.path) : inPaths;
    // Prefer files not yet in a review; when the template's folders run out, reuse files
    // (a later review of the same document) before falling back to any file of the project.
    let pool0 = fileRecords.filter((r) => !used.has(r.fileId) && inSource(r));
    if (!pool0.length) pool0 = fileRecords.filter(inSource);
    if (!pool0.length) pool0 = fileRecords.filter((r) => !used.has(r.fileId));
    if (!pool0.length) return;
    // Files of one folder go together (one sheet set per review).
    const seed = R.pick(pool0);
    const same = pool0.filter((r) => r.job.folder === seed.job.folder);
    const files = same.slice(0, R.int(1, Math.min(8, same.length)));
    files.forEach((f) => used.add(f.fileId));
    const starter = await as(userFor(t.starter));
    const versionIds = [];
    for (const f of files) versionIds.push(await versionOf(starter, f.fileId));
    const leaf = seed.job.folder.path.split("/").slice(-3).join(" / ");
    const review = await starter.post(`/projects/${pid}/reviews`, {
      name: `DEMO-${String(idx + 1).padStart(3, "0")} ${leaf} sunumu`,
      note: "SiteKeep demo verisi — üretilmiş",
      templateId: t.id,
      versionIds,
    });
    out.total++;
    if (status === "void") {
      await starter.post(`/projects/${pid}/reviews/${review.id}/cancel`, { comment: "Demo: iptal" });
      out.cancelled++;
      return;
    }
    const finalOutcome = R.weighted(outcomeWeights);
    // Open reviews: some are past the first step.
    const stepsToDo = status === "closed" ? t.steps.length : t.steps.length > 1 && R.chance(0.4) ? R.int(1, t.steps.length - 1) : 0;
    for (let s = 0; s < stepsToDo; s++) {
      const step = t.steps[s];
      const last = s === t.steps.length - 1;
      const actors = step.rule === "all" ? step.actors : [step.actors[0]];
      for (const actor of [...new Set(actors)]) {
        const c = await as(actor);
        const detail = await c.get(`/projects/${pid}/reviews/${review.id}`);
        if (detail.status !== "running" || !detail.canAct) break;
        const pickOutcome = () => {
          let o = last ? finalOutcome : R.chance(0.85) ? "approved" : "approved_with_comments";
          if (last && R.chance(0.15)) o = R.weighted(outcomeWeights);
          return step.outcomes.includes(o) ? o : step.outcomes[0];
        };
        await c.post(`/projects/${pid}/reviews/${review.id}/submit`, {
          comment: last ? "Demo: değerlendirme tamamlandı" : null,
          files: detail.files.map((f) => ({ reviewFileId: f.id, outcome: pickOutcome() })),
        });
      }
    }
    if (status === "closed") out.completed[finalOutcome] = (out.completed[finalOutcome] ?? 0) + 1;
    else {
      out.running++;
      if (stepsToDo > 0) out.runningAdvanced++;
    }
  }
  // Status as the server sees it.
  const list = await admin.get(`/projects/${pid}/reviews`);
  const now = Date.now();
  out.server = {
    running: list.filter((r) => r.status === "running").length,
    completed: list.filter((r) => r.status === "completed").length,
    cancelled: list.filter((r) => r.status === "cancelled").length,
    overdueNow: list.filter((r) => r.status === "running" && r.stepDueAt && Date.parse(r.stepDueAt) < now).length,
    dueWithin7Days: list.filter((r) => r.status === "running" && r.stepDueAt && Date.parse(r.stepDueAt) < now + 7 * 86400_000).length,
  };
  const finals = {};
  for (const r of list.filter((x) => x.status === "completed").slice(0, 400)) {
    const d = await admin.get(`/projects/${pid}/reviews/${r.id}`);
    for (const f of d.files) finals[f.finalStatus ?? "none"] = (finals[f.finalStatus ?? "none"] ?? 0) + 1;
  }
  out.server.fileFinalStatus = finals;
  return out;
}

const ISSUE_STATUS = {
  draft: "open",
  open: "open",
  pending: "open",
  not_approved: "open",
  in_dispute: "open",
  in_progress: "in_progress",
  work_completed: "in_review",
  completed: "in_review",
  in_review: "in_review",
  ready_to_inspect: "in_review",
  answered: "in_review",
  closed: "closed",
  void: "closed",
};

async function makeIssues({ snapshot, R, pid, companies, users, as, sampleDate, folders }) {
  const s = snapshot.stats?.issues ?? {};
  const statusWeights = {};
  for (const [k, v] of Object.entries(s.byStatus ?? { open: 50, in_progress: 20, in_review: 10, closed: 20 })) {
    const mapped = ISSUE_STATUS[k] ?? "open";
    statusWeights[mapped] = (statusWeights[mapped] ?? 0) + v;
  }
  const typeWeights = s.byType ?? { Coordination: 1 };
  const priorityWeights = s.byPriority ?? { normal: 60, high: 25, low: 10, critical: 5 };
  const assigneeWeights = s.assigneeCompanies ?? Object.fromEntries(Object.keys(companies).map((k) => [k, 1]));
  const overdueShare = s.total ? (s.overdue ?? 0) / s.total : 0.2;
  const zones = [...new Set(folders.map((f) => (/^(S\d\d|SG\d|L\d\w*|G\d\d|B00|N\d\d|V\d\d)\b/.exec(f.name) ?? [])[1]).filter(Boolean))];
  const topics = snapshot.issueTopics ?? ["koordinasyon sorunu", "çakışma", "eksik bilgi", "revizyon talebi", "tutarsız ölçü", "detay eksik"];
  const out = { total: 0, byStatus: {}, byType: {}, byPriority: {}, overdue: 0 };
  const creators = Object.values(users);
  await pool(Array.from({ length: Math.min(ISSUES, snapshot.limits?.issues ?? ISSUES) }, (_, i) => i), CONCURRENCY, async (i) => {
    const status = R.weighted(statusWeights);
    const type = R.weighted(typeWeights);
    const priority = R.weighted(priorityWeights);
    const assigneeKey = R.weighted(assigneeWeights);
    const assignee = users[assigneeKey];
    const overdue = status !== "closed" && R.chance(overdueShare);
    const created = sampleDate();
    const due = overdue ? addDays(created, R.int(7, 45)) : addDays(new Date(), R.int(3, 60));
    const dueDate = overdue && due > new Date() ? addDays(new Date(), -R.int(1, 30)) : due;
    const creator = R.pick(creators);
    const c = await as(creator);
    const zone = zones.length ? R.pick(zones) : "";
    const issue = await c.post(`/projects/${pid}/issues`, {
      title: `DEMO-${String(i + 1).padStart(3, "0")} ${zone} ${type.split(" / ").pop().toLowerCase()} ${R.pick(topics)}`.replace(/\s+/g, " ").trim(),
      description: `${BODY}. Belge tarihi aralığı: ${iso(created)}.`,
      priority,
      type,
      assigneeUserId: assignee?.id ?? null,
      assigneeCompanyId: companies[assigneeKey]?.id ?? null,
      dueDate: iso(dueDate),
    });
    if (status !== "open") await c.patch(`/projects/${pid}/issues/${issue.id}`, { status });
    out.total++;
    out.byStatus[status] = (out.byStatus[status] ?? 0) + 1;
    out.byType[type] = (out.byType[type] ?? 0) + 1;
    out.byPriority[priority] = (out.byPriority[priority] ?? 0) + 1;
    if (status !== "closed" && dueDate < new Date()) out.overdue++;
  });
  return out;
}

// ---- Main -----------------------------------------------------------------------------------------

if (!existsSync(dir)) {
  console.error(`Snapshot klasörü yok: ${dir}`);
  process.exit(1);
}
const snapshots = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".result.json"))
  .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")))
  .filter((s) => s.project?.code && !s.skip && (!args.only || args.only.includes(s.project.code)))
  .map((s) => (args.suffix ? { ...s, project: { ...s.project, code: `${s.project.code}${args.suffix}` } } : s));
if (!snapshots.length) {
  console.error("Snapshot bulunamadı.");
  process.exit(1);
}
if (!DRY && !password) {
  console.error("ADMIN_EMAIL / ADMIN_PASSWORD gerekli (--env-file ile).");
  process.exit(1);
}

const admin = DRY ? null : await login(process.env.ADMIN_EMAIL);
const existing = DRY ? [] : await admin.get("/projects");
const results = [];
for (const s of snapshots) {
  const found = existing.find((p) => p.code === s.project.code);
  if (found && !args.resume) {
    console.log(`${s.project.code}: zaten var, atlandı (yarım kalan bir içe aktarımı tamamlamak için --resume).`);
    continue;
  }
  const r = await importProject(s, admin, found ?? null);
  results.push(r);
  if (!DRY) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${s.project.code}.result.json`), JSON.stringify(r, null, 2));
  }
  console.log(JSON.stringify(r, null, 2));
}
