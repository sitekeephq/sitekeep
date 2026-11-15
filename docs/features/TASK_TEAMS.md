# Task teams and WIP visibility (ISO 19650)

ISO 19650 expects each task team to produce its information in its own work in progress (WIP)
area, hidden from the other teams until it is shared (ISO 19650-1 §12.2, ISO 19650-2 §5.1.7(e) and
§5.6.2). In SiteKeep, a task team is a kind of project role. A WIP folder can be owned by one team,
and a project setting closes a team's WIP folders to everyone outside that team.
Model and settings: [CDE states](CDE_STATES.md). Conformance: [ISO 19650](../compliance/ISO19650.md) (ISO-5).

## Model

| Concept | Where it lives | Notes |
|---|---|---|
| Task team | `project_roles` with `kind = 'task_team'`, `company_id`, `code`, `is_lead` | A project role, so it can receive folder permissions (`subject_type = 'role'`) and be a workflow assignee. There is one team per company (D-4), and a person may belong to several teams |
| Membership | `member_roles` | The same table as for roles |
| Owner team | `folders.owner_team_id` | Set on a WIP folder. The folder's subfolders inherit it, and the nearest owner wins |
| Policy | `project_cde_settings.wip_policy`, `admin_sees_wip` | `grants` (default): folder permissions apply as set and the owner team is for information only. `team_only`: the owning team's WIP is closed to everyone else (D-3) |

## The rule

The rule is enforced in one place, `FolderTree.permission` (`apps/server/src/core/security/access.ts`).
`FolderTree.visible`, `requireAction` and every route or module that uses them follow it.

A folder is **governed** when all three hold:
- the project's policy is `team_only`;
- the folder's CDE state (its own, or its nearest stated ancestor's) is WIP;
- the folder or one of its ancestors has an owner team.

For a governed folder:

| Who | Effective permission |
|---|---|
| A member of the owning team | Their normal permission, including grants inherited from above |
| A project or system administrator outside the team | `manage` while `admin_sees_wip` is on. When it is off, they are treated like anyone else outside the team |
| Anyone else | Only the **exception grants** made on the owned folder or below it. Grants inherited from above the owned folder do not count. Without an exception grant they get `none`: the folder is not listed and returns 404 |

The principal carries `teamIds` (from `projectAccess`). Membership is checked against `teamIds`
and `roleIds`, so an SDK caller that builds a `Principal` with role ids only gets the same result.
The signatures of `FolderTree`, `effectivePermission` and `requireAction` are unchanged:
`FolderTree.load` reads the policy itself, and a `FolderTree` built without it behaves as `grants`.

The rule does not change existing projects. Their policy stays `grants` until an administrator
switches it on. New projects from the ISO 19650 template (`apps/server/templates/iso19650-temel.json`)
start with `wipPolicy: "team_only"`.

## Exception grants (D-3)

`PUT /api/v1/projects/:pid/folders/:fid/permissions` on a governed folder checks every grant:

- A grant to a subject **outside** the owning team needs a `reason`. Outside means: a user who is
  not a member, a company other than the team's company, or a role other than the team. Without a
  reason the server answers `400 wip_reason_required`, with `details.teamName`.
- When the grant is written, the server records the audit event `cde.override` with the team, the
  reason and the grants. `folder.permissions_set` also carries the reason.
- Grants inside the team, and removals (`level: "none"`), need no reason.

Under `grants` nothing changes and no reason is asked for. The web app asks for the reason in a
prompt (`useWipReason`, `apps/web/src/features/documents/components/WipReason.ts`), and the MCP tool
`cde_folder_permissions_set` takes an optional `reason`.

## API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/projects/:pid/roles` | members | Roles and task teams; each has `kind`, `companyId`, `code`, `isLead` |
| POST | `/projects/:pid/roles` | project administrators | `{ name, kind: "task_team", companyId?, code?, isLead? }` |
| PATCH / DELETE | `/projects/:pid/roles/:rid` | project administrators | `kind` is fixed after creation. Deleting a team removes its memberships and grants, and clears the folders it owned |
| POST / DELETE | `/projects/:pid/roles/:rid/members/:uid` | project administrators | Team membership |
| PUT | `/projects/:pid/folders/:fid/owner-team` | project administrators | `{ teamId: uuid \| null }`. Only folders in WIP can get an owner. Audit `folder.owner_team_set` |
| POST | `/projects/:pid/cde/teams/seed` | project administrators | Creates a team for every company that has none and fills in owner teams. Audit `cde.teams_seeded` |
| PUT | `/projects/:pid/cde/settings` | project administrators | `{ wipPolicy, adminSeesWip }` |

`FolderDto.ownerTeamId` carries the folder's own owner team. `GET /projects/:pid/folders/:fid/who-can-see`
adds the reason `task_team_wip` for members outside the team, and the explanation sentence names the team.

## Seeding (D-4)

`apps/server/src/cde/teams.ts`. Seeding is idempotent and never undoes an administrator's choice:

- **New project from a template.** One team per slot company, with the slot's code (else the
  company code), plus a team for the creator's company. A WIP folder whose direct grants name
  exactly one slot company is owned by that company's team; its subfolders inherit the owner.
- **New member, or a member's company changed.** The member joins their company's team if the
  project has one.
- **Existing projects.** These are seeded at server start (`seedTaskTeams`, in batches) and by the
  backfill script (`DATABASE_URL=… npx tsx apps/server/src/scripts/cde-backfill.ts [batchSize]`).
  Only projects that have no task team at all are seeded. A project's companies are its members'
  companies and its template slot companies. Each company gets a team, its members join it, and
  owner teams are inferred from the template slots as above. A team an administrator deleted is not
  created again. The policy stays `grants`, so seeding hides nothing.

## Web

- **Project Settings → CDE → Task Teams** (`TaskTeamsSection.tsx`):
  - who sees WIP (the policy) and whether administrators see all WIP;
  - the teams with their code, company, lead flag and members;
  - add, delete and lead actions, and "Create Teams for Companies".
- **Folder settings** (`OwnerTeamField.tsx`): Owner Task Team, shown for WIP folders and editable by
  project administrators.
- **Folder permissions:** the reason prompt for exception grants.
- **Who can see:** a note when the folder is a team's WIP, and the rule shown as the reason for
  members outside the team (`WipRuleNote.tsx`).

## Query paths checked

Every path that returns files or folders to a user was checked against the rule:

- **Already filtered.** These go through `FolderTree.permission`, `visible` or `requireAction`:
  - folders, contents, files, versions, models (IFC picker), search and zip;
  - attributes, folder settings, approvals, review start, who-can-see;
  - previews, PDF and media, markups, model sets, IDS, model query and compare, document comparison, docintel;
  - the reports datasets (`files`, `versions`, `models`, `doc_comparisons`, `spec_registers`, `model_elements`);
  - Today's recent changes, location links, BCF import model matching;
  - the OpenCDE Documents API and pages.
  
  MCP tools call these REST routes with the user's own token.
- **Fixed in this change.** The BCF export's header files left out a model in a team's WIP closed
  to the requester. Other folders keep the earlier behaviour.
- **Open by design.** Access granted through a workflow or a record, not through a folder:
  - review files reach the review's starter and assignees (and the `reviews` / `review_files` report datasets);
  - work and transmittal attachments reach the work's readers;
  - issue viewpoints carry model version ids and the snapshot image.
- **Document codes and audit (ISO-3, ISO-4).** A code conflict (409, upload warning) does not name
  the path or file of a holder in a WIP folder closed to the caller. The code conflicts list leaves
  such files out. The file history follows the file's view right. In the project audit log, its CSV
  and the activity feed, a row about such a file or folder keeps its place (append-only, hash
  chain), but its target name and details are withheld (`{ "withheld": "task_team_wip" }`); this
  includes rows that name the file in their details, such as zip downloads. All of this matters
  for administrators only when `admin_sees_wip` is off.
- **Administrators only.** Trash lists everything to project administrators, even when
  `admin_sees_wip` is off. The system audit log (`/admin/audit`) is not filtered.
- **Low.** Only ids: location IFC links, the OpenCDE `usableContext` folder echo. The OpenCDE
  session page shows the document picked when the session started.
- **Not user facing.** Jobs, workers, the backfill and server-side copies. Notifications carry no
  file names except returned review files, which go to the review starter.

## Tests

ISO19650-2 5.1.7(e) / -1 12.2 task team WIP:
- `apps/server/test/cde/task-teams.test.ts`:
  - another team's WIP returns 404 through the API, search, zip and BCF export;
  - `admin_sees_wip` on and off;
  - exception grant with a reason and `cde.override`;
  - owner team route;
  - `grants` policy unchanged;
  - seeding is idempotent.
- e2e `e2e/specs/task-teams.spec.ts`: a member of team B does not see team A's WIP folder. Core
  only; passes with and without modules.
- `apps/server/test/cde/iso19650-acceptance.test.ts`: in an ISO template project with four parties,
  the other parties get 404 for the designer's WIP, and a code conflict does not name the holder.
