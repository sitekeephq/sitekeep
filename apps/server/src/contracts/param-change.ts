/**
 * Coordinate's parameter change contracts: the element query and the values to set, validated by
 * the parameter change routes (Coordinate module, through the SDK) and answered by the AI feature
 * that drafts a change. They live in the core so the AI side does not depend on the module.
 */
import { z } from "zod";
import { PARAM_VALUE_TYPES, type ModelQuery } from "@sitekeep/shared";
import { modelQuerySchema } from "../model/query.js";

const scalar = z.union([z.string().trim().min(1).max(500), z.number().finite(), z.boolean()]);

export const setRuleSchema = z
  .object({
    pset: z.string().trim().min(1).max(120).optional(),
    property: z.string().trim().min(1).max(120),
    value: scalar,
    valueType: z.enum(PARAM_VALUE_TYPES).optional(),
  })
  .strict();

/** Query part used to pick elements (no grouping, sums or comparison). */
export const paramQuerySchema = modelQuerySchema.transform((q) => {
  const { groupBy: _g, aggregate: _a, change: _c, limit: _l, ...rest } = q;
  return rest as ModelQuery;
});

export const setListSchema = z.preprocess((v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : v), z.array(setRuleSchema).min(1).max(10));

/** The answer the model (or a connected AI client over the task queue) must give. */
export const paramPlanSchema = z.object({
  query: paramQuerySchema,
  set: setListSchema,
});
