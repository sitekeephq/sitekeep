/**
 * English is the source language: bundled with the app (no flash, no request) and the shape every
 * other language follows. Its JSON files also give the `t()` keys their types (i18next.d.ts).
 * Other languages are loaded on demand (index.ts).
 *
 * One namespace per area of the app; a new area adds its file here and to NAMESPACES.
 */
import admin from "./locales/en/admin.json";
import ai from "./locales/en/ai.json";
import auth from "./locales/en/auth.json";
import common from "./locales/en/common.json";
import coordination from "./locales/en/coordination.json";
import documents from "./locales/en/documents.json";
import forms from "./locales/en/forms.json";
import integrations from "./locales/en/integrations.json";
// Enum labels live in the shared package: the server renders them too (Excel, e-mails).
import labels from "../../../../packages/shared/src/locales/en/labels.json";
import onboarding from "./locales/en/onboarding.json";
import projectSettings from "./locales/en/projectSettings.json";
import projects from "./locales/en/projects.json";
import reports from "./locales/en/reports.json";
import reviews from "./locales/en/reviews.json";
import schedule from "./locales/en/schedule.json";
import shell from "./locales/en/shell.json";
import sim from "./locales/en/sim.json";
import viewers from "./locales/en/viewers.json";
import works from "./locales/en/works.json";

export const en = {
  admin,
  ai,
  auth,
  common,
  coordination,
  documents,
  forms,
  integrations,
  labels,
  onboarding,
  projectSettings,
  projects,
  reports,
  reviews,
  schedule,
  shell,
  sim,
  viewers,
  works,
};

export type Namespace = keyof typeof en;
export const NAMESPACES = Object.keys(en) as Namespace[];
export const DEFAULT_NAMESPACE: Namespace = "common";
