# Sign in with Google

Date: 22.10.2026. This document covers the **CDE session**: **Continue with Google**
on `/login`. OpenCDE / Administration → OAuth Applications is a different
surface: [OpenCDE](OPENCDE.md). Outbound call: [Privacy](PRIVACY.md)
(`giris:google`). Architecture contract: [Repository structure](../architecture/structure.md) §7.1.
The three local lines: [Local sign-in with Google](../onboarding/GOOGLE_SIGN_IN.md).

Secrets (client ID, client secret) are not written in this document.

---

## Today (22.10.2026)

Google verifies the email. By default it does **not create** a CDE account. If Administration →
Users → **Allowed Domain** is on, a new person from a domain in the list
is created as a normal user.

| In place | What | Real? |
|---|---|---|
| `/login` button | Visible when all three `GOOGLE_*` are set | yes |
| `GET /api/v1/auth/methods` | `{ password, google }` | yes |
| Registered + active user | exact email match (lower case) | yes |
| `email_verified` | rejected if Google has not verified it | yes |
| `state` cookie | CSRF; `invalid_state` on mismatch | yes |
| Allowed domain | Administration switch + domain list; the new user is not an administrator | yes |
| Production VM `app.env` | `GOOGLE_*` on `sitekeep.ornek.com` | yes (22.10.2026) |

If the client is in **Testing** on the Google Cloud side, only the Consent Screen →
**Test users** list gets through. Being a CDE user is not enough; Google may also
refuse.

---

## Who can sign in

| Situation | Result |
|---|---|
| The same email exists in the CDE, active | Session; `auth.login` (`provider: google`) |
| Not in the CDE, allowed domain off or no match | `account_not_allowed` — "This Google account has no access to SiteKeep." |
| Not in the CDE, allowed domain on and matches | User is created (`isAdmin: false`); session |
| In the CDE, disabled (`disabled`) | Same message |
| Google has not verified the email | `email_not_verified` |
| The three env variables are missing | No button; `/auth/google` 404 |

`admin@7d-cde.localhost` is not a Google account. If the allowed domain is off,
the person is first added under **Administration → Users**.

The setting is the `system_settings` key `auth.google`. Off by default, empty
list. A subdomain (`mail.7dimensions.eu`) matches the parent domain; `not7dimensions.eu`
does not. SSO / Entra is the long-term version of the same model.

---

## Flow

```text
/login
  → GET /api/v1/auth/methods          google: true when all three env variables are set
  → GET /api/v1/auth/google           state cookie; redirect to Google
  → accounts.google.com               openid email profile; select_account
  → GET /api/v1/auth/google/callback  code + state
  → oauth2.googleapis.com/token       outbound giris:google
  → userinfo                          email (+ name)
  → users.email                       if absent: allowed domain → new user
  → disabled / domain mismatch        login?authError=account_not_allowed
  → session cookie                    /
```

Code: `apps/server/src/auth/routes.ts`, `auth/google-settings.ts`,
`googleAuthFromEnv()` (`index.ts`). Web: `Login.tsx`, Administration card
`Admin.tsx`. Test: `apps/server/test/auth/google-auth.test.ts`,
`packages/shared/test/google-auth.test.ts`.

Because of Vite's `/api` proxy, the callback is the browser address, not the server's
`:8787`:

- local: `http://localhost:5173/api/v1/auth/google/callback`
- production: `https://sitekeep.ornek.com/api/v1/auth/google/callback`

Both origins + both callbacks are registered on the same Web client.
`gcloud auth login` is not an OAuth Web client.

---

## Environment

All three are required. If any one is empty, Google sign-in is off.

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
```

The names are in `.env.example` and `apps/server/.env.development.example`.
Values never go into git. `npm run dev` does not always re-read env changes;
restart the server.

---

## Sign-in errors

| `authError` | Shown to the user |
|---|---|
| `account_not_allowed` | This Google account has no access to SiteKeep. |
| `google_cancelled` | Signing in with Google was cancelled. |
| other (`email_not_verified`, `invalid_state`, `google_failed`) | Signing in with Google could not be completed. Please try again. |

---

## Going live

1. **Production.** VM `/opt/7d-cde/app.env` has the three `GOOGLE_*` + the production callback
   (22.10.2026). Allowed domain `7dimensions.eu` is on. Consent is still in Testing.
2. **Consent in Production.** The test list goes away; brand verification depends on Google's
   threshold.
3. **OIDC / Entra.** The same "provider + registered email / allowed domain"
   model; Google remains one provider.

If a secret has appeared in a chat or a screenshot, it is rotated in Google Cloud.
