/**
 * "Bırak, kaydet": the dropped file is stored in object storage while the user checks the draft;
 * the client gets a signed reference (HMAC with the server secret, bound to project, user and a
 * deadline) and sends it back with "Kaydet". Only then the file becomes a project file and the
 * work's "ek". No database row exists before that; a cancelled draft leaves only the blob.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { StoredObject } from "../core/platform/storage.js";
import { HttpError } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

/** How long a draft's upload can be saved. */
export const UPLOAD_TTL_MS = 24 * 3600_000;

export interface StagedUpload {
  projectId: string;
  userId: string;
  obj: StoredObject;
  name: string;
  /** Epoch ms. */
  expiresAt: number;
}

interface Payload {
  p: string;
  u: string;
  k: string;
  s: number;
  h: string;
  n: string;
  e: number;
}

function mac(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret).update(`record-from-file:${body}`).digest();
}

export function signUpload(secret: Buffer, u: StagedUpload): string {
  const p: Payload = { p: u.projectId, u: u.userId, k: u.obj.key, s: u.obj.size, h: u.obj.sha256, n: u.name, e: u.expiresAt };
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

const expired = () => new HttpError(410, "upload_expired", msg("works:errors.uploadExpired"));

/** Verifies a reference for this project and user; 400 when forged, 410 when expired. */
export function readUpload(secret: Buffer, token: string, projectId: string, userId: string, now = Date.now()): StagedUpload {
  const [body, sig] = token.split(".");
  const bad = new HttpError(400, "bad_upload", msg("works:errors.badUpload"));
  if (!body || !sig) throw bad;
  const want = mac(secret, body);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad;
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    throw bad;
  }
  if (p.p !== projectId || p.u !== userId) throw bad;
  if (!(p.e > now)) throw expired();
  if (!/^projects\/[0-9a-f-]+\/files\//.test(p.k)) throw bad;
  return { projectId: p.p, userId: p.u, obj: { key: p.k, size: p.s, sha256: p.h }, name: p.n, expiresAt: p.e };
}
