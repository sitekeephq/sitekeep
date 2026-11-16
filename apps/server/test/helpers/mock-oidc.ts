/**
 * A local OpenID Connect provider for tests (no network): discovery, JWKS, the authorization step,
 * the token endpoint (client authentication, PKCE S256 check) and userinfo. Unit tests route
 * globalThis.fetch to `handle`; the e2e suite serves the same object over http (e2e/support/oidc-provider.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

type Claims = Record<string, unknown>;

interface Pending {
  redirectUri: string;
  nonce: string;
  challenge: string;
  claims: Claims;
}

export interface MockOidcOptions {
  issuer: string;
  clientId?: string;
  /** null: a public client (PKCE only). */
  clientSecret?: string | null;
  /** Token endpoint client authentication the discovery document announces. */
  authMethods?: string[];
}

/** Ways to spoil the ID token (each test of a validation rule sets one). */
export interface Tamper {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  nonce?: string;
  /** Seconds from now; negative = already expired. */
  expiresIn?: number;
  /** Signed with a key that is not in the JWKS. */
  foreignKey?: boolean;
  /** "none" (unsigned) or "HS256" with the client secret. */
  alg?: "none" | "HS256";
  /** Leave the e-mail claim out of the ID token (userinfo has it). */
  emailOnlyInUserinfo?: boolean;
}

export class MockOidcProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly authMethods: string[];
  /** The person signed in at the provider: the claims of the next ID token. */
  user: Claims = {};
  tamper: Tamper = {};
  /** Every URL the server fetched, in order. */
  readonly requests: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private key!: { privateKey: CryptoKey; jwk: JWK };
  private foreign!: { privateKey: CryptoKey };

  private constructor(o: MockOidcOptions) {
    this.issuer = o.issuer.replace(/\/+$/, "");
    this.clientId = o.clientId ?? "sitekeep-test";
    this.clientSecret = o.clientSecret === undefined ? "s3cret-value" : o.clientSecret;
    this.authMethods = o.authMethods ?? ["client_secret_basic", "client_secret_post"];
  }

  static async create(o: MockOidcOptions): Promise<MockOidcProvider> {
    const p = new MockOidcProvider(o);
    await p.rotateKeys();
    p.foreign = await generateKeyPair("RS256");
    return p;
  }

  /** A new signing key (old ID tokens fail; the server must download the JWKS again). */
  async rotateKeys(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: randomBytes(6).toString("hex"), alg: "RS256", use: "sig" };
    this.key = { privateKey, jwk };
  }

  get discovery() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: this.authMethods,
      code_challenge_methods_supported: ["S256"],
    };
  }

  /**
   * The browser at the authorization endpoint: the person (this.user) signs in and is sent back.
   * Returns the redirect to the client's callback with code and state.
   */
  authorize(authorizationUrl: string): string {
    const u = new URL(authorizationUrl);
    const q = u.searchParams;
    if (`${u.origin}${u.pathname}` !== this.discovery.authorization_endpoint) throw new Error(`not this provider: ${authorizationUrl}`);
    if (q.get("client_id") !== this.clientId || q.get("response_type") !== "code") throw new Error("bad authorization request");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) throw new Error("PKCE S256 missing");
    if (!q.get("scope")?.split(" ").includes("openid")) throw new Error("scope openid missing");
    const code = randomBytes(16).toString("base64url");
    this.pending.set(code, { redirectUri: q.get("redirect_uri")!, nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, claims: { ...this.user } });
    const back = new URL(q.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state")!);
    return back.toString();
  }

  /** fetch() of the server, answered locally. */
  handle = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    this.requests.push(url.toString());
    const path = url.pathname.slice(new URL(this.issuer).pathname.replace(/\/$/, "").length);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/.well-known/openid-configuration") return json(this.discovery);
    if (path === "/jwks") return json({ keys: [this.key.jwk] });
    if (path === "/token" && (init.method ?? "GET") === "POST") return this.token(init, json);
    if (path === "/userinfo") {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      const claims = this.accessTokens.get(auth.replace(/^Bearer /, ""));
      return claims ? json(claims) : json({ error: "invalid_token" }, 401);
    }
    return json({ error: "not_found" }, 404);
  };

  private readonly accessTokens = new Map<string, Claims>();

  private async token(init: RequestInit, json: (b: unknown, s?: number) => Response): Promise<Response> {
    const body = new URLSearchParams(init.body instanceof URLSearchParams ? init.body : String(init.body ?? ""));
    const headers = new Headers(init.headers);
    let clientId = body.get("client_id");
    let secret = body.get("client_secret");
    const basic = headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const [id, s] = Buffer.from(basic.slice(6), "base64").toString().split(":").map((x) => decodeURIComponent(x.replace(/\+/g, " ")));
      clientId = id ?? null;
      secret = s ?? null;
    }
    if (clientId !== this.clientId || (this.clientSecret !== null && secret !== this.clientSecret)) return json({ error: "invalid_client" }, 401);
    const p = this.pending.get(body.get("code") ?? "");
    if (!p || body.get("grant_type") !== "authorization_code") return json({ error: "invalid_grant" }, 400);
    this.pending.delete(body.get("code")!);
    if (body.get("redirect_uri") !== p.redirectUri) return json({ error: "invalid_grant", error_description: "redirect_uri" }, 400);
    const verifier = body.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== p.challenge) return json({ error: "invalid_grant", error_description: "PKCE" }, 400);

    const t = this.tamper;
    const { email, ...rest } = p.claims;
    const claims: Claims = { ...(t.emailOnlyInUserinfo ? rest : p.claims), nonce: t.nonce ?? p.nonce, ...(t.azp ? { azp: t.azp } : {}) };
    const access = randomBytes(16).toString("base64url");
    this.accessTokens.set(access, { ...p.claims, ...(email !== undefined ? { email } : {}) });
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(claims)
      .setIssuer(t.iss ?? this.issuer)
      .setAudience(t.aud ?? this.clientId)
      .setSubject(String(p.claims.sub ?? "subject-1"))
      .setIssuedAt(now)
      .setExpirationTime(now + (t.expiresIn ?? 300));
    let idToken: string;
    if (t.alg === "none") {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      idToken = `${enc({ alg: "none", typ: "JWT" })}.${enc({ ...claims, iss: this.issuer, aud: this.clientId, sub: p.claims.sub, iat: now, exp: now + 300 })}.`;
    } else if (t.alg === "HS256") {
      idToken = await jwt.setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(this.clientSecret ?? "x".repeat(32)));
    } else if (t.foreignKey) {
      idToken = await jwt.setProtectedHeader({ alg: "RS256", kid: this.key.jwk.kid! }).sign(this.foreign.privateKey);
    } else {
      idToken = await jwt.setProtectedHeader({ alg: "RS256", kid: this.key.jwk.kid! }).sign(this.key.privateKey);
    }
    return json({ access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken });
  }
}
