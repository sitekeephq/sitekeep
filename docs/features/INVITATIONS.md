# Invitations

People without a SiteKeep account are invited to a project by e-mail address: from **Project
Settings → Members** and from the [project set-up wizard](PROJECT_SETUP_WIZARD.md) (people step,
also from a CSV / Excel file). An address that already has an active account is simply added.

Community ([map](../MAP.md#2-community-or-enterprise)).

## How it works

1. **Invite.** An invitation creates a **pending user** (`users.pending`, kept disabled: no sign-in,
   no seat) and makes them a member of the project at once, with the chosen company, project roles,
   task team and administrator flag. The membership is shown as **Invited** in the member list.
   A single-use token is created; only its SHA-256 is stored. It expires after **14 days**.
2. **Deliver.** When an e-mail server is configured (`CDE_SMTP_URL` / `CDE_SMTP_FROM`) and e-mail is
   switched on in the Privacy Centre, the invitation e-mail is sent (English or Turkish: the
   inviter's choice, else the installation's language, `CDE_DEFAULT_LANGUAGE`). Otherwise, or when
   sending fails, the inviter gets the **invitation link** to copy and hand over. No e-mail is ever
   sent while e-mail is switched off ([privacy](PRIVACY.md)).
3. **Accept.** The link opens `/invite#<token>`. The token is in the fragment, so it is never sent to
   the server in a URL (no request log, no `Referer`). The page shows who invited the person to which
   projects; the person sets a name and password (at least 10 characters), or, when
   [Google sign-in](GOOGLE_SIGN_IN.md) is configured, continues with Google **with the same
   address**. The account becomes active, signed in, with the interface language the person accepted
   in. The memberships are already there, so the project is visible at once.

A token works once: accepting spends it in the same statement that checks it. Accepting also closes
the person's other open invitations (to other projects), since those memberships exist already.

| Situation | Answer |
|---|---|
| Unknown token | 404 `invitation_invalid` |
| Expired | 410 `invitation_expired` (send it again) |
| Already accepted (or the account was enabled by an administrator) | 410 `invitation_used` |
| Revoked | 410 `invitation_revoked` |
| Google account with another address | back to `/login?authError=invitation_email_mismatch`; the invitation stays open |

### Members screen

Project Settings → Members → **Invite by E-mail**: address, name (optional), company, project role,
task team (default: the team of the company), project administrator, language. The list below shows
the project's invitations of the last 90 days (open, expired, accepted, revoked) with:

- **Send Again**: a new token and 14 days; the earlier link stops working; e-mailed or a new link.
- **Revoke**: the link stops working; while the person is still pending, their membership and roles
  in this project are removed. The pending account itself stays (disabled, no seat, invisible to
  other users); a later invitation reuses it.
- **Remove** in the member list (an invited member): the membership goes and the open invitation to
  this project is revoked with it.

### Who may invite

| Who | Existing account | No account (invitation) |
|---|---|---|
| System administrator | added | invited |
| Project administrator | added (as before) | only when **Administration → Users → Invitations → Project Administrators May Invite People Without an Account** is on |
| Other members | no | no |

The setting (`system_settings` key `auth.invitations`, `{ projectAdminsMayInvite }`) is **off by
default**: an invitation opens an account, which used to be a system administrator's decision, and
without an e-mail server the inviter receives the link (so a project administrator could open
accounts for any address). A system administrator turns it on deliberately. The set-up wizard is for
system administrators only, so it always invites.

### Limits

- 60 invitations (new or sent again) per inviter and hour (429 above).
- 20 unknown, spent or expired tokens per client IP and 10 minutes on the public routes (429 above).
- Shared mailboxes (info@, noreply@ … the wizard's list) are not invited.
- An address whose account a system administrator disabled is not invited (enable it instead).
- Enabling a pending account by hand in Administration → Users ends its invitation; the person then
  signs in with the password the administrator sets.

## Audit

| Action | When | Details |
|---|---|---|
| `user.created` | the pending account is created | `pending: true` |
| `invitation.created` | invited (members screen or wizard) | e-mail, language, expiry, company, roles, administrator flag, `wizard` |
| `invitation.resent` | sent again | e-mail, language, expiry |
| `invitation.accepted` | accepted (one row per project) | e-mail, `provider` (password / google) |
| `invitation.revoked` | revoked | e-mail |
| `invitation.settings` | the system setting changed | `projectAdminsMayInvite` |
| `member.added` | an existing account added through the invitation form | e-mail, company, roles |

The project audit log has the group **All Invitation Actions** (`invitation.*`).

## API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/v1/projects/:pid/invitations` | project administrators | `{ canInvite, mail: { configured, enabled }, invitations }` |
| POST | `/api/v1/projects/:pid/invitations` | project administrators; invitations as above | `{ email, name?, companyId?, roleIds?, isProjectAdmin?, language? }` → `{ status: "added" \| "invited", userId, invitation?: { id, expiresAt, mailed, url?, mailSkipped? } }`. `url` only when no e-mail was sent (`mailSkipped`: `smtp_not_configured`, `smtp_disabled`, `send_failed`) |
| POST | `/api/v1/projects/:pid/invitations/:id/resend` | as inviting | `{ language? }` → the delivery |
| DELETE | `/api/v1/projects/:pid/invitations/:id` | project administrators | revoke |
| POST | `/api/v1/invitations/lookup` | public | `{ token }` → email, name, projects, inviter, expiry, language, `google` |
| POST | `/api/v1/invitations/accept` | public | `{ token, name, password }` → the user; sets the session cookie |
| POST | `/api/v1/invitations/google` | public | `{ token }` → a 10-minute httpOnly cookie for the Google callback, `{ url }` |
| GET / PUT | `/api/v1/admin/invitations` | system administrators | `{ projectAdminsMayInvite }` |

The wizard: `invite` on `POST /projects/setup/preview` and `/projects/from-template`
([wizard](PROJECT_SETUP_WIZARD.md#server)).

## Code

| What | Where |
|---|---|
| Tables (`invitations`, `users.pending`) | `apps/server/src/db/schema-invitations.ts`, `schema.ts`, migration `drizzle/0047_invitations.sql` |
| Pending user, membership, token, e-mail, accept, revoke, list | `apps/server/src/auth/invitations.ts` |
| Routes, limits, setting | `apps/server/src/auth/invitation-routes.ts` |
| Google callback with an invitation | `apps/server/src/auth/routes.ts` |
| Wizard invitations | `apps/server/src/projects/template-apply.ts` |
| Shapes | `packages/shared/src/platform/invitations.ts` |
| Accept page | `apps/web/src/features/auth/pages/AcceptInvitation.tsx` |
| Members screen | `apps/web/src/features/project-settings/pages/MemberInvitations.tsx` |
| Administration setting | `apps/web/src/features/admin/pages/Admin.tsx` (Invitations card) |

## Tests

| What | Test |
|---|---|
| Invite (pending user, membership, roles, link, audit), accept once, reuse refused, expiry and resend, revoke, existing / disabled / shared addresses, who may invite (setting off and on), token limit, e-mail in the chosen language, no e-mail while switched off, Google with the same and another address, wizard dry run and create, people files | `apps/server/test/auth/invitations.test.ts` |
| People table import, outcomes, merging, the request with invitations, the accept page's token | `apps/web/test/projects/invitations.test.ts` |
| Wizard with a new address → link → accept → project visible; CSV import; members screen invite, send again, revoke | `e2e/specs/invitations.spec.ts` |
| iPhone: members screen and accept page without sideways scrolling | `e2e/specs/mobile-invitations.spec.ts` |

## Planned

- Invitations without a project (Administration → Users) and bulk invitations from a file on the
  members screen.
- Removing pending accounts that have no open invitation left (today they stay disabled).
