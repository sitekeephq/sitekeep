/**
 * Manage's API contracts that the AI features draft (meeting actions, RFI drafts, the record-from-file
 * AI pass): validated by Manage's routes (through the SDK) and by the AI module's feature catalogue.
 * They live in the core like contracts/forms.ts, so neither module depends on the other.
 */
import { z } from "zod";
import { INTAKE_KINDS } from "@sitekeep/shared";

/** "Toplantı tutanağından eylemler": the model's list of decisions and actions. */
export const actionsSchema = z.object({
  items: z
    .array(
      z.object({
        konu: z.string().trim().min(1).max(300),
        karar: z.string().trim().max(2000).nullish(),
        sorumlu: z.string().trim().max(200).nullish(),
        termin: z.string().trim().max(40).nullish(),
      }),
    )
    .max(60),
});

/** "RFI taslağı": title and field values. */
export const rfiSchema = z.object({
  title: z.string().trim().min(1).max(300),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

/** "Bırak, kaydet": the AI pass over a document's first page. */
export const intakeAiSchema = z.object({
  type: z.enum(INTAKE_KINDS).nullish(),
  title: z.string().trim().max(300).nullish(),
  sender: z.string().trim().max(200).nullish(),
  sayi: z.string().trim().max(120).nullish(),
  date: z.string().trim().max(40).nullish(),
  subject: z.string().trim().max(500).nullish(),
  references: z
    .array(z.object({ number: z.string().trim().min(1).max(120), date: z.string().trim().max(40).nullish() }))
    .max(20)
    .nullish(),
  dueDate: z.string().trim().max(40).nullish(),
  replyRequired: z.boolean().nullish(),
});
export type IntakeAiAnswer = z.infer<typeof intakeAiSchema>;
