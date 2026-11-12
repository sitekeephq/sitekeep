/**
 * Optional UI and data one module offers the core or another module (docs/modules/README.md).
 * A consumer asks for a capability and hides the feature when it is missing: the provider may not
 * be installed (Community, or a licence without that module).
 */
import type { ComponentType, ReactNode } from "react";
import type { SelectedItem, ViewerEngine } from "@7dimensions-project/bim-viewer";
import type { AiTaskButtonProps } from "../shared/ai/AiTaskButton";
import type { AiTaskButtonMode } from "../shared/ai/ai-tasks";
import type { CashflowDto, CompanyDto, CostLineDto, ElementCostsDto, FormTemplateDto, LocationDto, MemberDto, TakeoffDto, WorkDetailDto, WorkFieldValues } from "@sitekeep/shared";

export interface WebCapabilities {
  /** Connect: editing office files in the browser (WOPI) and Forma Eşitleme in Yönetim. */
  "connect.ui": {
    /** The file's editing state ("Düzenle", who is editing); calls onVersionChanged when the editor saved. */
    useFileOffice(
      projectId: string,
      file: { id: string; extension: string; latest: { id: string } } | null | undefined,
      onVersionChanged: () => void,
    ): unknown;
    OfficeEditButton: ComponentType<{ projectId: string; fileId: string; office: unknown }>;
    OfficeLockNote: ComponentType<{ office: unknown }>;
    AdminFormaSyncSection: ComponentType;
  };
  /** Manage: submittal package items, meetings, registers, spec import, RFI drafts and "Bırak, kaydet". */
  "manage.ui": {
    PackageItems: ComponentType<{ w: WorkDetailDto; onChanged(): void }>;
    MeetingBox: ComponentType<{ w: WorkDetailDto; members: MemberDto[]; companies: CompanyDto[]; onChanged(): void; onNext(): void }>;
    RegisterView: ComponentType<{ kind: "submittal" | "rfi"; stamp?: unknown; onOpen(id: string): void }>;
    ImportDialog: ComponentType<{ onClose(): void; onDone(): void; items?: unknown[] }>;
    RfiDraftBox: ComponentType<{ onDraft(d: { title: string; fields: WorkFieldValues; notes: string[] }): void }>;
    FileRecordDialog: ComponentType<{ file: File; onClose(): void; onBack?(): void; onCreated?(): void }>;
    FileDropZone: ComponentType<{ onFile(file: File): void }>;
  };
  /** AI: "Projeye Sor", the AI task button, the AI settings of the administrator and of a project. */
  "ai.ui": {
    AskPanel: ComponentType<{ projectId: string; open: boolean; onClose(): void }>;
    AiTaskButton: ComponentType<AiTaskButtonProps>;
    useAiTaskMode(projectId: string): AiTaskButtonMode;
    AdminAiSection: ComponentType;
    ProjectAiSettings: ComponentType;
  };
  /** Cost: 5D unit prices / rules dialog and the cost data the 4D panel draws. */
  cost: {
    CostDialog: ComponentType<{ versionIds: string[]; scheduleId: string | null; canEdit: boolean; onChanged?(): void; onClose(): void }>;
    cashflow(pid: string, o: { scheduleId?: string | null; versionId?: string | null; step?: "day" | "week" | "month" }): Promise<CashflowDto>;
    elementCosts(pid: string, versionId: string): Promise<ElementCostsDto>;
    elementLines(pid: string, versionId: string, guid: string, scheduleId?: string | null): Promise<CostLineDto[]>;
  };
  /** Cost: 2D takeoff (2B Metraj) from the PDF and DWG viewers. */
  "cost.takeoff": {
    get(pid: string, versionId: string): Promise<TakeoffDto>;
    /** A length or area drawn in the DWG viewer; `drawingUnits` = metres per drawing unit. */
    add(pid: string, versionId: string, body: { page: number; kind: "length" | "area"; points: [number, number][]; drawingUnits?: number }): Promise<unknown>;
  };
  /** Planning: the viewer's 4D bar (programme over the models). */
  "planning.fourD": {
    FourDPanel: ComponentType<{ engine: ViewerEngine; loaded: string[]; hasSelection: boolean; selected?: SelectedItem | null; onClose(): void }>;
  };
  /** Coordinate: the clash tests tab of "Koordinasyon". */
  "coordinate.clashTests": { ClashTests: ComponentType; ClashResults: ComponentType<{ testId: string }> };
  /** Coordinate: the viewer's clash mode (?clash=…&ct=…): loading a clash and its side panel. */
  "coordinate.viewerClash": {
    load(projectId: string, testId: string, clashId: string): Promise<ViewerClash>;
    ClashPanel: ComponentType<{
      projectId: string;
      clash: ViewerClash;
      engine: ViewerEngine | null;
      isolated: boolean;
      onIsolate(on: boolean): void;
      onChanged(): void;
      onClose(): void;
    }>;
  };
  /** Coordinate: parameter change bits of an IFC file in the file drawer. */
  "coordinate.paramFile": {
    useStatus(projectId: string, fileId: string, enabled: boolean): unknown;
    FileButton: ComponentType<{ projectId: string; fileId: string; status: unknown }>;
    VersionBadge: ComponentType<{ status: unknown; versionId: string }>;
  };
  /** Field: the "new form" dialog, also offered by "+ Yeni" in İşler. */
  "field.newFormDialog": ComponentType<NewFormDialogProps>;
}

/** What the viewer needs of a clash (Coordinate's ClashDetail has more). */
export interface ViewerClash {
  a: { versionId: string; globalId: string };
  b: { versionId: string; globalId: string };
  point: [number, number, number];
  [more: string]: unknown;
}

export type { ReactNode };

export interface NewFormDialogProps {
  templates: FormTemplateDto[];
  locations: LocationDto[];
  onClose(): void;
  onCreated(key: string): void;
  /** Preselected template ("+ Yeni" read it from the typed sentence). */
  initialTemplateId?: string;
}

const provided: Partial<WebCapabilities> = {};

export function provideWebCapability<K extends keyof WebCapabilities>(key: K, impl: WebCapabilities[K]): void {
  provided[key] = impl;
}

export function webCapability<K extends keyof WebCapabilities>(key: K): WebCapabilities[K] | undefined {
  return provided[key];
}
