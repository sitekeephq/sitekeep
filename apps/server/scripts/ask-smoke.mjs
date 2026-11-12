// Manual smoke test of the "Sor" assistant against a REAL local model (not part of npm test).
//
//   node --env-file=.env.development scripts/ask-smoke.mjs ["Soru"]
//
// Needs a running dev server with the demo seed (scripts/seed-demo.mjs) and Ollama.
// Environment: PORT (8787), ADMIN_EMAIL, ADMIN_PASSWORD, PROJECT (ZAVM), AS_USER (e-mail; default admin;
// demo users share ADMIN_PASSWORD), OLLAMA_URL (http://127.0.0.1:11434/v1), OLLAMA_MODEL (qwen3:8b).
// Creates an "Ollama (smoke)" provider on first run and makes it the default.
const base = `http://127.0.0.1:${process.env.PORT ?? 8787}/api/v1`;
const question = process.argv[2] ?? "Bu projede kaç IFC modeli var, eleman sayıları?";
const ollama = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434/v1";
const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";

function session() {
  let cookie = "";
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
    return data;
  };
}

const admin = session();
await admin("POST", "/auth/login", { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
const settings = await admin("GET", "/admin/settings");
let provider = settings.ai.providers.find((p) => p.baseUrl === ollama.replace(/\/+$/, "") && p.model === model);
if (!provider) {
  provider = await admin("POST", "/admin/ai/providers", {
    name: "Ollama (smoke)",
    kind: "openai_compatible",
    baseUrl: ollama,
    model,
    disableThinking: true,
  });
  console.log(`Provider created: ${provider.name} (${model})`);
}
await admin("PUT", "/admin/settings/ai", { defaultProviderId: provider.id, ...(settings.ai.mode === "off" ? { mode: "local_only" } : {}) });

const user = process.env.AS_USER ? session() : admin;
if (process.env.AS_USER) await user("POST", "/auth/login", { email: process.env.AS_USER, password: process.env.ADMIN_PASSWORD });
const project = (await user("GET", "/projects")).find((p) => p.code === (process.env.PROJECT ?? "ZAVM"));
if (!project) throw new Error("Demo project not found; run scripts/seed-demo.mjs first.");

console.log(`\nSoru: ${question}\nModel: ${model} · proje: ${project.code}\n`);
const t0 = Date.now();
let job = await user("POST", `/projects/${project.id}/ask`, { question });
let shown = 0;
while (job.status === "running") {
  await new Promise((r) => setTimeout(r, 1000));
  job = await user("GET", `/projects/${project.id}/ask/${job.id}`);
  for (const s of job.steps.slice(shown)) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${s.label}`);
  shown = job.steps.length;
}
if (job.error) {
  console.error(`\n${job.status}: ${job.error.code} — ${job.error.message}`);
  process.exit(1);
}
const r = job.result;
console.log(`\n--- Cevap (${(r.ms / 1000).toFixed(1)} s, ${r.model}, ${r.protocol}, ${r.rounds} tur) ---\n${r.answer}\n`);
console.log("Araçlar:", r.toolCalls.map((t) => `${t.tool} ${t.ok ? "ok" : "HATA " + (t.error ?? "")} ${t.ms} ms`).join(" | ") || "-");
console.log("Kaynaklar:", r.sources.map((s) => `${s.cited ? "*" : ""}${s.type}:${s.label}`).join(", ") || "-");
