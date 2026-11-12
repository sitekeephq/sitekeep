/**
 * Built-in dashboard templates are written with text tokens: `[[text.openIssues]]` stands for
 * `reports:templates.text.openIssues`, `[[issueStatus.name]]` for `reports:templates.issueStatus.name`.
 * A template is filled in the reader's language when the catalog is served (a dashboard created
 * from it is then saved in that language) and in PROMPT_LANGUAGE when it is the AI builder's example.
 */
import type { ReportTemplateDto } from "@sitekeep/shared";
import { tFor, type MsgKey } from "../i18n/index.js";

const TOKEN = /\[\[([A-Za-z0-9_.]+)\]\]/g;

/**
 * Tokens stand inside HTML text and inside double-quoted JavaScript strings: characters that would
 * break either are replaced by look-alikes (translations should not contain them anyway).
 */
const SAFE: Record<string, string> = { '"': "”", "\\": "/", "<": "‹", ">": "›", "&": "+", "`": "'" };

export function fillTokens(text: string, lang: string): string {
  const t = tFor(lang);
  return text.replace(TOKEN, (_, key: string) => t(`reports:templates.${key}` as MsgKey).replace(/["\\<>&`]/g, (c) => SAFE[c]!));
}

export function localizeTemplates(list: readonly ReportTemplateDto[], lang: string): ReportTemplateDto[] {
  return list.map((tpl) => ({
    ...tpl,
    name: fillTokens(tpl.name, lang),
    description: fillTokens(tpl.description, lang),
    html: fillTokens(tpl.html, lang),
  }));
}
