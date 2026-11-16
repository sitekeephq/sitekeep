import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  can,
  effectivePermission,
  type Action,
  type CdeWipPolicy,
  type EffectivePermission,
  type Grant,
  type OAuthScope,
  type Principal,
} from "@sitekeep/shared";
import type { Db } from "../../db/index.js";
import { folderGrants, folders, memberRoles, projectCdeSettings, projectMembers, projectRoles, projects, users } from "../../db/schema.js";
import { forbidden, notFound } from "../platform/http.js";
import { msg } from "../../i18n/index.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** Read-only auditor (docs/features/SECURITY_LOG.md#auditor). */
  isAuditor?: boolean;
  companyId: string | null;
  mustChangePassword?: boolean;
  /** Interface language from the profile (prefs.language); null = not chosen. */
  language?: string | null;
  /** The token the request was authenticated with (absent for internal calls). */
  token?: TokenInfo;
}

export interface TokenInfo {
  id: string;
  /** session = browser cookie, api = personal API token, oauth = access token of an OpenCDE client. */
  kind: "session" | "api" | "oauth";
  /** API and OAuth tokens: read = GET plus read-only POSTs. Sessions are always "write". */
  scope: "read" | "write";
  /** API tokens limited to these projects; null = every project of the user. */
  projectIds: string[] | null;
  /** OAuth tokens: granted scopes (bcf, documents, read, write) and the client record id. */
  oauthScopes?: OAuthScope[];
  oauthClientId?: string;
}

/** False when the caller's API token is restricted to other projects. */
export function tokenAllowsProject(user: AuthUser, projectId: string): boolean {
  const ids = user.token?.projectIds;
  return !ids || ids.includes(projectId);
}

export interface ProjectAccess {
  project: typeof projects.$inferSelect;
  user: AuthUser;
  principal: Principal;
  isProjectAdmin: boolean;
}

/** Loads the project and the caller's membership; 404 for non-members (no existence leak). */
export async function projectAccess(db: Db, projectId: string, user: AuthUser): Promise<ProjectAccess> {
  if (!isUuid(projectId) || !tokenAllowsProject(user, projectId)) throw notFound(msg("errors:entities.project"));
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound(msg("errors:entities.project"));
  const [member] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)));
  if (!member && !user.isAdmin) throw notFound(msg("errors:entities.project"));
  const isProjectAdmin = user.isAdmin || !!member?.isProjectAdmin;
  // Project roles (teams) take part in folder permissions as subjectType "role".
  const roleRows = member
    ? await db
        .select({ roleId: memberRoles.roleId, kind: projectRoles.kind })
        .from(memberRoles)
        .innerJoin(projectRoles, eq(projectRoles.id, memberRoles.roleId))
        .where(and(eq(memberRoles.projectId, projectId), eq(memberRoles.userId, user.id)))
    : [];
  return {
    project,
    user,
    isProjectAdmin,
    principal: {
      userId: user.id,
      companyId: member?.companyId ?? user.companyId,
      roleIds: roleRows.map((r) => r.roleId),
      teamIds: roleRows.filter((r) => r.kind === "task_team").map((r) => r.roleId),
      projectAdmin: isProjectAdmin,
    },
  };
}

export function requireProjectAdmin(access: ProjectAccess) {
  if (!access.isProjectAdmin) throw forbidden(msg("errors:projectAdminRequired"));
}

type FolderRow = typeof folders.$inferSelect;

/**
 * Who sees a task team's WIP folders (project_cde_settings, docs/features/TASK_TEAMS.md):
 * `grants` = the folder permissions as set; `team_only` = only the owning team, project
 * administrators when `adminSeesWip`, and exception grants on the team folder or below.
 */
export interface WipRule {
  policy: CdeWipPolicy;
  adminSeesWip: boolean;
}

/** A folder governed by the WIP team-only rule: the owning team and the folder that names it. */
export interface WipTeamScope {
  teamId: string;
  /** The folder carrying `owner_team_id` (the folder itself or its nearest owned ancestor). */
  ownedFolderId: string;
}

const GRANTS_RULE: WipRule = { policy: "grants", adminSeesWip: true };

/** True when the principal belongs to the task team (teamIds, or the team id among its roles). */
export function inTeam(principal: Principal, teamId: string): boolean {
  return !!principal.teamIds?.includes(teamId) || !!principal.roleIds?.includes(teamId);
}

/** All live folders and grants of a project, for permission maths in memory. */
export class FolderTree {
  readonly byId = new Map<string, FolderRow>();
  readonly children = new Map<string | null, FolderRow[]>();

  constructor(
    rows: FolderRow[],
    readonly grants: Grant[],
    /** The project's WIP visibility rule; omitted = folder grants only (no team rule). */
    readonly wip: WipRule = GRANTS_RULE,
  ) {
    for (const f of rows) {
      this.byId.set(f.id, f);
      const list = this.children.get(f.parentId) ?? [];
      list.push(f);
      this.children.set(f.parentId, list);
    }
    for (const list of this.children.values()) list.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }

  static async load(db: Db, projectId: string): Promise<FolderTree> {
    const rows = await db
      .select()
      .from(folders)
      .where(and(eq(folders.projectId, projectId), isNull(folders.deletedAt)));
    const ids = rows.map((r) => r.id);
    const grants = ids.length
      ? await db.select().from(folderGrants).where(inArray(folderGrants.folderId, ids))
      : [];
    return new FolderTree(rows, grants, await loadWipRule(db, projectId));
  }

  get(id: string): FolderRow {
    const f = this.byId.get(id);
    if (!f) throw notFound(msg("errors:entities.folder"));
    return f;
  }

  /** Folder ids from the root down to `id`. */
  ancestry(id: string): string[] {
    const chain: string[] = [];
    let cur: FolderRow | undefined = this.get(id);
    while (cur) {
      chain.unshift(cur.id);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return chain;
  }

  /**
   * Effective permission of the principal on the folder. Under `wip_policy = 'team_only'` a task
   * team's WIP folder (ISO 19650-1 §12.2, -2 §5.6.2) is closed to everyone outside the owning
   * team, whatever they inherit from above: project administrators pass only when
   * `adminSeesWip`, others keep only the exception grants made on the team folder or below it.
   */
  permission(principal: Principal, folderId: string): EffectivePermission {
    const chain = this.ancestry(folderId);
    const scope = this.wipTeamScope(folderId);
    if (!scope || inTeam(principal, scope.teamId)) return effectivePermission(principal, chain, this.grants);
    if (principal.projectAdmin && this.wip.adminSeesWip) return { level: "manage", canUpload: true };
    const below = chain.slice(chain.indexOf(scope.ownedFolderId));
    return effectivePermission({ ...principal, projectAdmin: false }, below, this.grants);
  }

  /**
   * The team rule that governs a folder, or null: only under `team_only`, only for folders whose
   * CDE state is WIP, and only when the folder or an ancestor names an owning team.
   */
  wipTeamScope(folderId: string): WipTeamScope | null {
    if (this.wip.policy !== "team_only") return null;
    let state: string | null = null;
    let owned: FolderRow | null = null;
    for (const id of this.ancestry(folderId).reverse()) {
      const f = this.byId.get(id)!;
      if (!owned && f.ownerTeamId) owned = f;
      if (!state && f.state) state = f.state;
      if (owned && state) break;
    }
    if (state !== "wip" || !owned) return null;
    return { teamId: owned.ownerTeamId!, ownedFolderId: owned.id };
  }

  /** True when the principal can see the folder itself or anything below it. */
  visible(principal: Principal, folderId: string): boolean {
    // Every member can open the project root, even when it looks empty to them.
    if (this.get(folderId).parentId === null) return true;
    if (this.permission(principal, folderId).level !== "none") return true;
    return (this.children.get(folderId) ?? []).some((c) => this.visible(principal, c.id));
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (fid: string) => {
      for (const c of this.children.get(fid) ?? []) {
        out.push(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  /** Nearest naming standard on the folder or one of its ancestors. */
  namingStandardId(folderId: string): string | null {
    for (const id of this.ancestry(folderId).reverse()) {
      const sid = this.byId.get(id)?.namingStandardId;
      if (sid) return sid;
    }
    return null;
  }
}

/**
 * True when the folder is a task team's WIP closed to the principal by the team-only rule (ISO-5).
 * For listings that are not folder-filtered otherwise (code conflicts, audit rows): the item is
 * left out or its name withheld. False without a principal or for a folder outside the rule.
 */
export function hiddenByWipRule(tree: FolderTree, principal: Principal | undefined, folderId: string): boolean {
  if (!principal || !tree.byId.has(folderId) || !tree.wipTeamScope(folderId)) return false;
  return tree.permission(principal, folderId).level === "none";
}

/** The project's WIP rule; the defaults (folder grants only) when the project has no settings row. */
export async function loadWipRule(db: Db, projectId: string): Promise<WipRule> {
  const [row] = await db
    .select({ policy: projectCdeSettings.wipPolicy, adminSeesWip: projectCdeSettings.adminSeesWip })
    .from(projectCdeSettings)
    .where(eq(projectCdeSettings.projectId, projectId));
  return row ?? GRANTS_RULE;
}

export function requireAction(
  tree: FolderTree,
  access: ProjectAccess,
  folderId: string,
  action: Action | "upload",
): EffectivePermission {
  const perm = tree.permission(access.principal, folderId);
  const ok = action === "upload" ? perm.canUpload : can(perm.level, action);
  if (!ok) {
    if (perm.level === "none" && !tree.visible(access.principal, folderId)) throw notFound(msg("errors:entities.folder"));
    throw forbidden();
  }
  return perm;
}

export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
