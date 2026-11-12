/**
 * WOPI proof keys: the editor signs every WOPI request with its private key; the host checks
 * the signature with the public key from the editor's discovery XML.
 * https://learn.microsoft.com/microsoft-365/cloud-storage-partner-program/online/scenarios/proofkeys
 *
 * Signed bytes: [len][access token] [len][request URL in upper case] [len=8][timestamp (Int64)],
 * every length a 4-byte big-endian integer. Signature: RSA PKCS#1 v1.5 with SHA-256.
 * Valid when X-WOPI-Proof verifies with the current key, X-WOPI-ProofOld with the current key,
 * or X-WOPI-Proof with the old key. The timestamp (.NET ticks) must be at most 20 minutes old.
 */
import { createPublicKey, createSign, createVerify, type KeyObject } from "node:crypto";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** Proof failures go to logs and the editor: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

/** .NET ticks (100 ns since 0001-01-01) at the Unix epoch. */
const EPOCH_TICKS = 621_355_968_000_000_000n;
export const PROOF_MAX_AGE_MS = 20 * 60 * 1000;

export function ticksFromDate(d: Date): bigint {
  return EPOCH_TICKS + BigInt(d.getTime()) * 10_000n;
}

export function dateFromTicks(ticks: bigint): Date {
  return new Date(Number((ticks - EPOCH_TICKS) / 10_000n));
}

export interface ProofKeyAttributes {
  value?: string;
  modulus?: string;
  exponent?: string;
  oldvalue?: string;
  oldmodulus?: string;
  oldexponent?: string;
}

export interface ProofKeys {
  current: KeyObject | null;
  old: KeyObject | null;
}

/** RSA public key from base64 modulus and exponent (big-endian, as in the discovery XML). */
export function publicKeyFromModulus(modulusB64: string, exponentB64: string): KeyObject {
  const n = Buffer.from(modulusB64, "base64").toString("base64url");
  const e = Buffer.from(exponentB64, "base64").toString("base64url");
  return createPublicKey({ key: { kty: "RSA", n, e }, format: "jwk" });
}

/** RSA public key from a Windows CSP PUBLICKEYBLOB (the discovery "value" attribute). */
export function publicKeyFromCspBlob(valueB64: string): KeyObject {
  const blob = Buffer.from(valueB64, "base64");
  // BLOBHEADER (8 bytes) + RSAPUBKEY: magic "RSA1", bit length, public exponent (little-endian).
  if (blob.length < 20 || blob.toString("latin1", 8, 12) !== "RSA1") throw new Error(t("office:proof.unknownFormat"));
  const bits = blob.readUInt32LE(12);
  const exponent = blob.readUInt32LE(16);
  const modulusLe = blob.subarray(20, 20 + bits / 8);
  if (modulusLe.length !== bits / 8) throw new Error(t("office:proof.short"));
  const n = Buffer.from(modulusLe).reverse();
  let e = Buffer.alloc(4);
  e.writeUInt32BE(exponent);
  while (e.length > 1 && e[0] === 0) e = e.subarray(1);
  return createPublicKey({ key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") }, format: "jwk" });
}

function keyOf(modulus?: string, exponent?: string, value?: string): KeyObject | null {
  try {
    if (modulus && exponent) return publicKeyFromModulus(modulus, exponent);
    if (value) return publicKeyFromCspBlob(value);
  } catch {
    /* unusable key */
  }
  return null;
}

export function proofKeysFrom(a: ProofKeyAttributes): ProofKeys {
  return { current: keyOf(a.modulus, a.exponent, a.value), old: keyOf(a.oldmodulus, a.oldexponent, a.oldvalue) };
}

export function expectedProofBytes(accessToken: string, url: string, ticks: bigint): Buffer {
  const token = Buffer.from(accessToken, "utf8");
  const u = Buffer.from(url.toUpperCase(), "utf8");
  const parts: Buffer[] = [];
  const len = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const ts = Buffer.alloc(8);
  ts.writeBigInt64BE(ticks);
  parts.push(len(token.length), token, len(u.length), u, len(8), ts);
  return Buffer.concat(parts);
}

function verifies(key: KeyObject | null, data: Buffer, signatureB64: string | undefined): boolean {
  if (!key || !signatureB64) return false;
  try {
    const v = createVerify("RSA-SHA256");
    v.update(data);
    return v.verify(key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export interface ProofInput {
  accessToken: string;
  /** Absolute request URLs to try (the editor may know the host under another name). */
  urls: string[];
  timestamp: string | undefined;
  proof: string | undefined;
  proofOld: string | undefined;
  now?: Date;
}

export type ProofResult = { ok: true } | { ok: false; reason: string };

export function verifyProof(keys: ProofKeys, input: ProofInput): ProofResult {
  if (!input.proof) return { ok: false, reason: t("office:proof.noProof") };
  if (!input.timestamp || !/^\d{1,20}$/.test(input.timestamp)) return { ok: false, reason: t("office:proof.badTimestamp") };
  const ticks = BigInt(input.timestamp);
  const age = (input.now ?? new Date()).getTime() - dateFromTicks(ticks).getTime();
  if (Math.abs(age) > PROOF_MAX_AGE_MS) return { ok: false, reason: t("office:proof.tooOld") };
  for (const url of input.urls) {
    const data = expectedProofBytes(input.accessToken, url, ticks);
    if (verifies(keys.current, data, input.proof)) return { ok: true };
    if (verifies(keys.current, data, input.proofOld)) return { ok: true };
    if (verifies(keys.old, data, input.proof)) return { ok: true };
  }
  return { ok: false, reason: t("office:proof.badSignature") };
}

/** Signs like a WOPI client (tests and local tools). */
export function signProof(privateKeyPem: string, accessToken: string, url: string, ticks: bigint): string {
  const s = createSign("RSA-SHA256");
  s.update(expectedProofBytes(accessToken, url, ticks));
  return s.sign(privateKeyPem, "base64");
}
