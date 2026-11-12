/** Minimal HS256 JSON Web Tokens (ONLYOFFICE Docs signs and checks requests with a shared secret). */
import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signJwt(payload: object, secret: string, expiresInSec = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now, exp: now + expiresInSec, ...payload }));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/** Returns the payload when the signature (and expiry, if any) is valid, else null. */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
    if (h.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
