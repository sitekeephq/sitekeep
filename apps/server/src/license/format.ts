/**
 * The licence file (docs/onprem/lisanslama.md §4): `{ format, version, kid, payload, signature }`, the
 * payload base64url UTF-8 JSON signed with Ed25519 exactly as stored. Verification only; licences are
 * issued by 7Dimensions (Odoo → signing service), never here.
 */
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { LICENSE_KEYS } from "./keys.js";

/** What a licence grants (lisanslama.md §4.1, adapted to SiteKeep editions: modules are Enterprise module ids). */
export const licensePayloadSchema = z.object({
  lid: z.string().min(1).max(64),
  customer: z.object({ id: z.string().max(100), name: z.string().min(1).max(200) }),
  /** The installation the licence belongs to (Yönetim → Lisans shows it); "*" for trials and our own installations. */
  installation: z.string().min(1).max(100),
  edition: z.enum(["enterprise", "trial"]),
  /** The plan sold (licensing-online.md §1); older licences have none. Information only: `modules` decides. */
  plan: z.enum(["standard", "plus", "trial", "internal"]).nullable().optional(),
  /** Active user accounts; null = unlimited. */
  seats: z.number().int().positive().nullable(),
  /** Enterprise modules the licence turns on (KNOWN_MODULES ids). */
  modules: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/)).max(50),
  issuedAt: z.iso.datetime(),
  validFrom: z.iso.datetime(),
  /** End of use; null = perpetual. */
  validUntil: z.iso.datetime().nullable(),
  /** Builds made after this date are not covered (lisanslama.md §5.4). */
  supportUntil: z.iso.datetime(),
  /** Full use after validUntil, then read-only. */
  graceDays: z.number().int().min(0).max(365).default(30),
  online: z.enum(["optional", "required", "off"]).default("optional"),
  hardware: z.array(z.string().max(100)).max(10).default([]),
  notes: z.string().max(2000).nullable().default(null),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

const fileSchema = z.object({
  format: z.literal("sitekeep-license"),
  version: z.literal(1),
  kid: z.string().min(1).max(40),
  payload: z.string().min(1).max(20_000),
  signature: z.string().min(1).max(200),
});

/** Verifies `{ kid, payload, signature }`: the signature covers the payload string exactly as stored. */
function verifySigned(file: { kid: string; payload: string; signature: string }, production: boolean): "ok" | "unknown_key" | "dev_key_in_production" | "signature" {
  const key = LICENSE_KEYS[file.kid];
  if (!key) return "unknown_key";
  if (key.devOnly && production) return "dev_key_in_production";
  const publicKey = createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
  try {
    return verify(null, Buffer.from(file.payload, "utf8"), publicKey, Buffer.from(file.signature, "base64url")) ? "ok" : "signature";
  } catch {
    return "signature";
  }
}

export type ParsedLicense = { ok: true; payload: LicensePayload; kid: string } | { ok: false; reason: "format" | "unknown_key" | "dev_key_in_production" | "signature" | "payload" };

/** Reads and verifies a licence file. `production` refuses the development key. */
export function parseLicense(text: string, opts: { production: boolean }): ParsedLicense {
  let file: z.infer<typeof fileSchema>;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, reason: "format" };
    file = parsed.data;
  } catch {
    return { ok: false, reason: "format" };
  }
  const checked = verifySigned(file, opts.production);
  if (checked !== "ok") return { ok: false, reason: checked };
  try {
    const payload = licensePayloadSchema.safeParse(JSON.parse(Buffer.from(file.payload, "base64url").toString("utf8")));
    if (!payload.success) return { ok: false, reason: "payload" };
    return { ok: true, payload: payload.data, kid: file.kid };
  } catch {
    return { ok: false, reason: "payload" };
  }
}

/** Reasons the licensing service gives with `invalid` (licensing-online.md §5.1); others are shown as "rejected". */
export const LICENCE_REPLY_REASONS = ["not_found", "revoked", "expired", "bound_to_other_installation", "trial_used", "seats_exceeded_contract"] as const;

const replyFileSchema = z.object({
  format: z.literal("sitekeep-licence-reply"),
  version: z.literal(1),
  kid: z.string().min(1).max(40),
  payload: z.string().min(1).max(60_000),
  signature: z.string().min(1).max(200),
});

const replyPayloadSchema = z.object({
  status: z.enum(["valid", "unchanged", "invalid"]),
  reason: z.string().max(64).nullable().default(null),
  nonce: z.string().min(1).max(100),
  installation: z.string().min(1).max(100),
  serverTime: z.iso.datetime().optional(),
  licence: fileSchema.nullable().default(null),
});

export type LicenceReply =
  /** `notice`: information next to a valid licence (`seats_exceeded_contract`). */
  | { ok: true; status: "valid"; licence: string; notice: string | null; serverTime: string | null }
  | { ok: true; status: "unchanged"; serverTime: string | null }
  | { ok: true; status: "invalid"; reason: string; serverTime: string | null }
  /** Not a trustworthy answer: treated as "unreachable", the stored licence stays. */
  | { ok: false; reason: "format" | "unknown_key" | "dev_key_in_production" | "signature" | "payload" | "mismatch" };

/**
 * Reads a reply of the licensing service (licensing-online.md §5.3). Signed like a licence file; it must
 * answer this request (`nonce`) for this installation, so a recorded reply cannot be replayed. A `valid`
 * reply carries the licence file as text (verified again when installed).
 */
export function parseLicenceReply(text: string, expect: { nonce: string; installation: string }, opts: { production: boolean }): LicenceReply {
  let file: z.infer<typeof replyFileSchema>;
  try {
    const parsed = replyFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, reason: "format" };
    file = parsed.data;
  } catch {
    return { ok: false, reason: "format" };
  }
  const checked = verifySigned(file, opts.production);
  if (checked !== "ok") return { ok: false, reason: checked };
  let payload: z.infer<typeof replyPayloadSchema>;
  try {
    const parsed = replyPayloadSchema.safeParse(JSON.parse(Buffer.from(file.payload, "base64url").toString("utf8")));
    if (!parsed.success) return { ok: false, reason: "payload" };
    payload = parsed.data;
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (payload.nonce !== expect.nonce || payload.installation !== expect.installation) return { ok: false, reason: "mismatch" };
  const serverTime = payload.serverTime ?? null;
  if (payload.status === "valid") {
    if (!payload.licence) return { ok: false, reason: "payload" };
    return { ok: true, status: "valid", licence: JSON.stringify(payload.licence), notice: payload.reason, serverTime };
  }
  if (payload.status === "unchanged") return { ok: true, status: "unchanged", serverTime };
  return { ok: true, status: "invalid", reason: payload.reason ?? "rejected", serverTime };
}
