import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countTemplate,
  dimensionDtos,
  expandProjectTemplate,
  localizeTemplate,
  templatePartsOf,
  type ProjectTemplate,
  type TemplateSummaryDto,
} from "@sitekeep/shared";
import { badRequest, notFound } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg } from "../i18n/index.js";
import { parseProjectTemplate } from "./template-schemas.js";

const builtInDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");
let rawCache: Map<string, unknown> | null = null;
const parsedCache = new Map<string, Map<string, ProjectTemplate>>();

/** Built-in template files by id (file name without .json), read once, per-language values unresolved. */
function rawBuiltIns(): Map<string, unknown> {
  if (rawCache) return rawCache;
  const out = new Map<string, unknown>();
  let names: string[] = [];
  try {
    names = readdirSync(builtInDir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  for (const file of names) out.set(file.slice(0, -5), JSON.parse(readFileSync(path.join(builtInDir, file), "utf8")) as unknown);
  rawCache = out;
  return out;
}

/** A template JSON with its per-language values resolved for `lang`, validated. */
export function parseLocalizedTemplate(raw: unknown, lang: string): ProjectTemplate {
  return parseProjectTemplate(localizeTemplate(raw, lang));
}

/** Built-in templates by id, with their per-language values in `lang` (default: the server's language). */
export function builtInTemplates(lang: string = DEFAULT_LANGUAGE): Map<string, ProjectTemplate> {
  const cached = parsedCache.get(lang);
  if (cached) return cached;
  const out = new Map<string, ProjectTemplate>();
  for (const [id, raw] of rawBuiltIns()) out.set(id, parseLocalizedTemplate(raw, lang));
  parsedCache.set(lang, out);
  return out;
}

export function templateSummaries(lang: string = DEFAULT_LANGUAGE): TemplateSummaryDto[] {
  return [...builtInTemplates(lang)].map(([id, t]) => {
    const { folders } = expandProjectTemplate(t);
    return {
      id,
      name: t.name,
      description: t.description ?? "",
      ...(t.language ? { language: t.language } : {}),
      ...(t.family ? { family: t.family } : {}),
      parts: templatePartsOf(t),
      builtIn: true,
      slots: t.slots,
      dimensions: dimensionDtos(t.dimensions ?? {}),
      counts: countTemplate(t, folders),
    };
  });
}

/** The template of a request (built-in id or JSON), per-language values in `lang`. */
export function templateFromRequest(
  req: { templateId?: string; template?: unknown },
  lang: string = DEFAULT_LANGUAGE,
): { template: ProjectTemplate; templateId: string | null } {
  if (req.template !== undefined && req.template !== null) return { template: parseLocalizedTemplate(req.template, lang), templateId: null };
  if (!req.templateId) throw badRequest(msg("projects:errors.templateRequired"));
  const template = builtInTemplates(lang).get(req.templateId);
  if (!template) throw notFound(msg("projects:entities.template"));
  return { template, templateId: req.templateId };
}
