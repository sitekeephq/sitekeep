import type { CdeState } from "@sitekeep/shared";
import type { FolderTree } from "../core/security/access.js";

/**
 * The ISO 19650 state a folder is in: its own, else the nearest ancestor's ("01-WIP / Mimari"
 * is WIP). null when no folder on the path has one.
 */
export function cdeStateOf(tree: FolderTree, folderId: string): CdeState | null {
  if (!tree.byId.has(folderId)) return null;
  for (const id of tree.ancestry(folderId).reverse()) {
    const state = tree.byId.get(id)?.state;
    if (state) return state;
  }
  return null;
}
