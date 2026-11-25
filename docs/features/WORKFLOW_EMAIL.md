# Workflow e-mail

Community. Issue #189. A review step or work item that is assigned to you, due soon, overdue or decided reaches you
by e-mail as well as in the notification list, when the installation has SMTP (`CDE_SMTP_URL`, `CDE_SMTP_FROM`).

## What is mailed

`notify()` (`apps/server/src/workflow/service.ts`) writes the in-app row and then hands the event to
`workflow/notification-mail.ts`. Kinds and their preference type (`MAIL_KINDS`):

| Type | Kinds |
|---|---|
| `assigned` | `review.assigned` (review start, next step, reassignment), `work.assigned` (new item, assignee change, next workflow step), `work.sent` (the addressed companies' people) |
| `due_soon` | `review.due_soon`, `work.due_soon` (one day before the step's due date) |
| `overdue` | `review.overdue`, `work.overdue` (assignees still to answer, and the starter) |
| `outcome` | `review.completed`, `review.returned`, `cde.returned`, `work.decided` |
| `delegation` | `delegation.started`, `delegation.ended`, `delegation.handed_over` (approval delegation, Platform module; the Account card shows it only with the module) |

With approval delegation ([DELEGATION.md](DELEGATION.md), Platform module) the delegates of a step's people get the
assignment and reminder notifications too, titled "Vekâleten (A adına): …", and so the e-mails.

Reminders keep their de-duplication (`workflow_reminders`: once per instance, step and kind), so a step mails once per
kind. One notification gives one mail per person. Not mailed: the actor who caused the event (`actorId`), disabled and
pending users. Other notification kinds stay in-app only.

Each mail has the title, the project code (subject prefix and a line), the due date (when there is one), the direct
link (`/projects/<id>/reviews/<id>`, `.../works/<id>`) under `CDE_PUBLIC_URL` (else `CDE_WEB_URL`), and a footer
about the settings. Texts are `workflow:mail.*` and the notification texts, rendered in the person's profile
language (default language when unset).

## Preferences

Per person and type: **project default / on / off** (Account > E-mail notifications, `users.prefs.emailNotifications`).
The project administrator sets the project's default (Project Settings > Workflows,
`projects.settings.emailNotifications`, `GET/PUT /projects/:pid/email-notifications`, audited as
`project.email_notifications_updated`). Order: person's choice, else project default, else on. Both live in existing
JSON columns, so there is no migration.

## Sending, privacy, failures

Mail goes through the outbound registry (connection `smtp`, purpose `eposta`, detail `kind: workflow_notification`, no
address, no content). Nothing is sent while SMTP is not configured or switched off in the Privacy Centre (the same
`mailBlocked()` the invitations use). Sending runs in the background; a failure is only logged and never breaks the
step (`settleNotificationMail()` waits for it on shutdown and in tests).

## Channels (SDK 0.19.0)

`registerNotificationChannel` ([module contract](../modules/README.md#notification-channels-sdk-0190)) gives a module the
same event: a Teams/Slack/webhook channel, or a digest that queues it and, with `claims`, takes over those people's
immediate mail. Digest, company and project rules, webhook channels and template editing are the Platform module's
(Enterprise Standard) and not part of the core.

## Tests

`apps/server/test/workflow/notification-mail.test.ts`, `e2e/specs/email-notifications.spec.ts`.
