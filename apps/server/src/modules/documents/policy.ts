import { can } from "@sitekeep/shared";
import { FolderTree, type ProjectAccess } from "../../core/security/access.js";
import { files } from "../../db/schema.js";
import { notFound } from "../../core/platform/http.js";
import { msg } from "../../i18n/index.js";

type FileRow = typeof files.$inferSelect;

/** Enforces document visibility without depending on Fastify route concerns. */
export function requireView(tree: FolderTree, access: ProjectAccess, file: FileRow): void {
  const permission = tree.permission(access.principal, file.folderId);
  if (can(permission.level, "view")) return;
  if (permission.canUpload && file.createdBy === access.user.id) return;
  throw notFound(msg("documents:entities.file"));
}
