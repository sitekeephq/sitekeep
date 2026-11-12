# Local Google sign-in

Date: 22.10.2026. This page is for enabling the **Continue with Google**
button on a development machine. Product rules (who can sign in, errors, the remaining allowed
domain): [Google sign-in](../features/GOOGLE_SIGN_IN.md).

Secrets are not committed and are not written into this file.

## 1. Three environment variables

`apps/server/.env.development` (outside git):

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:5173/api/v1/auth/google/callback
```

All three must be set. The names are in `.env.development.example`.

Google Cloud → Google Auth Platform → Clients: type **Web**. Authorized
JavaScript origins: `http://localhost:5173` and, for production,
`https://sitekeep.ornek.com`. Callbacks:

- `http://localhost:5173/api/v1/auth/google/callback`
- `https://sitekeep.ornek.com/api/v1/auth/google/callback`

`gcloud auth login` is not enough; a Web OAuth client is required.

## 2. Restart the server

`tsx watch` does not always pick up env changes. Stop the running `npm run dev`
process and start it again. Check:

```bash
curl -sS http://127.0.0.1:8787/api/v1/auth/methods
```

Expected: `"google":true`. Then hard-refresh `http://localhost:5173/login`.

## 3. CDE user or allowed domain

One of two ways:

- The email is an active record under **Administration → Users**; or
- **Allowed Domain** is on and the email is from a domain in the list (e.g.
  `7dimensions.eu`). A new person does not become an administrator.

Otherwise: "This Google account has no access to SiteKeep."
`admin@7d-cde.localhost` does not sign in with Google.

If the consent screen is in **Testing**, the same email must also be in the Google → Test users
list. Otherwise the rejection comes from Google, not from the CDE.

## 4. Production

A separate task. VM `/opt/7d-cde/.env` and a restart; Production environment.
The local `.env.development` is not copied to production.
