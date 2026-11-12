/**
 * "+ Yeni": from the sentence the user typed to a record type, a title and a company.
 *
 * Phase 1 (now): keyword rules in packages/shared/src/intent.ts, instant and offline.
 * Phase 2 hook: replace the body of `draftFromSentence` with a call to the project's AI draft
 * endpoint (e.g. POST /projects/:pid/ai/new-record {text}) that returns the same NewRecordGuess
 * plus field values; fall back to the keyword guess when the AI is off or slow. The dialog only
 * calls this function, so it does not change.
 */
import { guessNewRecord, type IntentCompany, type NewRecordGuess } from "@sitekeep/shared";

export interface DraftContext {
  projectId: string;
  companies: IntentCompany[];
}

/** Instant keyword guess (used while typing). */
export function quickGuess(text: string, ctx: DraftContext): NewRecordGuess {
  return guessNewRecord(text, ctx.companies);
}

/** Guess used when the user presses "Devam" / Enter. Phase 2: AI draft here. */
export async function draftFromSentence(text: string, ctx: DraftContext): Promise<NewRecordGuess> {
  return quickGuess(text, ctx);
}
