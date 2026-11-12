import type { projects } from "../db/schema.js";
import { projectModules } from "./modules.js";

export function toProjectDto(p: typeof projects.$inferSelect, isProjectAdmin: boolean) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    rootFolderId: p.rootFolderId!,
    createdAt: p.createdAt.toISOString(),
    isProjectAdmin,
    modules: projectModules(p),
  };
}
