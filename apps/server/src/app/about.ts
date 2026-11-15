/**
 * What the About page shows: the version this installation runs, where
 * its source is (AGPL-3.0 §13) and the third-party notices. Public: the login page links to it too.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { sourceCodeUrl } from "@sitekeep/shared";
import { HttpError } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
/** Where the image keeps THIRD_PARTY_NOTICES.md, LICENSE and LIBREDWG-COPYING (Dockerfile). */
export const LEGAL_DIR = "/usr/share/sitekeep";

/** The version this build was made as (SITEKEEP_VERSION, set by the release build); null for any other build. */
export function appVersion(env: string | undefined = process.env.SITEKEEP_VERSION): string | null {
  const v = env?.trim();
  return v ? v.replace(/^v(?=\d)/, "") : null;
}

/** Version and source link of GET /api/v1/app-info. */
export function sourceInfo(env: string | undefined = process.env.SITEKEEP_VERSION): { version: string | null; sourceUrl: string } {
  const version = appVersion(env);
  return { version, sourceUrl: sourceCodeUrl(version) };
}

/**
 * THIRD_PARTY_NOTICES.md: SITEKEEP_NOTICES_FILE, else the repository root above this file (development),
 * else the image's /usr/share/sitekeep.
 */
export function noticesPath(env: string | undefined = process.env.SITEKEEP_NOTICES_FILE): string | null {
  if (env) return existsSync(env) ? env : null;
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    const f = path.join(dir, NOTICES_FILE);
    if (existsSync(f)) return f;
    if (path.dirname(dir) === dir) break;
  }
  const image = path.join(LEGAL_DIR, NOTICES_FILE);
  return existsSync(image) ? image : null;
}

export async function aboutRoutes(api: FastifyInstance): Promise<void> {
  let cached: string | null = null;
  api.get("/legal/notices", { config: { public: true } }, async (_req, reply) => {
    if (cached === null) {
      const file = noticesPath();
      if (!file) throw new HttpError(404, "not_found", msg("errors:routeNotFound"));
      cached = readFileSync(file, "utf8");
    }
    return reply.type("text/markdown; charset=utf-8").header("cache-control", "public, max-age=3600").send(cached);
  });
}
