/**
 * Office integration settings (editor and office → PDF converter).
 *   GET    /admin/office                         settings + effective status (administrators)
 *   PUT    /admin/office                         save settings (secrets encrypted at rest)
 *   POST   /admin/office/test                    "Bağlantıyı test et"
 *   GET    /wopi/convert/:ticket/:name           conversion source for ONLYOFFICE (one-time ticket; outside /api/v1)
 * Editing files in the browser (WOPI host, editor sessions, locks) is the Connect module's
 * (docs/modules/connect.md); conversion settings stay here because previews use them.
 */
import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { OFFICE_CONVERTER_KINDS, OFFICE_EDITOR_KINDS } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { putSetting } from "../ai/settings.js";
import { audit } from "../core/platform/audit.js";
import { forbidden } from "../core/platform/http.js";
import { encryptSecret } from "../core/platform/secrets.js";
import {
  OFFICE_SETTINGS_KEY,
  TOKEN_TTL_MAX_MINUTES,
  getStoredOfficeSettings,
  toOfficeSettingsDto,
  type StoredOfficeSettings,
} from "../office/settings.js";
import { DEFAULT_LANGUAGE, msg, render, requestLanguage } from "../i18n/index.js";

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("office:errors.adminOnly"));
}

const url = z
  .string()
  .trim()
  .max(500)
  .transform((u) => u.replace(/\/+$/, ""))
  .refine((u) => u === "" || /^https?:\/\/[^\s/?#]+[^\s?#]*$/i.test(u), render(DEFAULT_LANGUAGE, msg("office:errors.urlScheme")))
  .transform((u) => u || null)
  .nullable();

const settingsBody = z.object({
  editor: z
    .object({
      kind: z.enum(OFFICE_EDITOR_KINDS as [string, ...string[]]).optional(),
      url: url.optional(),
      publicUrl: url.optional(),
      verifyProof: z.boolean().optional(),
    })
    .optional(),
  converter: z
    .object({
      kind: z.enum(OFFICE_CONVERTER_KINDS as [string, ...string[]]).optional(),
      url: url.optional(),
      timeoutSec: z.number().int().min(5).max(3600).optional(),
      maxFileMb: z.number().int().min(1).max(2048).optional(),
      concurrency: z.number().int().min(1).max(8).optional(),
      retries: z.number().int().min(0).max(5).optional(),
    })
    .optional(),
  wopiBaseUrl: url.optional(),
  tokenTtlMinutes: z.number().int().min(15).max(TOKEN_TTL_MAX_MINUTES).optional(),
  jwtSecret: z.string().max(500).nullable().optional(),
  gotenbergAuth: z
    .string()
    .max(500)
    .refine((v) => v === "" || v.includes(":"), render(DEFAULT_LANGUAGE, msg("office:errors.basicAuthFormat")))
    .nullable()
    .optional(),
});

const strip = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function officeRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, office, secretKey } = deps;

  async function adminDto(lang: string) {
    const cfg = await office.config();
    return { settings: toOfficeSettingsDto(cfg), status: await office.status(lang) };
  }

  api.get("/admin/office", async (req) => {
    requireAdmin(req);
    return adminDto(requestLanguage(req));
  });

  api.put("/admin/office", async (req) => {
    requireAdmin(req);
    const body = settingsBody.parse(req.body);
    const cur = await getStoredOfficeSettings(db);
    const next: StoredOfficeSettings = {
      ...cur,
      editor: { ...cur.editor, ...strip(body.editor ?? {}) } as StoredOfficeSettings["editor"],
      converter: { ...cur.converter, ...strip(body.converter ?? {}) } as StoredOfficeSettings["converter"],
      ...(body.wopiBaseUrl !== undefined && { wopiBaseUrl: body.wopiBaseUrl }),
      ...(body.tokenTtlMinutes !== undefined && { tokenTtlMinutes: body.tokenTtlMinutes }),
    };
    if (body.jwtSecret !== undefined) next.jwtSecretEnc = body.jwtSecret ? encryptSecret(secretKey, body.jwtSecret) : null;
    if (body.gotenbergAuth !== undefined)
      next.gotenbergAuthEnc = body.gotenbergAuth ? encryptSecret(secretKey, body.gotenbergAuth) : null;
    await putSetting(db, OFFICE_SETTINGS_KEY, next, req.user!.id);
    office.resetDiscovery();
    await audit(db, {
      userId: req.user!.id,
      action: "settings.office_updated",
      details: {
        ...body,
        jwtSecret: body.jwtSecret === undefined ? undefined : body.jwtSecret ? "***" : null,
        gotenbergAuth: body.gotenbergAuth === undefined ? undefined : body.gotenbergAuth ? "***" : null,
      },
    });
    return adminDto(requestLanguage(req));
  });

  api.post("/admin/office/test", async (req) => {
    requireAdmin(req);
    const r = await office.test(requestLanguage(req));
    await audit(db, { userId: req.user!.id, action: "settings.office_tested", details: { ok: r.ok, steps: r.steps.map((s) => [s.name, s.ok]) } });
    return r;
  });
}

/**
 * The conversion source an ONLYOFFICE document server downloads (office → PDF previews). The core
 * converts with or without the Connect module, so the core serves it; the one-time ticket is the
 * only credential (OfficeIntegration.publishSource).
 */
export async function officeSourceRoutes(app: FastifyInstance, deps: ResolvedDeps) {
  app.get<{ Params: { ticket: string; name: string } }>("/wopi/convert/:ticket/:name", async (req, reply) => {
    const src = deps.office.takeSource(req.params.ticket);
    if (!src) return reply.status(404).send();
    reply.header("Content-Type", "application/octet-stream");
    return reply.send(createReadStream(src.path));
  });
}
