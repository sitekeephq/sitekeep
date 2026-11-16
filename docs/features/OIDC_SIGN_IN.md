# Sign in with OpenID Connect

Date: 16.11.2026. Issue #85, item G-3 (Community part). This document covers signing in to SiteKeep
with an organisation's identity provider over **OpenID Connect**: Microsoft Entra ID, Keycloak, Okta,
Google Workspace, Authentik and any other provider with discovery. [Sign in with Google](GOOGLE_SIGN_IN.md)
stays as it is (environment variables, one button). LDAP and SAML are not part of this.

Related: [sign-in security](SIGN_IN_SECURITY.md) (two-factor, locks, sessions),
[invitations](INVITATIONS.md), [privacy](PRIVACY.md) (each provider is an outbound connection),
[audit log](AUDIT_LOG.md).

---

## In short

| | |
|---|---|
| Where | **Administration → Sign-in Security → OpenID Connect Sign-in**: one or more providers |
| Flow | Authorization code with **PKCE (S256)**, `state` and `nonce`; confidential (client secret) or public clients |
| ID token | Signature against the provider's JWKS (cached one hour, downloaded again once when a token names an unknown key), `iss`, `aud` (and `azp` with several audiences), `exp`/`iat` (60 s tolerance), `nonce`. Algorithms: RS256/384/512, PS256/384/512, ES256/384/512, EdDSA, narrowed by the provider's `id_token_signing_alg_values_supported`; never `none` or HS* |
| Userinfo | Read only when the ID token has no e-mail claim; its `sub` must be the ID token's |
| Who gets in | An active account with the same e-mail address; an invited person (their open invitation is accepted); a new person only when **Create Accounts at First Sign-in** is on (off by default) |
| E-mail | Must be verified by the provider (`email_verified: true`) unless **Trust Unverified E-mail Addresses** is on; must be in the provider's allowed domains when it has a list |
| Two-factor | Applies after the provider as after a password; skipped only when **Trust the Provider's Multi-factor Sign-in** is on and the ID token's `amr` reports it |
| Privacy | Each provider is its own connection `oidc:<id>` in Privacy Centre → External Connections (purpose `giris:oidc`); switched off, its button disappears and every step is refused |
| Audit | `auth.oidc_login` (success), `auth.login_failed` (with `reason`, the address only as its hash), `auth.oidc_provider_created/updated/deleted` |
| Library | [`jose`](https://github.com/panva/jose) (MIT) for JWKS and JWT checks; the protocol steps are in `apps/server/src/auth/oidc.ts` |

---

## Settings of a provider

| Field | Meaning |
|---|---|
| Short Id | Lower-case letters, digits, hyphens (`entra`, `keycloak`). Part of the redirect URI and the connection id; cannot be changed |
| Display Name | Shown in the Privacy Centre and the provider list |
| Issuer URL | `https://…`; SiteKeep reads `<issuer>/.well-known/openid-configuration` and requires the document's `issuer` to be the same. `http://` only for `localhost` / `127.0.0.1` (development) |
| Client Id / Client Secret | From the provider. The secret is stored encrypted (AES-256-GCM with the installation key, `core/platform/secrets.ts`) and never shown again; leave it empty when editing to keep it. No secret: a public client (PKCE only) |
| Scopes | Default `openid email profile`; `openid` is always sent. Add `groups` (Keycloak, Okta) when the admin group is used |
| Button Label / Icon Colour | The sign-in page's button |
| Allowed E-mail Domains | Empty: any. Otherwise only these domains and their subdomains, for existing users too |
| Create Accounts at First Sign-in | Off: only existing users and invited people. On: a new person becomes a normal user of the **Company of New Accounts** |
| E-mail / Name / Groups Claim | Default `email`, `name`, `groups`. A dotted name reads a nested claim (`extension.mail`) |
| System Administrator Group | Off (empty) by default. When set, a person whose groups claim contains it becomes a system administrator at sign-in (`user.updated` with `isAdmin: true`). It is never taken away automatically: remove it under Administration → Users |
| Trust Unverified E-mail Addresses | Off by default. Turn on only when the organisation itself assigns the addresses (see Entra ID below) |
| Trust the Provider's Multi-factor Sign-in | Off by default. On: when `amr` contains `mfa`, or two methods of which one is not only knowledge (`pwd`+`otp`, `pwd`+`hwk`; not `pwd`+`kba`), SiteKeep does not ask for its own code |

**Test** reads the discovery document now and shows the issuer and the accepted algorithms.

The **redirect URI** to register at the provider is shown in the edit dialog:
`<public address>/api/v1/auth/oidc/<id>/callback`. The public address is `CDE_PUBLIC_URL`, else the
address the browser used (behind a proxy, with `CDE_TRUST_PROXY`).

---

## Who can sign in

| Situation | Result (`/login?authError=…`) |
|---|---|
| Active account with the same address (lower case) | Session, or the two-factor step; `auth.oidc_login` |
| Invited (pending) person with an open invitation | The newest open invitation is accepted (`invitation.accepted`, provider `oidc:<id>`), the account activated; `auth.oidc_login` with `invitation: true` |
| No account, creation off | `oidc_account_not_allowed` |
| No account, creation on | Account created (`user.created`, provider `oidc:<id>`) |
| Disabled account | `oidc_account_not_allowed` |
| `email_verified` not true and not trusted | `oidc_email_not_verified` |
| Address outside the allowed domains | `oidc_domain_not_allowed` |
| No e-mail claim (also not in userinfo) | `oidc_no_email` |
| State does not match the browser's flow cookie, or the cookie expired (10 minutes) | `oidc_invalid_state` |
| ID token invalid, token exchange refused, provider unreachable | `oidc_failed` |
| The person cancelled at the provider (`access_denied`) | `oidc_cancelled` |
| Provider turned off, its connection off, or all external connections off | `oidc_disabled` |

Every refusal after the provider answered writes `auth.login_failed` with `provider: "oidc:<id>"` and
`reason` (`email_not_verified`, `domain_not_allowed`, `no_account`, `no_open_invitation`,
`account_disabled`, `no_email`, or the protocol error such as `id_token_nonce`, `id_token_invalid`,
`token_http_400`). The address goes to the personal part of the log; the row keeps its hash
([audit log](AUDIT_LOG.md)).

---

## Flow

```text
/login                                    button per enabled provider (GET /auth/methods → oidc[])
  → GET /api/v1/auth/oidc/<id>/start      discovery (cached 1 h); state, nonce, PKCE verifier in an
                                          encrypted httpOnly cookie (cde_oidc, path /api/v1/auth/oidc, 10 min)
  → provider authorization endpoint       response_type=code, scope, state, nonce, code_challenge (S256)
  → GET /api/v1/auth/oidc/<id>/callback   state checked against the cookie
  → token endpoint                        code + code_verifier; client_secret_basic, or _post when only that is offered
  → JWKS                                  ID token signature, iss, aud/azp, exp, nonce
  → userinfo (only without e-mail claim)  same sub
  → users.email                           link by verified address / accept invitation / create
  → two-factor step or session            /login?twoFactor=1 or /
```

Code: `apps/server/src/auth/oidc.ts` (protocol), `auth/oidc-routes.ts` (routes, accounts),
`auth/oidc-settings.ts` (stored in `system_settings` key `auth.oidc.providers`; no table, no migration),
`packages/shared/src/platform/oidc.ts` (types and rules). Web: `features/admin/pages/AdminOidc.tsx`,
`features/auth/pages/Login.tsx`. Tests: `apps/server/test/auth/oidc.test.ts` with the local mock
provider `apps/server/test/helpers/mock-oidc.ts`; e2e `e2e/specs/oidc-sign-in.spec.ts` serves the same
mock on `127.0.0.1` (`e2e/support/oidc-provider.ts`).

---

## Example: Microsoft Entra ID

1. Entra admin centre → **App registrations → New registration**. Supported account types: this
   organisational directory only. Redirect URI (Web): the one SiteKeep shows,
   e.g. `https://cde.contoso.com/api/v1/auth/oidc/entra/callback`.
2. **Certificates & secrets → New client secret**; copy the value.
3. **Token configuration → Add optional claim → ID → `email`** (and `upn` if wanted). For the admin
   group: **Add groups claim** (security groups; the claim carries group object ids).
4. In SiteKeep:

| Field | Value |
|---|---|
| Short Id | `entra` |
| Issuer URL | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Client Id | Application (client) ID |
| Client Secret | the secret value |
| Scopes | `openid email profile` |
| E-mail Claim | `email`, or `preferred_username` when every user's UPN is their e-mail address |
| Allowed E-mail Domains | the tenant's verified domains, e.g. `contoso.com` |
| Trust Unverified E-mail Addresses | **on** — Entra ID does not send `email_verified`. Keep the domain list to the tenant's own verified domains so that an address cannot be claimed from outside |
| System Administrator Group | the group's object id (optional) |
| Trust the Provider's Multi-factor Sign-in | on if Conditional Access requires MFA (Entra sends `amr: ["pwd", "mfa"]`) |

Multi-tenant (`/common`, `/organizations`) issuers are not supported: the discovery document's
issuer contains `{tenantid}` and does not match.

## Example: Keycloak

1. Realm → **Clients → Create client**: OpenID Connect, client id `sitekeep`, **Client authentication
   on** (confidential), **Standard flow** on, everything else off. Valid redirect URIs: the one SiteKeep
   shows. Advanced → **Proof Key for Code Exchange Code Challenge Method: S256**.
2. **Credentials** tab: copy the client secret.
3. Optional admin group: **Client scopes → sitekeep-dedicated → Add mapper → Group Membership**, token
   claim name `groups`, *Full group path* off, *Add to ID token* on.
4. In SiteKeep:

| Field | Value |
|---|---|
| Short Id | `keycloak` |
| Issuer URL | `https://sso.contoso.com/realms/<realm>` |
| Client Id / Secret | `sitekeep` / the secret |
| Scopes | `openid email profile` |
| E-mail / Name / Groups Claim | `email` / `name` / `groups` |
| Trust Unverified E-mail Addresses | off — Keycloak sends `email_verified` (set users' e-mail as verified, or turn on "Verify email" in the realm) |
| System Administrator Group | e.g. `sitekeep-admins` (optional) |

Keycloak sends `amr` only with an authentication flow that sets it; without it the SiteKeep
two-factor step applies as usual.

## Other providers

- **Okta:** issuer `https://<org>.okta.com` (or a custom authorization server
  `https://<org>.okta.com/oauth2/default`); add the `groups` scope and a groups claim for the admin group.
- **Google Workspace:** issuer `https://accounts.google.com`, scopes `openid email profile`, allowed
  domain = the Workspace domain. (Google's own button from the environment keeps working too.)
- **Authentik:** issuer `https://auth.contoso.com/application/o/<slug>` (the trailing slash is removed).

---

## Notes

- The flow cookie is encrypted and authenticated with a key derived from the installation key; it is
  bound to the provider id and expires after 10 minutes. A state mismatch never reaches the provider.
- Requests to the provider have a 10-second timeout and do not follow redirects.
- Changing or deleting a provider clears its cached discovery document and keys. Deleting a provider
  keeps its accounts; its connection disappears from the Privacy Centre.
- Accounts created at sign-in get a random password: they sign in through the provider (an
  administrator can set a password under Administration → Users). An OIDC sign-in never changes an
  existing password.
- The administrator's two-factor rule (Administration → Sign-in Security) counts for OIDC sign-ins:
  "all" makes a person without two-factor enrol after the provider, unless the provider's MFA is trusted
  and asserted.
