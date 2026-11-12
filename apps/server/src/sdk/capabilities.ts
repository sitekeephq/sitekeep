/**
 * Optional services one module offers another (docs/modules/README.md). A consumer asks for a
 * capability and must work without it: the provider may not be installed (Community, or a
 * licence without that module).
 */
import type { ActivityDto, FormStatus } from "@sitekeep/shared";
import type { ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import type { AuthUser } from "../core/security/access.js";
import type { AiProvider, AiProviderSelection, ProviderConfig } from "../ai/provider.js";
import { loadingModule } from "../app/module-owner.js";
import { moduleIds } from "../app/module-ids.js";

/** A programme as other modules see it (Planning); pass it back to the planning.schedules calls. */
export interface PlanningSchedule {
  id: string;
  seriesId: string;
  projectId: string;
  name: string;
  [more: string]: unknown;
}

/** A form as other parts of the app see it (Field). */
export interface FormSummary {
  id: string;
  projectId: string;
  number: string;
  /** Template name. */
  name: string;
  status: FormStatus;
  failedCount: number;
  createdBy: string;
  /** Fill round: > 1 after the form came back to its filler. */
  round: number;
  updatedAt: Date;
}

export interface Capabilities {
  /** Manage: is `workId` a work (iş) of `projectId`? */
  "manage.workExists": (db: Db, projectId: string, workId: string) => Promise<boolean>;
  /** Manage: number and title of works (labels next to linked records). */
  "manage.workLabels": (db: Db, workIds: string[]) => Promise<{ id: string; number: string; title: string }[]>;
  /** Field: forms for links, labels, counts and "Bugün". */
  "field.forms": {
    /** Forms of a project (all, or the given ids); without a project, the given ids anywhere. */
    list(db: Db, q: { projectId?: string; ids?: string[] }): Promise<FormSummary[]>;
    /** The user's drafts in a project, newest first. */
    drafts(db: Db, projectId: string, userId: string, limit: number): Promise<FormSummary[]>;
    link(projectId: string, formId: string): string;
  };
  /** Planning: programmes (İş Programı) and their 4D links, for 5D cost and labels. */
  "planning.schedules": {
    /** The given programme of the project, else its current one (null when it has none). */
    find(db: Db, projectId: string, scheduleId?: string | null): Promise<PlanningSchedule | null>;
    /** Exactly this programme of the project. */
    get(db: Db, projectId: string, scheduleId: string): Promise<PlanningSchedule | null>;
    activities(db: Db, schedule: PlanningSchedule): Promise<ActivityDto[]>;
    /** The programme's data date (YYYY-MM-DD). */
    refDate(schedule: PlanningSchedule): string;
    /** GlobalId → activity codes from the 4D links of a programme series. */
    elementActivities(db: Db, seriesId: string): Promise<Map<string, string[]>>;
    /** Planner rights (rules, unit prices): project admin or the planner role. */
    canPlan(access: ProjectAccess): boolean;
    /** Names and links of programmes ("Bugün" activity). */
    labels(db: Db, projectId: string, ids: string[]): Promise<{ id: string; label: string; link: string }[]>;
  };
  /** Coordinate: clash tests that use a model set. */
  "coordinate.modelSets": {
    /** Name of a test that still selects a file the set no longer has, else null. */
    testUsingRemovedFile(db: Db, setId: string, fileIds: ReadonlySet<string>): Promise<string | null>;
    hasTests(db: Db, setId: string): Promise<boolean>;
  };
  /** Coordinate: an issue linked to a clash group (markup / issue links). */
  "coordinate.linkTargets": {
    clashGroup(
      db: Db,
      projectId: string,
      user: AuthUser,
      groupId: string,
    ): Promise<{ info: { fileId: string; fileName: string; versionId: string; version: number; clashTestId: string; title: string } }>;
  };
  /** Coordinate: parameter change requests for labels ("Bugün" activity). */
  "coordinate.paramChanges": {
    list(
      db: Db,
      projectId: string,
      ids: string[],
    ): Promise<{ id: string; label: string; link: string; file: { deletedAt: Date | null; folderId: string; createdBy: string | null } }[]>;
  };
  /** AI: the language model clients behind the core's ai/provider.ts. */
  "ai.provider": {
    resolve(db: Db, secretKey: Buffer, projectId: string | null, modelOverride?: string): Promise<AiProvider>;
    resolveSetup(db: Db, secretKey: Buffer, projectId: string | null, modelOverride?: string): Promise<{ cfg: ProviderConfig; allowExternal: boolean }>;
    resolveSelected(
      db: Db,
      secretKey: Buffer,
      projectId: string,
      userId: string,
      selection: Exclude<AiProviderSelection, "project">,
      modelOverride?: string,
    ): Promise<AiProvider | null>;
  };
  /** AI: the task queue ("Yapay Zekâya Gönder"): the user's open task of a kind in a project. */
  "ai.tasks": {
    open(db: Db, projectId: string, userId: string, kind: string): Promise<{ id: string; status: "pending" | "claimed" } | null>;
  };
  /** Field: forms that mirror records of an outside system (Autodesk forms), in one read-only template per project. */
  "field.externalForms": {
    upsert(
      db: Db,
      input: {
        projectId: string;
        actorId: string;
        existingId: string | null;
        displayId: string;
        status: FormStatus;
        formDate: string | null;
        summary: string;
        createdAt: Date;
        updatedAt: Date;
      },
    ): Promise<string>;
  };
}

const provided: Partial<Capabilities> = {};
/** The module that provided each capability (app/module-owner.ts); the core's have none. */
const owners = new Map<keyof Capabilities, string>();

export function provideCapability<K extends keyof Capabilities>(key: K, impl: Capabilities[K]): void {
  provided[key] = impl;
  const owner = loadingModule();
  if (owner) owners.set(key, owner);
  else owners.delete(key);
}

/** The capability, or undefined when nothing provides it or its module is off (app/module-ids.ts). */
export function capability<K extends keyof Capabilities>(key: K): Capabilities[K] | undefined {
  const owner = owners.get(key);
  if (owner && !moduleIds().includes(owner)) return undefined;
  return provided[key];
}
