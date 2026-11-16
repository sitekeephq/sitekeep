/**
 * ISO 19650 slots of the file drawer (docs/features/CDE_STATES.md). The follow-up work fills them
 * here without touching FileDrawer.tsx:
 *   FileCdeChips  under the title: state, suitability / revision codes (ISO-2), status flag (ISO-1),
 *                 superseded by / supersedes links of the current version (ISO-12, SupersessionLinks.tsx)
 *   FileCdePanel  above the version history: transitions (ISO-1, CdeTransitions.tsx: send to Shared,
 *                 publish, administrator override), code inputs (ISO-2, FileCodesPanel.tsx),
 *                 history (ISO-4, FileHistoryPanel.tsx)
 *   VersionCdeNote  in a row of the version history: that version's supersession links (ISO-12)
 */
import type { FileDto, FileVersionDto, PermissionLevel } from "@sitekeep/shared";
import { CodeChips } from "./CodeChips";
import { FileCodesPanel } from "./FileCodesPanel";
import { FileHistoryPanel } from "./FileHistoryPanel";
import { CdeStatusBadge, FileTransitionPanel } from "./CdeTransitions";
import { SupersessionLinks } from "./SupersessionLinks";

export interface FileCdeSlotProps {
  projectId: string;
  file: FileDto & { versions: FileVersionDto[] };
  level: PermissionLevel;
  /** Reload the drawer and the folder list after a change. */
  onChanged(): void;
}

export function FileCdeChips({ projectId, file }: FileCdeSlotProps) {
  return (
    <>
      <CodeChips suitability={file.latest.suitabilityCode} revision={file.latest.revisionCode} />
      <CdeStatusBadge status={file.cdeStatus} />
      <SupersessionLinks projectId={projectId} version={file.latest} />
    </>
  );
}

/** A row of the version history: the version's supersession links (older versions of an archive copy). */
export function VersionCdeNote({ projectId, file, version }: Pick<FileCdeSlotProps, "projectId" | "file"> & { version: FileVersionDto }) {
  // The current version's links are under the title already.
  if (version.id === file.latest.id) return null;
  return <SupersessionLinks projectId={projectId} version={version} />;
}

export function FileCdePanel(props: FileCdeSlotProps) {
  return (
    <>
      <FileTransitionPanel {...props} />
      <FileCodesPanel {...props} />
      <FileHistoryPanel projectId={props.projectId} file={props.file} />
    </>
  );
}
