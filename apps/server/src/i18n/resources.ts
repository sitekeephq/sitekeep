/**
 * The server's namespaces: one per source folder (src/<folder> → "<folder>", camelCase), plus
 * "errors" for the generic ones (core, app). English files give the keys their types; the texts
 * themselves are read from locales/<lang>/ at start-up (index.ts), so a new language is a folder.
 */
import type access from "./locales/en/access.json";
import type admin from "./locales/en/admin.json";
import type ai from "./locales/en/ai.json";
import type auth from "./locales/en/auth.json";
import type bcf from "./locales/en/bcf.json";
import type coordination from "./locales/en/coordination.json";
import type doccompare from "./locales/en/doccompare.json";
import type docintel from "./locales/en/docintel.json";
import type documents from "./locales/en/documents.json";
import type errors from "./locales/en/errors.json";
import type files from "./locales/en/files.json";
import type forms from "./locales/en/forms.json";
import type integrations from "./locales/en/integrations.json";
import type jobs from "./locales/en/jobs.json";
import type locations from "./locales/en/locations.json";
import type model from "./locales/en/model.json";
import type oauth from "./locales/en/oauth.json";
import type office from "./locales/en/office.json";
import type opencde from "./locales/en/opencde.json";
import type paramChange from "./locales/en/paramChange.json";
import type previews from "./locales/en/previews.json";
import type privacy from "./locales/en/privacy.json";
import type projects from "./locales/en/projects.json";
import type reports from "./locales/en/reports.json";
import type schedule from "./locales/en/schedule.json";
import type sim from "./locales/en/sim.json";
import type templates from "./locales/en/templates.json";
import type today from "./locales/en/today.json";
import type workflow from "./locales/en/workflow.json";
import type works from "./locales/en/works.json";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace SiteKeep {
    /**
     * Namespaces a module brings (ServerModule.locales), added by the module's own declaration:
     * `declare global { namespace SiteKeep { interface ServerResources { contracts: typeof contracts } } }`.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ServerResources {}
  }
}

/** The core's namespaces. */
export interface CoreServerResources {
  access: typeof access;
  admin: typeof admin;
  ai: typeof ai;
  auth: typeof auth;
  bcf: typeof bcf;
  coordination: typeof coordination;
  doccompare: typeof doccompare;
  docintel: typeof docintel;
  documents: typeof documents;
  errors: typeof errors;
  files: typeof files;
  forms: typeof forms;
  integrations: typeof integrations;
  jobs: typeof jobs;
  locations: typeof locations;
  model: typeof model;
  oauth: typeof oauth;
  office: typeof office;
  opencde: typeof opencde;
  paramChange: typeof paramChange;
  previews: typeof previews;
  privacy: typeof privacy;
  projects: typeof projects;
  reports: typeof reports;
  schedule: typeof schedule;
  sim: typeof sim;
  templates: typeof templates;
  today: typeof today;
  workflow: typeof workflow;
  works: typeof works;
}

/** The core's and the installed modules' namespaces (keys of msg()). */
export type ServerResources = CoreServerResources & SiteKeep.ServerResources;
export type ServerNamespace = keyof ServerResources;
export const DEFAULT_NAMESPACE: keyof CoreServerResources = "errors";
