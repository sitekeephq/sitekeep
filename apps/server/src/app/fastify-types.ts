/**
 * Request properties the core adds to Fastify (the signed-in user; multipart and cookies from the
 * plugins build-app.ts registers). Imported by the SDK so module routes see the same types.
 */
import "@fastify/cookie";
import "@fastify/multipart";
import type { AuthUser } from "../core/security/access.js";
import "../privacy/headers.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}
