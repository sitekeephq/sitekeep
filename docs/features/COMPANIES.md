# Companies

Companies (the contractor, the consultant, the client…) are kept in one list per server by system
administrators (**Administration → Users and Companies**). Each project has its own **companies on
the project**; only these appear inside the project, so two organisations working on one server do
not see each other's companies.

Community ([map](../MAP.md#2-community-or-enterprise)).

## Who sees which companies

| Who | Sees |
|---|---|
| System administrator, auditor | Every company, with the projects it is on; filter by project or "on no project" |
| Anyone else | The companies on the projects they are a member of, and their own company |
| Any list inside a project | Only the companies on that project, also for system administrators |

"Inside a project" means every company picker: a member's company, task teams, role packages, folder
permissions, issue assignment, work and letter recipients (from, to, cc), transmittal recipients,
workflow step assignees, invitations, and the lists of the Enterprise modules (meeting attendees,
filing a received document, form flows, the AI assistant).

## People

The user directory (`GET /api/v1/users`) follows the same rule. System administrators and auditors
see everyone; anyone else sees the active people who share an active project with them, and
themselves. A project administrator therefore picks people from their own projects in **Project
Settings → Members**; anyone else is added by exact e-mail address in **Invite by E-mail** (an
existing account is added at once, an unknown address gets an invitation). There is no search over
other people's names or addresses.

## Companies on a project

**Project Settings → Members → Companies on This Project** lists them. A project administrator adds
a company they can see (one of their other projects' companies or their own); a system administrator
can add any company, and can create a new company straight onto a project. A company is taken off
while nothing in the project uses it (members, task teams, slots, permissions, issues or works);
otherwise the answer is "still used".

A company comes onto a project by itself when:

- the project is created (the creator's company), or created from a template or the set-up wizard
  (every company the template's roles, teams, people and permissions name);
- a person is added or invited with their own company;
- a project administrator picks a company they can see in one of the lists above.

Everyone else can pick only companies already on the project; a company of another project is
refused (`400`), with the same answer as for a company that does not exist.

## API

| Call | Answer |
|---|---|
| `GET /api/v1/companies` | The companies the caller may see (system administrators: every company with `projects`) |
| `GET /api/v1/companies?projectId=…` | The companies on that project (members of the project only) |
| `GET /api/v1/projects/:pid/companies` | The companies on the project: what pickers use |
| `POST /api/v1/projects/:pid/companies` `{ companyId }` | Puts a company on the project (project administrators) |
| `DELETE /api/v1/projects/:pid/companies/:cid` | Takes it off (`409` while it is used) |
| `POST /api/v1/companies` `{ name, code?, projectId? }` | Creates a company (system administrators), optionally onto a project |

Modules use the SDK: `listProjectCompanies`, `projectCompanyIds`, `requireProjectCompanies` and the
`projectCompanies` table (server), `api.projectCompanies(projectId)` (web).

## Design notes

- SiteKeep has no organisation (hub, tenant) of its own: the project is the unit of separation.
  So a company is not owned by one organisation; it is **linked** to every project it works on
  (`project_companies`). A company shared by two projects is one row linked twice, never copied, so
  its code, address and e-mail stay the same everywhere and nothing has to be repointed.
- Company names and codes stay unique per server.
- Migration `0060_project_companies` puts every company a project already refers to on that project
  (members and their own companies, template slots, task teams, invitations, issues, works and
  receipts, transmittal recipients, folder permissions, workflow assignees). It only adds rows and
  can run again. A company used nowhere stays on no project: only system administrators see it,
  until it is added to a project.
