# Tests: unit, e2e and smoke

This document is binding. A new screen, a new route or a user-visible change is not
considered finished; it is not closed until the three layers below are written and run with Node.js 22.
For detailed commands and the branch flow see Development workflow,
for directory ownership [Repository structure](structure.md), for the Playwright setup the
[E2E guide](../../e2e/README.md).

Together the three show this: the paths that were written are not broken. Unwritten branches, Safari and
the developer's own database are outside this run. E2E uses an empty, isolated database.

## 1. When it is mandatory

Mandatory:

- A new page, tab, dialog or menu route.
- A change to saving, listing, calculation, approval, deletion or permissions on an existing screen.
- The pure rule the screen depends on (amount, quantity, validation, state transition).

Updating is enough, a new file is not required: if the screen already has unit, e2e and smoke tests,
add the new behaviour to those tests. A reason for skipping is written in the Pull Request body;
"we'll add it later" is not a reason.

Not mandatory:

- Only comments, documentation or a renaming invisible to users. The existing tests still run.
- A pure calculation without a screen. Its unit test is mandatory; e2e and smoke are added only if a page changed too.
- Google sign-in, Autodesk, live OpenCDE, the Office converter, SMTP and the AI provider.
  The E2E server switches these off. Their boundaries are covered by server tests or a deliberate integration environment.

## 2. Three layers

### 2.1 Unit

Pure rules and the storage contract. Screen size does not exist here.

| What | Where | Command |
|---|---|---|
| Money, quantity, validation, state | `packages/shared/test/` | `npm test -w @sitekeep/shared -- test/<file>.test.ts` |
| HTTP, permissions, database, error codes | `apps/server/test/<area>/` | `npm test -w @sitekeep/server -- test/<area>/<file>.test.ts` |
| Pure web helpers (parsing, formatting) | `apps/web/test/<area>/` | `npm test -w @sitekeep/web -- test/<area>/<file>.test.ts` |

A screen's unit tests cover at least:

- Valid input, expected result.
- Empty, invalid or boundary values. Rounding, for numbers.
- Permissions: the project administrator writes, a member reads, outsiders and anonymous users have no access. The server test covers this.

Server tests do not embed fixed Turkish text. Text comes via `msg("ns:key")`. Details:
[i18n](i18n.md).

### 2.2 E2E

The user's main path, against the production build, on Chromium desktop.

- File: `e2e/specs/<area>.spec.ts`. Do not use a name starting with `mobile-`; that name goes to the phone project.
- Selectors are roles, labels and visible Turkish text (`getByRole`, `getByLabel`, `getByText`).
- The browser clicks through the path. Expensive setup may use the isolated API; the behaviour under test is not replaced by the API.
- No live, shared or customer data is used.

A screen's desktop e2e file passes through at least the following once:

1. Empty screen text.
2. Create, see it in the list, open the details.
3. An invalid record is rejected and the error stays on screen.
4. Save; the expected amount or state appears.
5. If present, approval, export or deletion. After deletion the list returns to the empty state.

Command, build first:

```bash
npm run build
npm run e2e -- e2e/specs/<area>.spec.ts
```

`e2e` uses the existing `apps/server/dist` and `apps/web/dist`. Running without building tests the old screen.

### 2.3 Smoke and mobile

Smoke checks that the page opens and roughly fits on a phone. It does not fill in forms.
There is no pixel comparison. A screenshot is written only when the test fails.

A new route is added to the `ROUTES` list in `e2e/specs/mobile-smoke.spec.ts`.
The run checks: the project menu is clicked, `.sidenav-current` shows that page's name,
and the page does not scroll horizontally. On a page with a name, such as a contract, the title must also be visible.

The main buttons at phone size are in a separate file: `e2e/specs/mobile-<area>.spec.ts`.
The iPhone 13 Chromium project runs only `mobile-*.spec.ts` files.
This file passes through at least:

- The page and the create dialog do not scroll horizontally (`scrollWidth` does not exceed the window by more than 1 pixel).
- Tabs and the primary save button can be clicked.
- After filling in a field and saving, the result appears on screen.

```bash
npm run e2e -- e2e/specs/mobile-<area>.spec.ts
npm run e2e -- e2e/specs/mobile-smoke.spec.ts
```

Safari / WebKit is off locally. CI runs it. To enable it locally: `E2E_SAFARI=1 npm run e2e -- --project=safari`.

## 3. New screen checklist

Before the work is closed:

```text
[ ] Unit: correct result, empty/invalid input, permissions (shared and/or server and/or web).
[ ] Desktop e2e: empty screen, create, invalid record, save, delete if present.
[ ] mobile-smoke ROUTES: new route, menu name, no horizontal overflow.
[ ] mobile-<area>.spec.ts: dialog fits, main button saves, result visible.
[ ] These files ran and passed with Node 22.
[ ] npm test (relevant workspace) and npm run e2e for the changed spec passed.
```

The three show that the paths written for that screen are not broken. The developer also opens the page
once on a phone with their own project data. E2E does not see that data.

## 4. Running

If the default Node is 16, `tsc` breaks. Put Node 22 first in the shell, then run the commands.

```bash
npm test
npm run typecheck
npm run build
npm run e2e
```

A single file, without waiting for the whole repository:

```bash
npm test -w @sitekeep/shared -- test/<file>.test.ts
npm test -w @sitekeep/server -- test/<area>/<file>.test.ts
npm test -w @sitekeep/web -- test/<area>/<file>.test.ts
npm run e2e -- e2e/specs/<area>.spec.ts
```

The full e2e run comes after `npm run build`. If the port is taken, set `E2E_PORT` to a free port.
The default is `18080`.
