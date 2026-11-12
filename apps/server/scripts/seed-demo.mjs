// Fills a running dev server with demo data.
//   node --env-file=.env.development scripts/seed-demo.mjs
// Demo users get the same password as ADMIN_PASSWORD (development only).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = `http://127.0.0.1:${process.env.PORT ?? 8787}/api/v1`;
const password = process.env.ADMIN_PASSWORD;
let cookie = "";

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { cookie, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return data;
}

await call("POST", "/auth/login", { email: process.env.ADMIN_EMAIL, password });
const existing = await call("GET", "/projects");
if (existing.some((p) => p.code === "ZAVM")) {
  console.log("Demo data already present.");
  process.exit(0);
}

const companies = {};
for (const name of ["Poyraz İnşaat", "Çınar Tasarım ve Mühendislik", "Hilal Müşavirlik", "Zirve Teknoloji"]) {
  companies[name] = (await call("POST", "/companies", { name })).id;
}
const people = [
  ["elif@poyraz.localhost", "Elif Aydın", "Poyraz İnşaat", true],
  ["murat@poyraz.localhost", "Murat Kaya", "Poyraz İnşaat", false],
  ["selim@cinar.localhost", "Selim Arslan", "Çınar Tasarım ve Mühendislik", false],
  ["ayhan@hilal.localhost", "Ayhan Koç", "Hilal Müşavirlik", false],
  ["hakan@zirve.localhost", "Hakan Öztürk", "Zirve Teknoloji", false],
];
const ids = {};
for (const [email, name, company] of people) {
  ids[email] = (await call("POST", "/users", { email, name, password, companyId: companies[company] })).id;
}

const project = await call("POST", "/projects", {
  code: "ZAVM",
  name: "Zirve Ankara Veri Merkezi (demo)",
  description: "Demo proje — Forma kurulum şartnamesindeki kodlama ve onay sırası (PAS → CNS → HLL → ZRT).",
  template: "iso19650",
});
for (const [email, , , admin] of people) {
  await call("POST", `/projects/${project.id}/members`, { email, isProjectAdmin: admin });
}

const root = await call("GET", `/projects/${project.id}/folders/${project.rootFolderId}/contents`);
const [wip, shared, published] = root.folders;
const disciplines = {};
for (const name of ["Mimari", "Statik", "Mekanik", "Elektrik"]) {
  disciplines[name] = (await call("POST", `/projects/${project.id}/folders`, { parentId: wip.id, name })).id;
}

const standard = await call("POST", `/projects/${project.id}/naming-standards`, {
  name: "Data Center Kodlama Sistemi",
  delimiter: "-",
  fields: [
    { name: "Proje", type: "list", values: [{ code: "ZAVM", description: "Zirve Ankara Veri Merkezi" }] },
    {
      name: "Firma",
      type: "list",
      values: [
        { code: "PAS", description: "Poyraz İnşaat" },
        { code: "CNS", description: "CNS" },
        { code: "HLL", description: "Hilal Müşavirlik" },
        { code: "ZRT", description: "Zirve Teknoloji" },
      ],
    },
    { name: "Hacim", type: "list", values: [{ code: "ZZ" }, { code: "XX" }] },
    { name: "Rol", type: "list", values: ["A", "S", "M", "E", "C", "L", "Z"].map((code) => ({ code })) },
    { name: "Kat", type: "list", values: ["ZZ", "XX", "00", "01", "02", "B1", "B2", "RF"].map((code) => ({ code })) },
    { name: "Alt Disiplin", type: "number", digits: 4 },
    { name: "Tip", type: "list", values: ["M3", "DR", "RP", "SP", "RI"].map((code) => ({ code })) },
    { name: "Aşama", type: "list", values: ["DE", "SD", "CD", "MC", "HO"].map((code) => ({ code })) },
    { name: "Numara", type: "number", digits: 4 },
  ],
});
await call("PATCH", `/projects/${project.id}/folders/${wip.id}`, { namingStandardId: standard.id });
await call("PATCH", `/projects/${project.id}/folders/${shared.id}`, { namingStandardId: standard.id });

// Everyone sees Shared and Published; design firms edit their discipline folders in WIP.
const all = Object.values(companies).map((id) => ({ subjectType: "company", subjectId: id, level: "view_download" }));
await call("PUT", `/projects/${project.id}/folders/${shared.id}/permissions`, { entries: all });
await call("PUT", `/projects/${project.id}/folders/${published.id}/permissions`, { entries: all });
await call("PUT", `/projects/${project.id}/folders/${wip.id}/permissions`, {
  entries: [{ subjectType: "company", subjectId: companies["Poyraz İnşaat"], level: "view_download" }],
});
for (const id of Object.values(disciplines)) {
  await call("PUT", `/projects/${project.id}/folders/${id}/permissions`, {
    entries: [
      { subjectType: "company", subjectId: companies["Çınar Tasarım ve Mühendislik"], level: "edit" },
      { subjectType: "user", subjectId: ids["murat@poyraz.localhost"], level: "edit" },
    ],
  });
}

// ZAVM approval order as the first review template; SHARED and PUBLISHED accept approved reviews only.
const allOutcomes = ["approved", "approved_with_comments", "reviewed", "revise_resubmit", "rejected"];
const companyStep = (name, company, days) => ({
  name,
  assignees: [{ type: "company", id: companies[company] }],
  rule: "any",
  days,
  outcomes: allOutcomes,
});
await call("POST", `/projects/${project.id}/workflow-templates`, {
  kind: "review",
  name: "PAS → CNS → HLL → ZRT (örnek)",
  steps: [
    companyStep("PAS ön kontrol", "Poyraz İnşaat", 3),
    companyStep("CNS inceleme", "Çınar Tasarım ve Mühendislik", 5),
    companyStep("HLL kontrol", "Hilal Müşavirlik", 5),
    { ...companyStep("ZRT onay", "Zirve Teknoloji", 5), outcomes: ["approved", "approved_with_comments", "rejected"] },
  ],
});
for (const f of [shared, published]) {
  await call("PUT", `/projects/${project.id}/folders/${f.id}/settings`, { requireApprovedReview: true });
}

const ifc = readFileSync(path.join(here, "../test/fixtures/sample-wall.ifc"));
const form = new FormData();
form.append("comment", "İlk yayın");
form.append("attributes", JSON.stringify({ Durum: "S2", Revizyon: "P01" }));
form.append("file", new Blob([ifc]), "ZAVM-CNS-ZZ-S-00-0101-M3-SD-0001.ifc");
form.append("file", new Blob(["%PDF-1.4\n% demo\n"]), "ZAVM-CNS-ZZ-S-00-0101-RP-SD-0001.pdf");
const up = await call("POST", `/projects/${project.id}/folders/${disciplines.Statik}/files`, form);
console.log(up.results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`).join("\n"));
console.log(`Demo project ${project.code} ready: ${project.id}`);
