import { z } from "zod";
import {
  REPORT_BUCKETS,
  REPORT_FILTER_OPS,
  REPORT_HTML_MAX_BYTES,
  REPORT_MAX_QUERIES,
  REPORT_MAX_ROWS,
  REPORT_METRIC_OPS,
  byteLength,
  type ReportQueryRef,
  type ReportQuerySpec,
} from "@sitekeep/shared";

const fieldName = z.string().trim().min(1).max(120);
const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const filterSchema = z.object({
  field: fieldName,
  op: z.enum(REPORT_FILTER_OPS),
  value: z.union([scalar, z.array(scalar).max(500)]).optional(),
});

export const groupBySchema = z.union([
  fieldName,
  z.object({ field: fieldName, bucket: z.enum(REPORT_BUCKETS).optional() }),
]);

export const metricSchema = z.object({
  op: z.enum(REPORT_METRIC_OPS),
  field: fieldName.optional(),
  as: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,59}$/, "as: harf/rakam/alt çizgi") // i18n-ok: zod detail, fed back to the model on repair
    .optional(),
});

export const querySpecSchema = z
  .object({
    dataset: z.string().trim().min(1).max(60),
    filters: z.array(filterSchema).max(30).optional(),
    groupBy: z.array(groupBySchema).max(4).optional(),
    metrics: z.array(metricSchema).max(10).optional(),
    fields: z.array(fieldName).max(60).optional(),
    sort: z
      .array(z.object({ field: fieldName, dir: z.enum(["asc", "desc"]).optional() }))
      .max(5)
      .optional(),
    limit: z.number().int().min(1).max(REPORT_MAX_ROWS).optional(),
  })
  .strict();

export const queryIdSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, "Sorgu kimliği harf ile başlamalı; harf, rakam, alt çizgi (en çok 40)"); // i18n-ok: zod detail, fed back to the model on repair

export const queryRefSchema = z.object({ id: queryIdSchema, spec: querySpecSchema });

export const queryRefsSchema = z
  .array(queryRefSchema)
  .max(REPORT_MAX_QUERIES)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((q, i) => {
      if (seen.has(q.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `Sorgu kimliği tekrar ediyor: ${q.id}` }); // i18n-ok: zod detail, fed back to the model on repair
      seen.add(q.id);
    });
  });

export const htmlSchema = z
  .string()
  .refine((s) => byteLength(s) <= REPORT_HTML_MAX_BYTES, `HTML en fazla ${REPORT_HTML_MAX_BYTES / 1024} KB olabilir.`); // i18n-ok: zod detail, fed back to the model on repair

/** `{id, ...spec}` (the /query endpoint) → `{id, spec}`. */
export function flatToRef(q: Record<string, unknown>): { id: unknown; spec: Record<string, unknown> } {
  const { id, ...spec } = q;
  return { id, spec };
}

/** Accepts both `{id, spec}` and the flat `{id, dataset, …}` shape (models mix them up). */
export function normalizeQueryRefs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((q) =>
    q && typeof q === "object" && !("spec" in q) && "dataset" in q ? flatToRef(q as Record<string, unknown>) : q,
  );
}

export type { ReportQueryRef, ReportQuerySpec };

/** Readable one-line messages from a ZodError (fed back to the model on repair). */
export function zodMessages(err: z.ZodError, prefix = ""): string[] {
  return err.issues.map((i) => `${prefix}${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`);
}
