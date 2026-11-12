# SiteKeep — load and stress tests (k6)

`cde.js` simulates a realistic user mix: browsing folders, searching, identity checks and optional uploads. The profiles and thresholds are defined at the top of the file. Design and targets: `docs/planning/GUVENLIK_UYUM_VE_STRES_TESTI.md` §3.

## Preparation
1. **Environment:** a **separate test server** similar to production. PostgreSQL, not PGlite; the same CPU, RAM and disk. The `stress`, `spike` and `soak` profiles are **never run against production**.
2. **Data:** realistic volume, e.g. 50 projects, 100k files, 500 IFC files. Generated with the developer tools (`cde_dev_seed`) or the demo importer. Customer data is not used.
3. **Token:** get a **read-only** token for the test user from My Account → API Access Tokens. `UPLOAD=1` needs a read + write token and a test folder. Do not write the token to a file; pass it as an environment variable.
4. **Installation:** k6 ([k6.io](https://k6.io), open source, AGPL; runs as a separate program).

## Running
```bash
k6 run -e CDE_URL=https://staging.ornek -e CDE_TOKEN=$CDE_TOKEN -e CDE_PROJECT=PKF-DEMO -e PROFILE=smoke load/k6/cde.js
```

| Profile | What it does |
|---|---|
| `smoke` | 2 users, 1 min: do the script and environment work (on every PR) |
| `load` | 200 concurrent users, 30 min: expected load |
| `stress` | 200 → 1200 users: breaking point and how it degrades |
| `spike` | 20 → 500 sudden increase: morning logins |
| `soak` | 100 users, 8 hours: memory and connection leaks |

Additional variables:
- `UPLOAD=1`: 5% of requests make a 256 KB upload.
- `WIP_FOLDER=<folder id>`: upload target.
- `SEARCH_TERMS=a,b,c`: search terms.

## Results
- Each run is written to `load/k6/results/<profile>-<time>.json` (outside git).
- If thresholds are exceeded, k6 exits with an error code; in CI the step turns red.
- For the report, use the template in `docs/planning/GUVENLIK_UYUM_VE_STRES_TESTI.md` §3.6.
- The server side should also be monitored during the test: CPU, RAM, disk I/O, database connections, slow queries, job queue backlog (IFC → Fragments, DWG, preview).

## Scenarios to add later
- Large file uploads (300 MB IFC, 170 MB DXF) and conversion time.
- Opening models and drawings (Fragments and 2D scene download).
- Review/approval workflow, form filling, dashboard queries.
- OpenCDE Documents API upload (AEC Pilot flow).
- AI requests: measured separately, GPU-dependent.
- Browser side: page load times with the existing Playwright tests.
