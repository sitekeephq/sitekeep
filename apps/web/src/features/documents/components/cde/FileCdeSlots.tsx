/**
 * ISO 19650 slots of the file drawer (docs/features/CDE_STATES.md). The follow-up work fills them
 * here without touching FileDrawer.tsx:
 *   FileCdeChips  under the title: state, suitability / revision codes (ISO-2), status flag (ISO-1)
 *   FileCdePanel  above the version history: transitions (ISO-1, CdeTransitions.tsx: send to Shared,
 *                 publish, administrator override), code inputs (ISO-2, FileCodesPanel.tsx),
 *                 history (ISO-4, FileHistoryPanel.tsx)
 */
import type { FileDto, FileVersionDto, PermissionLevel } from "@sitekeep/shared";
import { CodeChips } from "./CodeChips";
import { FileCodesPanel } from "./FileCodesPanel";
import { FileHistoryPanel } from "./FileHistoryPanel";
import { CdeStatusBadge, FileTransitionPanel } from "./CdeTransitions";

export interface FileCdeSlotProps {
  projectId: string;
  file: FileDto & { versions: FileVersionDto[] };
  level: PermissionLevel;
  /** Reload the drawer and the folder list after a change. */
  onChanged(): void;
}

export function FileCdeChips({ file }: FileCdeSlotProps) {
  return (
    <>
      <CodeChips suitability={file.latest.suitabilityCode} revision={file.latest.revisionCode} />
      <CdeStatusBadge status={file.cdeStatus} />
    </>
  );
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
