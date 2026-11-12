# Contributing to SiteKeep

Thank you for helping. SiteKeep Community is an open, ISO 19650 based common data environment for
construction projects, licensed under the [AGPL-3.0](LICENSE).

## Before you start

- Look for an existing issue, or open one to discuss larger changes before writing code.
- Security problems are never reported in public issues: see [SECURITY.md](SECURITY.md).
- Contributions are accepted under a Contributor License Agreement (CLA). The CLA lets 7Dimensions OÜ
  offer SiteKeep Enterprise alongside the open Community edition. The CLA bot asks you to sign it on your
  first pull request.

## Set up

Node.js 22 or newer and npm.

```bash
npm ci
cp apps/server/.env.development.example apps/server/.env.development   # set the admin e-mail and password
npm run dev        # API on http://127.0.0.1:8787, web app on http://localhost:5173
```

The repository layout, dependency rules and module boundary are described in
docs/MIMARI.md and [docs/architecture/structure.md](docs/architecture/structure.md).

## Make a change

1. Branch from `main`.
2. Keep the change focused; one topic per pull request.
3. Add or update tests with the code (see [docs/architecture/testler.md](docs/architecture/testler.md)):
   unit tests for logic, end-to-end tests for screens.
4. User-facing text goes into the translation files, never into code
   ([docs/architecture/i18n.md](docs/architecture/i18n.md)). English and Turkish are both required.
5. Run the checks:

```bash
npm run typecheck
npm test
npm run build && npm run e2e
```

The Community edition must keep working without any Enterprise module; CI builds and tests it with
`SITEKEEP_MODULES=""`.

## Pull requests

- Describe what changes for the user and why; link the issue.
- CI must be green. A maintainer reviews every pull request.
- Commits are squashed or merged by maintainers; write clear commit messages.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
