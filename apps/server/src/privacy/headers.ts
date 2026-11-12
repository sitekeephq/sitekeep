/**
 * Security headers on every response (onSend hook).
 *
 * All responses:  X-Content-Type-Options nosniff, Referrer-Policy no-referrer, X-Frame-Options
 *                 SAMEORIGIN, Permissions-Policy (camera only for this site: form photos),
 *                 Cross-Origin-Opener-Policy same-origin-allow-popups (editor popups keep working),
 *                 Strict-Transport-Security when served over HTTPS.
 * HTML pages:     Content-Security-Policy (buildCsp) unless the route set its own (previews,
 *                 markup and compare reports carry stricter sandbox policies).
 *
 * JSON, files and workers get no CSP: the PDF viewer of the browser refuses documents with
 * object-src 'none', and worker scripts have their own policy. In development the Vite server
 * serves the pages (no CSP there); the proxied API answers carry only the common headers.
 *
 * OAuth (/oauth2/*, consent page /oauth/consent): no COOP, so clients that open the flow in a
 * popup keep window.opener. CORS headers of /foundation and /oauth2 are left as the routes set them.
 * TODO(opencde-auth): if a server-rendered consent form ever posts and then redirects to the
 * client's redirect_uri, add that origin to form-action for that response (Chrome enforces
 * form-action on redirects). The current consent page uses fetch + location.replace.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyReply {
    /** Nonce of the page's CSP (the SPA's index.html); the report iframe's scripts carry it. */
    cspNonce: string | null;
  }
}

export interface SecurityHeaderOptions {
  /** Origins of the browser office editor: frame-src, form-action and img-src (favicon). */
  editorOrigins(): Promise<string[]>;
  /** CDE_PUBLIC_URL: an https address turns HSTS on. */
  publicUrl?: string | null;
}

export const PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()";
export const HSTS = "max-age=15552000";

export function newCspNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Policy of the app's pages. Nothing loads from another site; the only exception is the configured
 * office editor (iframe, its form post and its favicon).
 *   scripts   own files; wasm (pdf.js decoders, web-ifc); the report iframe's inline scripts by nonce
 *             (an about:srcdoc frame inherits this policy; its own meta CSP narrows it further)
 *   styles    own files and inline (React style attributes, docx-preview and the pptx renderer)
 *   workers   own files (pdf.js, That Open fragments, diff and dxf workers) and blob:
 *   images    own, data: and blob: (canvas exports, thumbnails)
 */
export function buildCsp(o: { nonce?: string | null; editorOrigins?: string[] }): string {
  const ed = (o.editorOrigins ?? []).filter((x) => /^https?:\/\/[^\s;,']+$/.test(x));
  const extra = ed.length ? ` ${ed.join(" ")}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${o.nonce ? ` 'nonce-${o.nonce}'` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${extra}`,
    "font-src 'self' data:",
    "connect-src 'self' blob: data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `frame-src 'self' blob:${extra}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${extra}`,
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Served over HTTPS: CDE_PUBLIC_URL is https, the connection is TLS, or the proxy says so. */
function isHttps(req: FastifyRequest, publicUrl: string | null | undefined): boolean {
  if (publicUrl?.startsWith("https:")) return true;
  if (req.protocol === "https") return true;
  // Browsers ignore Strict-Transport-Security on plain HTTP, so trusting the header is harmless.
  const fwd = req.headers["x-forwarded-proto"];
  return String(Array.isArray(fwd) ? fwd[0] : (fwd ?? "")).split(",")[0]!.trim().toLowerCase() === "https";
}

const isOAuthPath = (url: string) => /^\/(oauth2|oauth)(\/|\?|$)/.test(url);

function setIfMissing(reply: FastifyReply, name: string, value: string) {
  if (!reply.hasHeader(name)) reply.header(name, value);
}

export function registerSecurityHeaders(app: FastifyInstance, opts: SecurityHeaderOptions): void {
  app.decorateReply("cspNonce", null);
  app.addHook("onSend", async (req, reply, payload) => {
    setIfMissing(reply, "x-content-type-options", "nosniff");
    setIfMissing(reply, "referrer-policy", "no-referrer");
    setIfMissing(reply, "x-frame-options", "SAMEORIGIN");
    setIfMissing(reply, "permissions-policy", PERMISSIONS_POLICY);
    if (!isOAuthPath(req.url)) setIfMissing(reply, "cross-origin-opener-policy", "same-origin-allow-popups");
    if (isHttps(req, opts.publicUrl)) setIfMissing(reply, "strict-transport-security", HSTS);
    const type = String(reply.getHeader("content-type") ?? "");
    if (/^text\/html/i.test(type) && !reply.hasHeader("content-security-policy")) {
      let origins: string[] = [];
      try {
        origins = await opts.editorOrigins();
      } catch {
        /* no editor settings: no exception in the policy */
      }
      reply.header("content-security-policy", buildCsp({ nonce: reply.cspNonce, editorOrigins: origins }));
    }
    return payload;
  });
}

/** index.html with the nonce on its script tags (the app reads it for the report iframe). */
export function withNonce(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}
