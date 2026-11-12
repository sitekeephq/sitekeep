// SiteKeep load test (k6). Read-heavy user mix plus optional uploads.
//
//   k6 run -e CDE_URL=https://staging.example -e CDE_TOKEN=7dcde_... -e CDE_PROJECT=<id|kod> \
//          -e PROFILE=load load/k6/cde.js
//
// PROFILE: smoke | load | stress | spike | soak     (default smoke)
// UPLOAD=1 adds uploads (writes test files into WIP_FOLDER; use a test project only).
// Never point stress/spike/soak at production. See load/k6/README.md.
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = (__ENV.CDE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const API = `${BASE}/api/v1`;
const TOKEN = __ENV.CDE_TOKEN;
const PROJECT = __ENV.CDE_PROJECT;
const PROFILE = __ENV.PROFILE || "smoke";
const UPLOAD = __ENV.UPLOAD === "1";
const SEARCH_TERMS = (__ENV.SEARCH_TERMS || "ifc,pafta,beton,rapor,kesit").split(",");

const listLatency = new Trend("cde_folder_list_ms", true);
const searchLatency = new Trend("cde_search_ms", true);
const uploadLatency = new Trend("cde_upload_ms", true);
const businessErrors = new Rate("cde_business_errors");

const PROFILES = {
  smoke: { vus: 2, duration: "1m" },
  load: { stages: [{ duration: "5m", target: 200 }, { duration: "30m", target: 200 }, { duration: "5m", target: 0 }] },
  stress: {
    stages: [
      { duration: "5m", target: 200 },
      { duration: "5m", target: 400 },
      { duration: "5m", target: 800 },
      { duration: "5m", target: 1200 },
      { duration: "5m", target: 0 },
    ],
  },
  spike: { stages: [{ duration: "1m", target: 20 }, { duration: "30s", target: 500 }, { duration: "3m", target: 500 }, { duration: "2m", target: 20 }] },
  soak: { stages: [{ duration: "10m", target: 100 }, { duration: "8h", target: 100 }, { duration: "10m", target: 0 }] },
};

export const options = {
  ...PROFILES[PROFILE],
  thresholds: {
    http_req_failed: ["rate<0.001"],
    http_req_duration: ["p(95)<500", "p(99)<1500"],
    cde_folder_list_ms: ["p(95)<1000"],
    cde_search_ms: ["p(95)<1500"],
    cde_business_errors: ["rate<0.001"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const headers = () => ({ Authorization: `Bearer ${TOKEN}` });

export function setup() {
  if (!TOKEN || !PROJECT) throw new Error("CDE_TOKEN ve CDE_PROJECT gerekli (README).");
  const health = http.get(`${API}/health`);
  check(health, { "health 200": (r) => r.status === 200 });
  const projects = http.get(`${API}/projects`, { headers: headers() }).json();
  const project = projects.find((p) => p.id === PROJECT || p.code === PROJECT);
  if (!project) throw new Error(`Proje bulunamadı: ${PROJECT}`);
  const root = http.get(`${API}/projects/${project.id}/folders/${project.rootFolderId}/contents`, { headers: headers() }).json();
  const folders = (root.folders || []).map((f) => f.id);
  return { pid: project.id, root: project.rootFolderId, folders, wip: __ENV.WIP_FOLDER || folders[0] || project.rootFolderId };
}

export default function (data) {
  group("klasör gezme", () => {
    const fid = data.folders.length ? data.folders[Math.floor(Math.random() * data.folders.length)] : data.root;
    const r = http.get(`${API}/projects/${data.pid}/folders/${fid}/contents`, { headers: headers(), tags: { name: "folder_contents" } });
    listLatency.add(r.timings.duration);
    businessErrors.add(!check(r, { "klasör 200": (x) => x.status === 200 }));
  });
  sleep(1 + Math.random() * 2);

  group("arama", () => {
    const q = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
    const r = http.get(`${API}/projects/${data.pid}/search?q=${encodeURIComponent(q)}`, { headers: headers(), tags: { name: "search" } });
    searchLatency.add(r.timings.duration);
    businessErrors.add(!check(r, { "arama 200": (x) => x.status === 200 }));
  });
  sleep(1 + Math.random() * 3);

  group("kimlik ve bildirim", () => {
    const me = http.get(`${API}/auth/me`, { headers: headers(), tags: { name: "auth_me" } });
    businessErrors.add(!check(me, { "me 200": (x) => x.status === 200 }));
  });

  if (UPLOAD && Math.random() < 0.05) {
    group("yükleme", () => {
      const body = "x".repeat(256 * 1024);
      const name = `LOAD-TEST-${__VU}-${__ITER}-${Date.now()}.txt`;
      const r = http.post(
        `${API}/projects/${data.pid}/folders/${data.wip}/files`,
        { file: http.file(body, name, "text/plain") },
        { headers: headers(), tags: { name: "upload" } },
      );
      uploadLatency.add(r.timings.duration);
      businessErrors.add(!check(r, { "yükleme 2xx": (x) => x.status >= 200 && x.status < 300 }));
    });
  }
  sleep(2 + Math.random() * 3);
}

export function handleSummary(summary) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    [`load/k6/results/${PROFILE}-${stamp}.json`]: JSON.stringify(summary, null, 2),
    stdout: `\nProfil: ${PROFILE}  •  Sonuç dosyası: load/k6/results/${PROFILE}-${stamp}.json\n`,
  };
}
