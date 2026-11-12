import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countTemplate,
  dimensionDtos,
  expandProjectTemplate,
  type ProjectTemplate,
  type TemplateSummaryDto,
} from "@sitekeep/shared";
import { badRequest, notFound } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { parseProjectTemplate } from "./template-schemas.js";

const builtInDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");
let builtInCache: Map<string, ProjectTemplate> | null = null;

/** Built-in templates by id (file name without .json), read once. */
export function builtInTemplates(): Map<string, ProjectTemplate> {
  if (builtInCache) return builtInCache;
  const out = new Map<string, ProjectTemplate>();
  let names: string[] = [];
  try {
    names = readdirSync(builtInDir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  for (const file of names) {
    const raw = JSON.parse(readFileSync(path.join(builtInDir, file), "utf8")) as unknown;
    out.set(file.slice(0, -5), parseProjectTemplate(raw));
  }
  builtInCache = out;
  return out;
}

export function templateSummaries(): TemplateSummaryDto[] {
  return [...builtInTemplates()].map(([id, t]) => {
    const { folders } = expandProjectTemplate(t);
    return {
      id,
      name: t.name,
      description: t.description ?? "",
      builtIn: true,
      slots: t.slots,
      dimensions: dimensionDtos(t.dimensions ?? {}),
      counts: countTemplate(t, folders),
    };
  });
}

export function templateFromRequest(req: {
  templateId?: string;
  template?: unknown;
}): { template: ProjectTemplate; templateId: string | null } {
  if (req.template !== undefined && req.template !== null) return { template: parseProjectTemplate(req.template), templateId: null };
  if (!req.templateId) throw badRequest(msg("projects:errors.templateRequired"));
  const template = builtInTemplates().get(req.templateId);
  if (!template) throw notFound(msg("projects:entities.template"));
  return { template, templateId: req.templateId };
}
