/**
 * Model files the viewer opens. IFC is the core's own; a module adds other formats (Connect: Revit .rvt)
 * through `ServerModule.modelFormats`, each with a converter to IFC. The job queue converts such a
 * version to IFC first and then runs the IFC path unchanged (viewer derivative, element index,
 * "Modele sor", version comparison) (docs/features/MODEL_FORMATS.md).
 *
 * The formats come from the modules that are on (app/modules.ts sets the resolver), so a module whose
 * licence lapses stops converting new versions; models converted before stay.
 */
import { registerModelExtension, splitExtension } from "@sitekeep/shared";

/** What a converter tells about one conversion (kept in the version's ifcSummary.source). */
export interface ModelSourceInfo {
  /** Source format, lower case extension ("rvt"). */
  format: string;
  /** Converter and its version ("rvt-rs 0.25.0"). */
  tool: string;
  /** Release of the authoring software the file was saved with ("2024"); null when unknown. */
  sourceVersion?: string | null;
  /** Elements drawn with an approximate shape (bounding box) instead of their own geometry. */
  approximated?: number;
  /** Placeholder objects without geometry left out of the view (trees, people); they stay in the element list. */
  hidden?: number;
  /** Support level of that release in the converter ("verified", "partial", "experimental"). */
  support?: string | null;
}

/** A model format a module converts to IFC. */
export interface ModelFormat {
  /** Lower case extensions without the dot (["rvt"]). */
  extensions: string[];
  /** Name shown to people ("Revit"). */
  label: string;
  /**
   * Converts `input` to an IFC file at `output`. Throws with a message for people when the file cannot be
   * converted (the version's model status shows it). `timeoutMs` is the job's limit.
   */
  toIfc(input: string, output: string, opts: { timeoutMs: number }): Promise<ModelSourceInfo>;
  /**
   * The converter installed now, in the same form `toIfc` reports as `tool` ("rvt-rs 0.25.0"); null when it is
   * missing. Optional (SDK 0.18.0). When given, the core converts again at start-up the versions whose model came
   * from another converter version, and retries a failed version once per converter version
   * (model-backfill.ts `queueModelReconversion`).
   */
  version?(): Promise<string | null>;
}

let resolve: () => readonly ModelFormat[] = () => [];

/** Set once by app/modules.ts: the formats of the modules that are on. Tests set their own. */
export function setModelFormats(fn: () => readonly ModelFormat[]): void {
  resolve = fn;
}

function extensionOf(name: string): string {
  return splitExtension(name).extension.toLowerCase();
}

/** The module format that converts this file to IFC; null for IFC itself and for other files. */
export function modelFormatFor(name: string): ModelFormat | null {
  const ext = extensionOf(name);
  if (!ext || ext === "ifc") return null;
  return resolve().find((f) => f.extensions.includes(ext)) ?? null;
}

/** Extensions the modules that are on convert to IFC (lower case, without the dot). */
export function modelFormatExtensions(): string[] {
  return [...new Set(resolve().flatMap((f) => f.extensions.map((e) => e.toLowerCase())))];
}

/** IFC, or a format a module that is on converts to IFC: the file gets a viewer derivative. */
export function isModelFile(name: string): boolean {
  return extensionOf(name) === "ifc" || modelFormatFor(name) !== null;
}

/**
 * Makes the shared viewer table (viewerFor) open the formats of the modules that are on with the model viewer,
 * on the server (preview info, open links). Called after the modules load.
 */
export function registerModelViewerExtensions(): void {
  for (const f of resolve()) for (const ext of f.extensions) registerModelExtension(ext);
}

/** The installed converter of a format (`ModelFormat.version`); null when the format does not report it or fails to. */
export async function converterVersion(format: ModelFormat | null): Promise<string | null> {
  if (!format?.version) return null;
  try {
    return (await format.version())?.trim() || null;
  } catch {
    return null;
  }
}
