# Sign-in security

Limits for failed sign-ins, two-factor authentication (TOTP), session lifetimes and the password
rules. Community ([map](../MAP.md#2-community-or-enterprise)). Issue #85: G-1, G-2, G-4, G-5.

Settings: **Administration → Sign-in Security** (system administrators). Every change is written to
the [audit log](AUDIT_LOG.md) as `auth.security_settings` with the old and new values. The same tab
holds the settings of the [security alerts](SECURITY_LOG.md#alerts-g-8) (many failed sign-ins, the
two-factor requirement turned off, …); sign-ins, failures and lockouts are listed in the
[security log](SECURITY_LOG.md).

| Setting | Default | Range |
|---|---|---|
| Failed attempts per account (e-mail address) | 10 | 3–100 |
| Failed attempts per client IP address | 50 | 10–1000 |
| Time window (minutes) | 15 | 1–1440 |
| Session length, absolute (days) | 14 | 1–90 |
| Idle timeout (hours; 0 = off) | 12 | 0–720 |
| Require two-factor authentication for | nobody | nobody / system administrators / all users |

Code: `apps/server/src/auth/sign-in-security.ts` (limits, sessions), `two-factor.ts` and `totp.ts`
(second factor), `security-routes.ts` (API), `core/security/auth.ts` (password rules); settings type
in `packages/shared/src/platform/sign-in-security.ts`; table `user_two_factor` (migration
`0055_two_factor`).

## Failed sign-ins (G-1)

Failures are counted in a sliding window, per account e-mail address and per client IP address
(behind a reverse proxy set `CDE_TRUST_PROXY`, otherwise every request comes from the proxy). When
either reaches its limit, the next attempts answer **`429 too_many_attempts`** with a `Retry-After`
header (seconds) until the oldest failure leaves the window, even with the right password. The IP
limit is higher because a whole office may share one address.

What counts as a failure:

- `POST /auth/login`: wrong password, unknown address or disabled account;
- `POST /invitations/accept`: an unknown, spent or expired invitation token (against the IP);
- `POST /auth/password`: a wrong current password;
- the second step (below): a wrong code or recovery code, also when turning two-factor off or
  making new recovery codes.

The failure that locks an account or an IP is written once as **`auth.locked`**: `details.scope`
(`account` or `ip`), `attempt` (`password`, `invitation`, `password_change`, `two_factor`),
`failures`, `windowMinutes`; for an account the address goes to the personal part of the log
(`emailHash` in the row, [personal data](AUDIT_LOG.md#personal-data)) and `user_id` is set when the
address belongs to an account. Each failed sign-in is still written as `auth.login_failed`.

No account enumeration: an unknown address gets the same answer as a wrong password, takes as long
(the password is checked against a dummy hash), and is locked the same way. A successful sign-in
clears the account's count, but only once the session starts: the right password does not reset the
count of wrong two-factor codes.

**Lift All Locks** (Administration → Sign-in Security) clears every count at once
(`auth.locks_cleared`). Counts are kept in memory per server process, like the OAuth token limiter:
enough for one on-prem server; a restart clears them.

## Two-factor authentication (G-2)

TOTP as in RFC 6238 (HMAC-SHA1, 30-second steps, 6 digits, one step of clock drift either way), so any
authenticator app works (Microsoft Authenticator, Google Authenticator, 1Password…).

- **Set up:** Account → Two-factor authentication → **Turn on**. The server makes a 160-bit secret
  and shows it as a QR code (drawn by the server with `qrcode-generator`, no external service) and as
  text. The first code from the app turns it on. The secret is stored encrypted with the
  installation's secret key (AES-256-GCM, `core/platform/secrets.ts`, the same key as the other
  secrets; back it up with the database). `auth.two_factor_enabled`.
- **Recovery codes:** 10 single-use codes (`xxxx-xxxx-xxxx-xxxx`, about 79 bits each), shown once,
  stored as SHA-256 hashes. A used code is removed in the same statement that checks it. New codes
  replace all old ones (`auth.two_factor_recovery_codes`).
- **Sign-in:** after the password, Google, an [OpenID Connect provider](OIDC_SIGN_IN.md) or an accepted
  invitation, a user with two-factor on gets
  no session but a second step: the answer is `{ "twoFactor": "verify" }` (Google, OpenID Connect and invitations
  redirect to `/login?twoFactor=1`) with a signed, httpOnly cookie (`cde_2fa`, path
  `/api/v1/auth/two-factor`, 10 minutes) naming the user. `POST /auth/two-factor/challenge/verify`
  with `code` or `recoveryCode` starts the session. A code is accepted once (the last used time step is
  stored), so a code seen over someone's shoulder cannot be replayed. The `auth.login` row records
  `twoFactor: "totp"` or `"recovery"`.
- **Turn off:** with a current code or a recovery code (`auth.two_factor_disabled`); not possible while
  the administrator requires it for the account.
- **Anonymising a user** ([data subject rights](DATA_SUBJECT_RIGHTS.md)) deletes their secret and
  recovery codes in the same transaction (`registerAnonymiseHook` in `auth/two-factor.ts`).
- **Lost phone:** a system administrator uses **Reset Two-Factor** on the user (Administration →
  Users): the secret and recovery codes are removed and the user's sessions end
  (`auth.two_factor_reset`, target: the user). Where it is required, the person sets it up again at
  the next sign-in.
- **Required:** "system administrators" or "all users". People it covers who have not set it up yet
  get `{ "twoFactor": "enrol" }` at their next sign-in: the sign-in page shows the QR code
  (`POST /auth/two-factor/challenge/enrol`), the first code turns it on, the recovery codes are shown,
  then the session starts. Sessions already open continue until they end. An invited person accepting
  an invitation while it is required for everyone sets it up the same way.

**Not affected:** API access tokens (MCP, scripts), OAuth access tokens of OpenCDE clients and the
in-process "Sor" assistant. They are issued by a signed-in user (who passed the second step) and
checked as before; a token's owner turning two-factor on or off does not change them. Revoke tokens
under Account → Access tokens and Account → Connected applications. API tokens cannot call the
two-factor or session routes (`core/security/token-scope.ts`).

## Sessions (G-4)

A browser session ends at whichever comes first:

- **absolute limit:** the set number of days after sign-in (default 14, as before), however active;
- **idle limit:** the set number of hours without a request (default 12; 0 turns it off). Use is
  recorded at most once a minute.

Lowering a limit applies to sessions already open. Ended sessions are refused at once and deleted;
the daily retention job (`privacy/retention.ts`, category `sessions` in the disposal record) deletes the rest, so no ended session
stays in the `tokens` table. API tokens keep their own expiry.

- **Changing the password** ends the user's other sessions (this one stays;
  `auth.password_changed.details.otherSessionsEnded`). A password set by an administrator ends all
  the user's sessions.
- **Sign out everywhere:** Account → Sessions ends every session of the user, this one included;
  a system administrator does it for someone under Administration → Users. `auth.sessions_ended`
  (`details.ended`, `byAdmin`).

## Password rules (G-5)

A new password (account, invitation, administrator, `ADMIN_PASSWORD` of the first start) must:

- have at least 10 characters;
- not be a common or breached password: `apps/server/assets/passwords/common-passwords.txt`, the
  50,000 most frequent passwords of at least 10 characters from SecLists'
  `xato-net-10-million-passwords-1000000.txt` (MIT; source, commit and licence in
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)), compared without regard to case. The list
  is bundled; no network is needed. Shorter entries are not kept because the length rule already
  refuses them;
- not contain the person's name or e-mail address (any part of 4 characters or more).

The provisioning password (`1234567890`, "change at first sign-in") can still be set by an
administrator; nobody can choose it as their own.

## API

| Route | Who |
|---|---|
| `GET /auth/two-factor/challenge`, `POST …/challenge/enrol`, `POST …/challenge/verify` | the second step (cookie) |
| `GET /auth/two-factor`, `POST …/setup`, `…/enable`, `…/disable`, `…/recovery-codes` | the signed-in user (browser session) |
| `GET /auth/sessions`, `POST /auth/sessions/end-all` | the signed-in user (browser session) |
| `GET/PUT /admin/sign-in-security`, `POST /admin/sign-in-security/unlock` | system administrators |
| `POST /admin/users/:id/sessions/end`, `DELETE /admin/users/:id/two-factor` | system administrators |

Tests: `apps/server/test/auth/sign-in-security.test.ts`; end to end `e2e/specs/sign-in-security.spec.ts`.
