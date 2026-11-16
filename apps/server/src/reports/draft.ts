/**
 * The JSON shape of a report dashboard draft ({name, description, queries, html}) that a model or an
 * external MCP client produces. The report builder itself (validation against the datasets, the AI
 * builder, saved dashboards) is the Platform module's (docs/modules/platform.md); the schema stays
 * here because the AI module's feature catalog validates task answers against it (SDK).
 */
import { z } from "zod";
import { normalizeQueryRefs, queryRefsSchema } from "./spec.js";

const queriesInput = z.preprocess(normalizeQueryRefs, queryRefsSchema);

/** The JSON object a model (or an external MCP client) must produce for a dashboard. */
export const reportDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  queries: queriesInput,
  html: z.string().min(1, "html boş olamaz"), // i18n-ok: fed back to the model
});
