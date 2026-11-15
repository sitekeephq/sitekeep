/**
 * ISO 19650 slots of the file drawer (docs/features/CDE_STATES.md). Empty for now: the follow-up
 * work fills them here without touching FileDrawer.tsx:
 *   FileCdeChips  under the title: state, suitability / revision codes (ISO-2), status flag (ISO-1)
 *   FileCdePanel  above the version history: code inputs (ISO-2), transitions (ISO-1), history (ISO-4)
 */
import type { FileDto, FileVersionDto, PermissionLevel } from "@sitekeep/shared";

export interface FileCdeSlotProps {
  projectId: string;
  file: FileDto & { versions: FileVersionDto[] };
  level: PermissionLevel;
  /** Reload the drawer and the folder list after a change. */
  onChanged(): void;
}

export function FileCdeChips(_props: FileCdeSlotProps) {
  return null;
}

export function FileCdePanel(_props: FileCdeSlotProps) {
  return null;
}
