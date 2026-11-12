import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  FOLDER_NAME_FORBIDDEN,
  type FolderState,
  type VirtualFolderDto,
  type VirtualFolderSpec,
} from "@sitekeep/shared";
import { audit } from "../core/platform/audit.js";
import { badRequest, notFound } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";
import { FolderTree, requireAction, type ProjectAccess } from "../core/security/access.js";
import type { Db } from "../db/index.js";
import {
  attributeDefinitions,
  folderAttributeBindings,
  folderGrants,
  folderSettings,
  folderVirtualChildren,
  folders,
} from "../db/schema.js";

function countSpecs(specs: readonly VirtualFolderSpec[] | undefined): number {
  return (specs ?? []).reduce((count, spec) => count + 1 + countSpecs(spec.children), 0);
}

/** Not-yet-created children of a folder (names that exist as real folders are hidden). */
export async function virtualFolderDtos(db: Db, tree: FolderTree, folderId: string): Promise<VirtualFolderDto[]> {
  const [row] = await db.select().from(folderVirtualChildren).where(eq(folderVirtualChildren.folderId, folderId));
  if (!row) return [];
  const real = new Set((tree.children.get(folderId) ?? []).map((folder) => folder.name));
  return row.children
    .filter((spec) => !real.has(spec.name))
    .map((spec) => ({
      name: spec.name,
      state: (spec.state ?? null) as FolderState | null,
      stateLabel: spec.stateLabel ?? null,
      descendantCount: countSpecs(spec.children),
    }));
}

/**
 * Creates the on-demand folders along `names` below `folderId` (existing real folders are reused)
 * and returns the last folder's id. Needs upload permission on the starting folder.
 */
export async function materializeFolders(
  db: Db,
  access: ProjectAccess,
  folderId: string,
  names: string[],
): Promise<{ folderId: string; created: string[] }> {
  const tree = await FolderTree.load(db, access.project.id);
  requireAction(tree, access, folderId, "upload");
  for (const name of names) if (!name.trim() || FOLDER_NAME_FORBIDDEN.test(name)) throw badRequest(msg("projects:errors.invalidFolderName", { name }));
  const created: string[] = [];
  let current = folderId;
  await db.transaction(async (tx) => {
    for (const name of names) {
      const [row] = await tx.select().from(folderVirtualChildren).where(eq(folderVirtualChildren.folderId, current));
      const spec = row?.children.find((child) => child.name === name);
      const rest = row?.children.filter((child) => child.name !== name) ?? [];
      const [existing] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.parentId, current), eq(folders.name, name), isNull(folders.deletedAt)));
      if (!existing && !spec) throw notFound(msg("projects:entities.namedFolder", { name }));
      if (row && spec) {
        if (rest.length) await tx.update(folderVirtualChildren).set({ children: rest }).where(eq(folderVirtualChildren.folderId, current));
        else await tx.delete(folderVirtualChildren).where(eq(folderVirtualChildren.folderId, current));
      }
      let id: string;
      if (existing) {
        id = existing.id;
        if (spec?.children?.length) {
          const [own] = await tx.select().from(folderVirtualChildren).where(eq(folderVirtualChildren.folderId, id));
          const merged = [...(own?.children ?? [])];
          for (const child of spec.children) if (!merged.some((item) => item.name === child.name)) merged.push(child);
          await tx
            .insert(folderVirtualChildren)
            .values({ folderId: id, children: merged })
            .onConflictDoUpdate({ target: folderVirtualChildren.folderId, set: { children: merged } });
        }
      } else {
        const source = spec!;
        id = randomUUID();
        await tx.insert(folders).values({
          id,
          projectId: access.project.id,
          parentId: current,
          name: source.name,
          state: source.state ?? null,
          stateLabel: source.stateLabel ?? null,
          namingStandardId: source.namingStandardId ?? null,
          createdBy: access.user.id,
        });
        if (source.grants?.length) await tx.insert(folderGrants).values(source.grants.map((grant) => ({ folderId: id, ...grant })));
        if (source.attributeDefinitionIds?.length) {
          const live = await tx
            .select({ id: attributeDefinitions.id })
            .from(attributeDefinitions)
            .where(inArray(attributeDefinitions.id, source.attributeDefinitionIds));
          if (live.length) {
            await tx.insert(folderAttributeBindings).values(live.map((definition) => ({ folderId: id, definitionId: definition.id })));
          }
        }
        if (source.gate) await tx.insert(folderSettings).values({ folderId: id, requireApprovedReview: true });
        if (source.children?.length) await tx.insert(folderVirtualChildren).values({ folderId: id, children: source.children });
        created.push(source.name);
      }
      current = id;
    }
  });
  if (created.length) {
    await audit(db, {
      projectId: access.project.id,
      userId: access.user.id,
      action: "folder.materialized",
      targetType: "folder",
      targetId: current,
      details: { parentId: folderId, path: names, created },
    });
  }
  return { folderId: current, created };
}
