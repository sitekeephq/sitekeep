# Privacy notice on the sign-in page

A text the system administrator writes ("aydınlatma metni", the information a data controller gives
under GDPR Art. 13 and KVKK m.10), shown on the sign-in page and on the invitation page, with an
optional **I Have Read the Privacy Notice** checkbox. SiteKeep Community. Issue #85 P3.

SiteKeep does not write the text: the organisation running it is the data controller and decides what
it says. A starting point is the [records of processing](../compliance/RECORDS_OF_PROCESSING.md) and
the [personal data inventory](../compliance/PERSONAL_DATA_INVENTORY.md).

## Settings

**Administration → Privacy Centre → Privacy Notice** (system administrators):

| Setting | Default | What it does |
|---|---|---|
| Show on the Sign-in and Invitation Pages | off | The text appears above the sign-in form and on the invitation page |
| Require "I Have Read the Privacy Notice" Before Sign-in | off | The checkbox must be ticked before **Sign In**, **Continue with Google**, an [OpenID Connect](OIDC_SIGN_IN.md) provider's button, **Accept and Sign In** or **Accept with Google** |
| Ask Again When the Text Changes | on | A new version must be accepted again; off: any earlier acceptance is enough |
| Text (English), Text (Turkish) | empty | Up to 20 000 characters each. Each page shows the language the person chose, or the other one when that is empty |

The text takes light markup, rendered without HTML: a blank line between paragraphs, `#` headings,
`-` and `1.` lists, `**bold**`, `*italic*`, `` `code` ``, `[link](https://…)` and pipe tables (the
assistant's renderer, `apps/web/src/shared/ui/Markdown.tsx`). Raw HTML is shown as text.

## Versions

Every save that changes the text (either language) adds one to the **version**. Switching the options
alone keeps it. The audit row `privacy.notice_updated` records the version, the options and, for a new
version, **the full text of both languages**: the hash-chained [audit log](AUDIT_LOG.md) keeps the
wording of every version, so what a person accepted stays provable after later changes. (An audit log
retention, if set, deletes those rows like any other after its period.)

The screen shows the current version, who saved it and when, and how many people accepted it.

## Acceptance

With the checkbox required:

- The pages send the version the person ticked (`privacyNoticeVersion` on `POST /auth/login` and
  `POST /invitations/accept`; `?notice=<version>` on `GET /auth/google` and `GET /auth/oidc/:id/start`,
  and `privacyNoticeVersion` on `POST /invitations/google`, carried to the Google or OpenID Connect
  callback in a 10-minute httpOnly cookie `cde_privacy_notice`).
- The server accepts the sign-in when the version sent is the current one, or when the account has
  already accepted the version in force (the current one; with **Ask Again** off, any). Otherwise it
  answers **`400 privacy_notice_required`** (Google and OpenID Connect: `/login?authError=privacy_notice_required`). The
  check runs only after the password is verified, so it reveals nothing about an account.
- An accepted version is recorded once per person in `privacy_notice_acceptances` (user, version,
  time, `via`: `password`, `google`, `oidc`, `invitation`, `invitation_google`, `invitation_oidc`; migration `0057`) and written to
  the audit log as `privacy.notice_accepted` with the IP address and user agent of the request
  (personal part, [retention](AUDIT_LOG.md#personal-data)).
- Scripts and API clients that sign in with `/auth/login` keep working for accounts that already
  accepted. API tokens and OAuth access tokens are not affected.
- Sessions already open continue; the new version is asked at the next sign-in.

Shown without the checkbox, nothing is recorded.

**Data subject rights:** the person's acceptances are a section of the
[personal data export](DATA_SUBJECT_RIGHTS.md#export) (`privacy_notice`). Anonymising the account keeps
them under the pseudonym, like the audit log: they are the controller's evidence that the person was
informed.

## API

| Route | Who |
|---|---|
| `GET /auth/privacy-notice` | public: `{ enabled, requireAck, version, text: { en, tr } }` (`enabled: false` and no text while off) |
| `GET /admin/privacy/notice` | system administrators: settings, `version`, `updatedAt`, `updatedByName`, `acceptedCurrent` |
| `PUT /admin/privacy/notice` | system administrators: `{ enabled?, requireAck?, reaskOnChange?, text?: { en?, tr? } }`; showing an empty notice is refused |

## Code and tests

- Server: `apps/server/src/privacy/notice.ts` (settings in `system_settings` key `privacy.notice`,
  check, acceptance, routes); used by `auth/routes.ts`, `auth/oidc-routes.ts` and `auth/invitation-routes.ts`; table
  `privacy_notice_acceptances` (`apps/server/src/db/schema-privacy-notice.ts`).
- Shared: `packages/shared/src/platform/privacy-notice.ts`.
- Web: `apps/web/src/features/auth/components/PrivacyNotice.tsx` (sign-in and invitation pages),
  `apps/web/src/features/admin/pages/AdminPrivacyNotice.tsx` (Privacy Centre).
- `apps/server/test/auth/privacy-notice.test.ts`: settings and versions, refusal and acceptance on
  password, invitation and Google sign-in, **Ask Again** on and off, audit rows.
- e2e `e2e/specs/privacy-notice.spec.ts`: the administrator writes and requires the notice; the sign-in
  page shows it and keeps the button off until the box is ticked.
