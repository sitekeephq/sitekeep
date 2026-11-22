/**
 * GET /.well-known/security.txt (RFC 9116): where to report a vulnerability in SiteKeep (SECURITY.md;
 * Cyber Resilience Act Annex I Part II: a contact address for vulnerability reports).
 *
 * Expires is computed when served: today (UTC midnight) plus one year minus one day, so the file
 * never goes stale on a running installation and stays below the one year RFC 9116 §2.5.5
 * recommends. Canonical is given only with CDE_PUBLIC_URL (a Host header can be anything).
 */
import type { FastifyInstance } from "fastify";
import type { ResolvedDeps } from "../app/deps.js";

export const SECURITY_CONTACT_EMAIL = "support@sitekeep.org";
export const SECURITY_POLICY_URL = "https://github.com/sitekeephq/sitekeep/blob/main/SECURITY.md";
export const SECURITY_ADVISORY_URL = "https://github.com/sitekeephq/sitekeep/security/advisories/new";

/** Midnight UTC of `now`, plus one year, minus one day. */
export function securityTxtExpiry(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export function securityTxt(opts: { now?: Date; publicUrl?: string | null } = {}): string {
  const lines = [
    "# Security contact of the SiteKeep software (vulnerabilities in SiteKeep itself).",
    "# Problems with this installation's operation or data: contact the organisation that runs it.",
    `Contact: mailto:${SECURITY_CONTACT_EMAIL}`,
    `Contact: ${SECURITY_ADVISORY_URL}`,
    `Expires: ${securityTxtExpiry(opts.now).toISOString()}`,
    `Policy: ${SECURITY_POLICY_URL}`,
    "Preferred-Languages: en, tr",
  ];
  if (opts.publicUrl) lines.push(`Canonical: ${opts.publicUrl.replace(/\/+$/, "")}/.well-known/security.txt`);
  return lines.join("\n") + "\n";
}

export async function securityTxtRoutes(app: FastifyInstance, deps: ResolvedDeps) {
  app.get("/.well-known/security.txt", async (_req, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .header("cache-control", "public, max-age=86400")
      .send(securityTxt({ publicUrl: deps.oauth.publicUrl })),
  );
}
