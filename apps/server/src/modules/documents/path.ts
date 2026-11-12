import { FolderTree } from "../../core/security/access.js";

export function folderDisplayPath(tree: FolderTree, folderId: string): string {
  return tree
    .ancestry(folderId)
    .map((id) => tree.get(id).name)
    .join(" / ");
}
