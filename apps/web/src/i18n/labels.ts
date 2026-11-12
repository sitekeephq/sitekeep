/**
 * Labels of the shared enums (issue status, folder state, permission level …). The Turkish text
 * stays where it always was, in @sitekeep/shared (`*_LABELS_TR`, also used by the server for
 * reports and e-mails); this file turns those tables into the Turkish "labels" namespace. Other
 * languages translate locales/<code>/labels.json like any namespace.
 *
 * In components: `const label = useLabel(); label("issueStatus", issue.status)`.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as shared from "@sitekeep/shared";
import type en from "../../../../packages/shared/src/locales/en/labels.json";
import { i18n } from "./instance";

/** The shared package's tables and the installed modules' (`SiteKeep.LabelTables`, from their locales/shared/en/labels.json). */
export type LabelTable = keyof typeof en | keyof SiteKeep.LabelTables;

/** The Turkish "labels" namespace: every `*_LABELS_TR` table of @sitekeep/shared. */
export function turkishLabels(): Record<string, unknown> {
  return shared.turkishLabelTables();
}

function lookup(t: (key: string, options?: { defaultValue?: string; nsSeparator?: false }) => string, table: LabelTable, key: string): string {
  return t(`${table}.${key}`, { defaultValue: key, nsSeparator: false });
}

/** Hook form: re-renders on a language change. Unknown keys show the key itself. */
export function useLabel() {
  const { t } = useTranslation("labels");
  return useCallback((table: LabelTable, key: string) => lookup(t as never, table, key), [t]);
}

/** Outside React (option lists built in plain functions). Reads the current language at call time. */
export function label(table: LabelTable, key: string): string {
  return lookup(i18n.getFixedT(null, "labels") as never, table, key);
}

/** Every key of a table with its label, in the table's order (selects, filters). */
export function labelEntries(table: LabelTable): [key: string, label: string][] {
  const keys = Object.keys((turkishLabels()[table] as Record<string, unknown> | undefined) ?? {});
  return keys.map((k) => [k, label(table, k)]);
}
