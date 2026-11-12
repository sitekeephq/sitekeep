/**
 * System settings every installation has (Yönetim): the API token and MCP policy
 * ("integrations.mcp": who may create tokens, write tokens, lifetime) and the read-only AI state.
 * The AI module changes the AI part (PUT /admin/settings/ai, providers) and answers with the same DTO.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { audit } from "../core/platform/audit.js";
import { forbidden } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { killSwitchOn } from "../privacy/settings.js";
import {
  getAiMode,
  getAiTaskQueueSettings,
  getDefaultProviderId,
  getMcpSettings,
  getProviders,
  getStoredAiMode,
  putSetting,
  toProviderDto,
} from "../ai/settings.js";

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("ai:errors.adminOnly"));
}

/** GET /admin/settings: the token / MCP policy and the AI state. */
export async function adminSettingsDto(db: Db) {
  const [mcp, mode, storedMode, providers, defaultProviderId, taskQueue] = await Promise.all([
    getMcpSettings(db),
    getAiMode(db),
    getStoredAiMode(db),
    getProviders(db),
    getDefaultProviderId(db),
    getAiTaskQueueSettings(db),
  ]);
  // killSwitch: "Tüm Dış Bağlantıları Kapat" (Gizlilik Merkezi) forces local_only and turns the queue off.
  return { mcp, ai: { mode, storedMode, killSwitch: killSwitchOn(), defaultProviderId, providers: providers.map(toProviderDto), taskQueue } };
}

export async function adminSettingsRoutes(api: FastifyInstance, db: Db) {
  api.get("/admin/settings", async (req) => {
    requireAdmin(req);
    return adminSettingsDto(db);
  });

  api.put("/admin/settings/mcp", async (req) => {
    requireAdmin(req);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        allowWriteTokens: z.boolean().optional(),
        tokenCreators: z.enum(["everyone", "project_admins", "admins"]).optional(),
        maxTokenDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body);
    const next = { ...(await getMcpSettings(db)), ...stripUndefined(body) };
    await putSetting(db, "integrations.mcp", next, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "settings.mcp_updated", details: next });
    return adminSettingsDto(db);
  });
}
