/**
 * Field's API contracts (form templates, form workflows, PDF field naming): validated by the forms
 * routes (Field module, through the SDK) and used by the AI features that draft them. They live in
 * the core like the DTOs in packages/shared, so the AI side does not depend on the module.
 */
import { z } from "zod";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import {
  FORM_ITEM_TYPES,
  TABLE_COLUMN_TYPES,
  checkNumberPattern,
  checkTemplateSchema,
  type FormTemplateSchema,
} from "@sitekeep/shared";

const idSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, "Kimlik yalnızca harf, rakam, - ve _ içerebilir (en fazla 40)."); // i18n-ok: zod issue detail (validation details stay untranslated)
const label = z.string().trim().min(1).max(500);
const options = z.array(z.string().trim().min(1).max(200)).max(100);

export const columnSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(200),
  type: z.enum(TABLE_COLUMN_TYPES),
  unit: z.string().trim().max(20).optional(),
  options: options.optional(),
  required: z.boolean().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});

const coord = z.number().finite().min(-10).max(20000);
const size = z.number().finite().min(0).max(20000);

/** Where an item sits on the template's source PDF (points, top-left origin, 1-based page). */
export const pdfPlacementSchema = z.object({
  page: z.number().int().min(1).max(500),
  x: coord,
  y: coord,
  w: size,
  h: size,
  acroField: z.string().max(300).optional(),
  marks: z
    .array(
      z.object({
        value: z.string().max(200),
        x: coord,
        y: coord,
        w: size,
        h: size,
        acroField: z.string().max(300).optional(),
        acroValue: z.string().max(200).optional(),
      }),
    )
    .max(50)
    .optional(),
  rows: z.number().int().min(0).max(200).optional(),
  colX: z.array(coord).max(21).optional(),
  headerH: size.optional(),
});

export const itemSchema = z.object({
  id: idSchema,
  type: z.enum(FORM_ITEM_TYPES),
  label,
  help: z.string().trim().max(1000).optional(),
  required: z.boolean().optional(),
  allowNa: z.boolean().optional(),
  multiline: z.boolean().optional(),
  unit: z.string().trim().max(20).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  options: options.optional(),
  failOptions: options.optional(),
  maxPhotos: z.number().int().min(1).max(50).optional(),
  columns: z.array(columnSchema).max(20).optional(),
  maxRows: z.number().int().min(1).max(500).optional(),
  scoreOf: z.array(idSchema).max(500).optional(),
  pdf: pdfPlacementSchema.optional(),
});

export const sectionSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  items: z.array(itemSchema).max(300),
});

/** Template body; structural rules (unique ids, options, ranges) are checked with checkTemplateSchema. */
export const templateSchemaSchema = z
  .object({ sections: z.array(sectionSchema).min(1).max(50) })
  .superRefine((s, ctx) => {
    for (const p of checkTemplateSchema(s as FormTemplateSchema, DEFAULT_LANGUAGE)) ctx.addIssue({ code: "custom", message: p });
  });

export const numberPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .superRefine((p, ctx) => {
    for (const m of checkNumberPattern(p, DEFAULT_LANGUAGE)) ctx.addIssue({ code: "custom", message: m });
  });

export const templateCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[\p{Lu}\p{N}_-]+$/u, "Kod büyük harf, rakam, - ve _ içerebilir (ör. BDK)."); // i18n-ok: zod issue detail (validation details stay untranslated)

/** Fills missing / duplicate section, item and column ids (AI output, quick UI drafts). */
export function withIds(raw: unknown, opts: { renameDuplicates?: boolean } = {}): unknown {
  const rename = opts.renameDuplicates ?? true;
  if (!raw || typeof raw !== "object") return raw;
  const t = raw as { sections?: unknown };
  if (!Array.isArray(t.sections)) return raw;
  const used = new Set<string>();
  const ok = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) && (!rename || !used.has(v));
  const take = (v: unknown, fallback: string) => {
    if (ok(v)) {
      used.add(v as string);
      return v as string;
    }
    let idv = fallback;
    let n = 2;
    while (used.has(idv)) idv = `${fallback}_${n++}`;
    used.add(idv);
    return idv;
  };
  return {
    ...t,
    sections: t.sections.map((s: unknown, si: number) => {
      if (!s || typeof s !== "object") return s;
      const sec = s as { id?: unknown; items?: unknown };
      return {
        ...sec,
        id: take(sec.id, `b${si + 1}`),
        items: Array.isArray(sec.items)
          ? sec.items.map((it: unknown, ii: number) => {
              if (!it || typeof it !== "object") return it;
              const item = it as { id?: unknown; columns?: unknown };
              const out: Record<string, unknown> = { ...item, id: take(item.id, `m${si + 1}_${ii + 1}`) };
              if (Array.isArray(item.columns)) {
                const cols = new Set<string>();
                out.columns = item.columns.map((c: unknown, ci: number) => {
                  if (!c || typeof c !== "object") return c;
                  const col = c as { id?: unknown };
                  let cid = typeof col.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(col.id) && !cols.has(col.id) ? col.id : `s${ci + 1}`;
                  while (cols.has(cid)) cid = `${cid}_`;
                  cols.add(cid);
                  return { ...col, id: cid };
                });
              }
              return out;
            })
          : sec.items,
      };
    }),
  };
}

// ---- Template input (API) -------------------------------------------------------------------

const schemaInput = z.preprocess((v) => withIds(v, { renameDuplicates: false }), templateSchemaSchema);

export const formTemplateInput = z.object({
  code: templateCodeSchema,
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  numberPattern: numberPatternSchema.optional(),
  workflowTemplateId: z.string().uuid().nullable().optional(),
  schema: schemaInput,
  /** Source PDF (PDF templates); undefined keeps the current one on update. */
  sourceId: z.string().uuid().nullable().optional(),
});

// ---- AI output: form workflow draft --------------------------------------------------------------

const nameList = z.preprocess((v) => (typeof v === "string" ? (v.trim() ? [v] : []) : v ?? []), z.array(z.string().trim().min(1).max(120)).max(20));
const whoSchema = z.union([
  z.string().trim().max(120),
  z.array(z.string().trim().max(120)).max(10),
  z.object({ attribute: z.string().trim().min(1).max(100), map: z.record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(120)) }),
]);

export const flowOutputSchema = z.object({
  name: z.string().trim().max(200).optional(),
  filler: nameList.optional(),
  steps: z
    .array(
      z.object({
        who: whoSchema,
        action: z.string().trim().max(40).optional(),
        name: z.string().trim().max(120).optional(),
        outcomes: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
        onReject: z.union([z.string().trim().max(40), z.number().int(), z.null()]).optional(),
        days: z.coerce.number().int().min(0).max(365).optional(),
        fields: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
      }),
    )
    .min(1)
    .max(12),
  notifyOnApproved: nameList.optional(),
  notifyOnReturned: nameList.optional(),
  days: z.coerce.number().int().min(0).max(365).optional(),
});

// ---- AI output: PDF field naming ---------------------------------------------------------------

export const namingOutputSchema = z.object({
  name: z.string().trim().max(200).optional(),
  fields: z
    .array(
      z.object({
        n: z.coerce.number().int().min(1),
        label: z.string().trim().min(1).max(200),
        type: z.enum(FORM_ITEM_TYPES).optional(),
        section: z.string().trim().max(120).optional(),
        columns: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
      }),
    )
    .min(1),
});
