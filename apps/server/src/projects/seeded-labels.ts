/**
 * Startup upgrade of default labels that project templates wrote into project data. Built-in work
 * types upgrade themselves on first use (works/service.ts ensureBuiltInTypes); this covers the
 * folder sub-status labels ("İş sonu" → "İş Sonu") templates seeded before labels became Title
 * Case. A label is upgraded only while it is the earlier default: the same words as a current
 * suggestion in other letter case. Anything else the admin typed stays. Idempotent.
 */
import { eq, isNotNull } from "drizzle-orm";
import { STATE_LABEL_SUGGESTIONS_TR, titleCaseTr } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { folders } from "../db/schema.js";

/** Earlier default label → current label, for every suggestion that changed. */
export function folderStateLabelUpgrades(stored: readonly string[]): Map<string, string> {
  const current = new Set(STATE_LABEL_SUGGESTIONS_TR.map((s) => s.label));
  const out = new Map<string, string>();
  for (const v of stored) {
    const tc = titleCaseTr(v);
    if (v !== tc && current.has(tc)) out.set(v, tc);
  }
  return out;
}

/** Upgrades folder sub-status labels; returns the number of folders changed. */
export async function upgradeSeededLabels(db: Db): Promise<number> {
  const rows = await db.selectDistinct({ label: folders.stateLabel }).from(folders).where(isNotNull(folders.stateLabel));
  const upgrades = folderStateLabelUpgrades(rows.map((r) => r.label!));
  let changed = 0;
  for (const [from, to] of upgrades) {
    const res = await db
      .update(folders)
      .set({ stateLabel: to })
      .where(eq(folders.stateLabel, from))
      .returning({ id: folders.id });
    changed += res.length;
  }
  return changed;
}
