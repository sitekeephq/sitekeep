// Local copy of the S16 station folder tree used by the product tour.
// Does not dump live IFC files — uploads the tiny sample-wall.ifc into 01-Mimari.
//
//   cd apps/server && node --env-file=.env.development scripts/seed-tour-station.mjs
//
// Optional: PROJECT_ID=<uuid>  (defaults to d4d03c83-… then the first project)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = `http://127.0.0.1:${process.env.PORT ?? 8787}/api/v1`;
const password = process.env.ADMIN_PASSWORD ?? "change-me-please";
const email = process.env.ADMIN_EMAIL ?? "admin@7d-cde.localhost";
const preferredId = process.env.PROJECT_ID ?? "d4d03c83-a3b7-4d60-a7dc-b8c0bfd45e1a";
const ifcName = "S16-Mimari-ornek.ifc";
let cookie = "";

const PATH = [
  "01-TASARIM ÇALIŞMALARI",
  "02-Onaya Sunulan (Shared for Approval)",
  "002-İstasyonlar",
  "S16",
];
const DISCIPLINES = ["00-Koordinasyon Modeli", "01-Mimari", "02-Yapısal", "04-Mekanik", "05-Elektrik"];

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

async function ensureChild(projectId, parentId, name) {
  const contents = await call("GET", `/projects/${projectId}/folders/${parentId}/contents`);
  const existing = contents.folders.find((f) => f.name === name);
  if (existing) return existing.id;
  return (await call("POST", `/projects/${projectId}/folders`, { parentId, name })).id;
}

await call("POST", "/auth/login", { email, password });
const projects = await call("GET", "/projects");
const project = projects.find((p) => p.id === preferredId) ?? projects[0];
if (!project) throw new Error("No local project. Open the app once so a project exists, then re-run.");

let folderId = project.rootFolderId;
for (const name of PATH) folderId = await ensureChild(project.id, folderId, name);
const s16 = folderId;
const ids = {};
for (const name of DISCIPLINES) ids[name] = await ensureChild(project.id, s16, name);

async function waitReady(fileId) {
  for (let i = 0; i < 90; i += 1) {
    const file = await call("GET", `/projects/${project.id}/files/${fileId}`);
    const status = file.latest?.derivativeStatus;
    if (status === "ready") return;
    if (status === "failed") throw new Error(file.latest?.derivativeError ?? "IFC conversion failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("IFC still converting — Modeli Aç will appear when it finishes.");
}

const mimari = await call("GET", `/projects/${project.id}/folders/${ids["01-Mimari"]}/contents`);
let ifcFile = mimari.files.find((f) => f.name.toLowerCase().endsWith(".ifc"));
if (!ifcFile) {
  const ifc = readFileSync(path.join(here, "../test/fixtures/sample-wall.ifc"));
  const form = new FormData();
  form.append("file", new Blob([ifc]), ifcName);
  const up = await call("POST", `/projects/${project.id}/folders/${ids["01-Mimari"]}/files`, form);
  const row = up.results[0];
  if (!row?.ok || !row.fileId) throw new Error(`IFC upload failed: ${row?.errors?.join(", ") || "unknown"}`);
  console.log(`Uploaded ${ifcName} (${row.fileId}). Waiting for conversion…`);
  await waitReady(row.fileId);
  console.log("Modeli Aç is ready.");
} else {
  console.log("01-Mimari already has an IFC; skipped upload.");
  if (ifcFile.latest?.derivativeStatus !== "ready") {
    console.log("Waiting for existing IFC conversion…");
    await waitReady(ifcFile.id);
    console.log("Modeli Aç is ready.");
  }
}

console.log(`Tour folders ready in ${project.name} (${project.id})`);
console.log(`S16: /projects/${project.id}/files/${s16}`);
console.log(`01-Mimari: /projects/${project.id}/files/${ids["01-Mimari"]}`);
