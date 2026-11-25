# Approval delegation (vekâlet)

Issue #190. **Enterprise Standard**: the delegation itself (definitions, rules, notifications, the
"Vekâletler" page, API and MCP tools) is the [Platform module](../modules/platform.md)'s. The core only has a
small hook: assignee resolution in the workflow engine and the "X adına Y" record (`onBehalfOf`), offered to
modules through the SDK (0.20.0). Without a module that registers a resolver (Community) nothing changes.

## What it does

A person picks a delegate and a period (first and last day, inclusive), optionally limited to some projects. A
project administrator may define one for another member of their projects (for example a leaving colleague).

- **During the period** the steps and works that fall to the person go to the delegate as well: review steps
  (review chains), work workflow steps (RFI, technical approval / submittal, any type with a workflow template),
  works assigned to the person (actions, correspondence) and Field form approval steps. Either may act; the first
  answer for the person counts, the other gets a clear error (409).
- **Open items when it starts:** when a delegation becomes active (created for today or earlier, or its first day
  arrives: the reminder round), the person's steps and works that are already open in its scope get the delegate as
  well (`handOverOpenAssignments`, idempotent, delegate must be a member of the project; the mirror of "withdraw").
  The delegate gets one summary notification (`delegation.handed_over`), not one per item.
- **After the end** new assignments go to the person only. Steps assigned during the period stay with both until they
  are answered (ending a delegation early with "withdraw" also takes those back).
- **Record:** the answer is stored with the actor (the delegate) and `on_behalf_of_user_id` (the person). It shows as
  "A adına B" in the review history and marks, the work flow answers and timeline, the audit log
  (`details.onBehalfOf`), the `workflow_steps` report dataset (field `onBehalfOf`) and the form PDF (stamps and the
  approval history of the generic layout). The core has no review PDF; the review page's history is its record.
- **Permissions:** a delegation never widens folder permissions. Saving one returns warnings: projects of the scope the
  delegate is not a member of (nothing goes to them there), folders the person can view and the delegate cannot, and
  files of the person's open review steps the delegate cannot view.
- **Notifications:** both sides are told when a delegation starts and when it ends, in the app and by e-mail (type
  `delegation` with the same person / project-default on-off as the other types, link to the Vekâletler page). Delegates get the assignment,
  "due soon" and "overdue" notifications of the steps they hold, marked "Vekâleten (A adına)", by e-mail as well
  ([workflow e-mail](WORKFLOW_EMAIL.md)). Today ("Bugün"), "Görevlerim" (`/my-tasks`, `/me/today`) and the MCP tool
  `cde_today` show such rows with the person's name (`onBehalfOf`, "vekâleten").

## The core hook

`apps/server/src/workflow/delegation.ts`, exported by the SDK:

| Export | What |
|---|---|
| `registerAssigneeResolver({ id, delegates({ db, projectId, userIds, at }) })` | A module names the delegates of the assigned people at a moment. Called while the module loads (off with the module). A throw is logged and ignored |
| `enterStepDelegates(db, instance)` | When a step becomes current (start, next step, return, reassignment): resolves the step's people (users, companies, teams), asks the resolvers and stores the answer in `workflow_instances.step_delegates` |
| `stepActing(db, { instance, user, answered })` | How the user acts on the current step: as themselves or as the delegate of a person who has not answered yet (`actingAs` in the engine) |
| `openDelegateSteps`, `currentStepDelegates`, `isStepDelegate`, `wasStepDelegate` | Task lists ("vekâleten") and visibility |
| `notifyDelegates(db, delegates, notification)` | The step's notification to its delegates, title "Vekâleten (A adına): …", same kind (so e-mailed) |
| `handOverOpenAssignments(db, grant, projectIds)` | A delegation became active: the person's open steps and works in the projects get the delegate too; returns the counts |
| `dropStepDelegation(db, delegationId)` | Takes a delegation back from running steps and open works |
| `delegateAccessGaps`, `userCanReadFolder` | The permission warnings |

Kept delegates are project members, never the person and never one of the step's own people. Works without a workflow
keep the delegates of their assignee in `works.assignee_delegates` (set on create and on assignee change); such a
delegate sees and edits the work like the assignee (`canSeeWork` / `canEditWork` in `packages/shared`).

Submit routes take an optional `stepIndex` (reviews `POST …/submit`, works `POST …/respond`): an answer for a step
that has moved on meanwhile is refused (409, `workflow:errors.stepMovedOn`). Reviews and works lock the instance
(`FOR UPDATE`) while an answer is recorded, so two answers at the same moment cannot both count.

Migration `0061_delegation`: `review_marks.on_behalf_of_user_id`, `workflow_actions.on_behalf_of_user_id`,
`workflow_instances.step_delegates`, `works.assignee_delegates`. Existing rows: no delegate, own answers.

## Platform module

Table `delegations` (module migration `0001_delegations`), routes under `/api/v1`:

| Route | What |
|---|---|
| `GET /delegations[?projectId=]` | Mine (person, delegate, creator); with a project, every delegation covering it (its administrators) |
| `POST /delegations/check` | The warnings of an input; nothing saved |
| `POST /delegations` | `{ personId?, delegateId, startsOn, endsOn, projectIds?, note? }` → `{ delegation, warnings }` |
| `POST /delegations/:id/end` | Ends it now; `{ withdraw: true }` also takes back the open steps and works |

MCP: `cde_delegations_list`, `cde_delegation_create`, `cde_delegation_end` (listed only with the module). Page:
project menu → Yönetim → **Vekâletler** (`/projects/:pid/delegations`). Days are the server's calendar days.

## Tests

`apps/server/test/workflow/delegation-hook.test.ts` (hook, Community unchanged), `test/modules/platform/delegation.test.ts`
(the issue's acceptance list), `test/modules/field/delegation.test.ts` (form approval, PDF),
`e2e/specs/delegations.spec.ts`; the Platform module's `test/delegation.test.ts` (period rules).
