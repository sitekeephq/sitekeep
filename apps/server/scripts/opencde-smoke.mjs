// Manual smoke test of the OpenCDE Foundation API and the OAuth2 server (not part of npm test).
//
//   node --env-file=.env.development scripts/opencde-smoke.mjs
//
// Needs a running LOCAL dev server (npm run dev -w @sitekeep/server). It refuses other hosts.
// Environment: PORT (8787) or CDE_SMOKE_BASE (http://127.0.0.1:8787), ADMIN_EMAIL, ADMIN_PASSWORD.
//
// Steps: /foundation/versions → /foundation/1.1/auth → sign in → register a temporary public client
// → /oauth2/authorize (PKCE) → consent → code → /oauth2/token → current-user and /api/v1 with the
// access token → refresh rotation → reuse detection → Documents API (upload/select pages, cancelled)
// → "Erişimi Kaldır" → delete the client.
// The browser redirect to the loopback address is not followed; the code is read from the
// Location header. Tokens are never printed in full.
import { createHash, randomBytes } from "node:crypto";

const base = (process.env.CDE_SMOKE_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, "");
const host = new URL(base).hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
  console.error(`Yalnız yerel geliştirme sunucusunda çalışır (verilen: ${base}).`);
  process.exit(2);
}
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error("ADMIN_EMAIL ve ADMIN_PASSWORD gerekli (node --env-file=.env.development …).");
  process.exit(2);
}

const REDIRECT = "http://127.0.0.1/callback";
const short = (t) => (typeof t === "string" ? `${t.slice(0, 14)}…` : String(t));
let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

let cookie = "";
async function call(method, path, { body, bearer, form, manual } = {}) {
  const headers = {};
  if (cookie && !bearer) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body) headers["content-type"] = "application/json";
  if (form) headers["content-type"] = "application/x-www-form-urlencoded";
  const res = await fetch(base + path, {
    method,
    headers,
    redirect: manual ? "manual" : "follow",
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  const session = set.find((c) => c.startsWith("cde_session="));
  if (session) cookie = session.split(";")[0];
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, location: res.headers.get("location") };
}

let clientRowId = null;
try {
  const versions = await call("GET", "/foundation/versions");
  check(versions.status === 200 && versions.data?.versions?.some((v) => v.api_id === "foundation" && v.version_id === "1.1"), "GET /foundation/versions", JSON.stringify(versions.data?.versions?.map((v) => `${v.api_id} ${v.version_id}`)));
  const auth = await call("GET", "/foundation/1.1/auth");
  check(auth.status === 200 && auth.data?.supported_oauth2_flows?.[0] === "authorization_code_grant", "GET /foundation/1.1/auth", `${auth.data?.oauth2_auth_url} | ${auth.data?.oauth2_token_url}`);

  const login = await call("POST", "/api/v1/auth/login", { body: { email, password } });
  if (!check(login.status === 200, "Giriş (yönetici)")) throw new Error("login failed");

  const created = await call("POST", "/api/v1/admin/oauth-clients", {
    body: { name: `Smoke ${new Date().toISOString()}`, type: "public", redirectUris: [REDIRECT], scopes: ["bcf", "read", "documents"] },
  });
  if (!check(created.status === 200, "Geçici açık istemci kaydı", created.data?.client?.clientId)) throw new Error(JSON.stringify(created.data));
  clientRowId = created.data.client.id;
  const clientId = created.data.client.clientId;

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:53682/callback",
    scope: "bcf read",
    state: randomBytes(8).toString("hex"),
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const authz = await call("GET", `/oauth2/authorize?${new URLSearchParams(params)}`, { manual: true });
  check(authz.status === 302 && authz.location?.startsWith("/oauth/consent?"), "GET /oauth2/authorize → onay sayfası", authz.location?.split("?")[0]);
  const consentQuery = authz.location.split("?")[1];
  const info = await call("GET", `/api/v1/oauth/authorize-info?${consentQuery}`);
  check(info.status === 200, "Onay sayfası bilgisi", `${info.data?.client?.name}: ${info.data?.scopes?.join(", ")}`);
  const decided = await call("POST", "/api/v1/oauth/consent", { body: { params: Object.fromEntries(new URLSearchParams(consentQuery)), approve: true } });
  const back = new URL(decided.data.redirectTo);
  const code = back.searchParams.get("code");
  check(!!code && back.searchParams.get("state") === params.state && back.port === "53682", "Onayla → kod (loopback, port 53682)", short(code));

  const token = await call("POST", "/oauth2/token", {
    form: { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: params.redirect_uri, code_verifier: verifier },
  });
  check(token.status === 200 && token.data?.token_type === "Bearer", "POST /oauth2/token (authorization_code + PKCE)", `${short(token.data?.access_token)} ${token.data?.expires_in}s, scope "${token.data?.scope}"`);
  const again = await call("POST", "/oauth2/token", {
    form: { grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier },
  });
  check(again.data?.error === "invalid_grant", "Aynı kod ikinci kez reddedilir");

  // Use a fresh grant for the rest (the reused code revoked the first family).
  const authz2 = await call("GET", `/oauth2/authorize?${new URLSearchParams(params)}`, { manual: true });
  const code2 = new URL(authz2.location).searchParams.get("code");
  check(!!code2, "Hatırlanan onay: sayfa göstermeden kod");
  const t2 = await call("POST", "/oauth2/token", {
    form: { grant_type: "authorization_code", code: code2, client_id: clientId, code_verifier: verifier },
  });
  const me = await call("GET", "/foundation/1.1/current-user", { bearer: t2.data?.access_token });
  check(me.status === 200 && me.data?.id === email.toLowerCase(), "GET /foundation/1.1/current-user", JSON.stringify(me.data));
  const projects = await call("GET", "/api/v1/projects", { bearer: t2.data?.access_token });
  check(projects.status === 200, "GET /api/v1/projects (OAuth erişim anahtarıyla)", `${projects.data?.length} proje`);
  const write = await call("POST", "/api/v1/projects", { bearer: t2.data?.access_token, body: { code: "SMOKE", name: "x" } });
  check(write.status === 403, "Okuma izniyle yazma reddedilir", String(write.status));

  const r1 = await call("POST", "/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: t2.data?.refresh_token, client_id: clientId } });
  check(r1.status === 200 && r1.data.refresh_token !== t2.data?.refresh_token, "Yenileme: yeni refresh token (rotation)");
  const reuse = await call("POST", "/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: t2.data?.refresh_token, client_id: clientId } });
  const afterReuse = await call("GET", "/foundation/1.1/current-user", { bearer: r1.data?.access_token });
  check(reuse.data?.error === "invalid_grant" && afterReuse.status === 401, "Eski refresh token yeniden kullanılınca aile iptal edilir");

  // OpenCDE Documents API 1.0: start both flows, open the pages and cancel them (writes no files).
  const docsApi = versions.data?.versions?.find((v) => v.api_id === "documents" && v.version_id === "1.0");
  check(!!docsApi, "Documents 1.0 duyuruluyor", docsApi?.api_base_url);
  const authz3 = await call("GET", `/oauth2/authorize?${new URLSearchParams({ ...params, scope: "documents" })}`, { manual: true });
  let code3 = authz3.location?.startsWith("/oauth/consent?") ? null : new URL(authz3.location).searchParams.get("code");
  if (!code3) {
    const q3 = authz3.location.split("?")[1];
    const d3 = await call("POST", "/api/v1/oauth/consent", { body: { params: Object.fromEntries(new URLSearchParams(q3)), approve: true } });
    code3 = new URL(d3.data.redirectTo).searchParams.get("code");
  }
  const t3 = await call("POST", "/oauth2/token", { form: { grant_type: "authorization_code", code: code3, client_id: clientId, code_verifier: verifier } });
  const docsPath = new URL(docsApi?.api_base_url ?? `${base}/documents/1.0`).pathname;
  const cb = "http://127.0.0.1:53683/cde-callback";
  const evil = await call("POST", `${docsPath}/upload-documents`, {
    bearer: t3.data?.access_token,
    body: { callback: { url: "https://evil.example.com/cb", expires_in: 600 }, files: [{ file_name: "a.ifc", session_file_id: "1" }] },
  });
  check(evil.status === 400, "Yabancı callback reddedilir", String(evil.status));
  for (const kind of ["upload", "select"]) {
    const started = await call("POST", `${docsPath}/${kind === "upload" ? "upload-documents" : "select-documents"}`, {
      bearer: t3.data?.access_token,
      body: { callback: { url: cb, expires_in: 600 }, ...(kind === "upload" && { files: [{ file_name: "smoke.ifc", session_file_id: "1" }] }) },
    });
    const pageUrl = started.data?.upload_ui_url ?? started.data?.select_documents_url;
    check(started.status === 200 && !!pageUrl, `POST ${kind}-documents → CDE sayfası`, pageUrl?.split("?")[0]);
    const key = pageUrl ? new URL(pageUrl).searchParams.get("key") : "";
    const page = await call("GET", `/api/v1/opencde/sessions/${key}`);
    check(page.status === 200 && page.data?.kind === kind, "Sayfa bilgisi (tarayıcı oturumu)", page.data?.client?.name);
    const cancelled = await call("POST", `/api/v1/opencde/sessions/${key}/cancel`, { body: {} });
    const back3 = cancelled.data?.redirectTo ? new URL(cancelled.data.redirectTo) : null;
    check(back3?.searchParams.get(kind === "upload" ? "user_cancelled_upload" : "user_cancelled_selection") === "true", "İptal → uygulamaya dönüş", back3?.host);
  }

  const apps = await call("GET", "/api/v1/auth/oauth-apps");
  check(apps.data?.some?.((a) => a.id === clientRowId), "Hesabım → Bağlı Uygulamalar listesinde");
  const revoked = await call("DELETE", `/api/v1/auth/oauth-apps/${clientRowId}`);
  check(revoked.status === 200, "Erişimi Kaldır");
} catch (err) {
  check(false, "Beklenmeyen hata", err.message);
} finally {
  if (clientRowId) {
    const del = await call("DELETE", `/api/v1/admin/oauth-clients/${clientRowId}`);
    check(del.status === 200, "Geçici istemci silindi");
  }
}

console.log(failures ? `\n${failures} adım başarısız.` : "\nTüm adımlar geçti.");
process.exit(failures ? 1 : 0);
