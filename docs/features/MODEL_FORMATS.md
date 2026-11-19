# Model formats other than IFC

The model viewer, the element index ("Modele sor", model queries, quantities) and version comparison all
work on IFC. A module can add another model format by converting it to IFC on the server: the version is
converted first, then everything else runs exactly as for an IFC upload.

Today: **SiteKeep Connect converts Revit `.rvt`** with [rvt-rs](https://github.com/DrunkOnJava/rvt-rs)
(Apache-2.0, no Autodesk software, nothing leaves the server). See [Connect](../modules/connect.md#revit-models).
Without Connect (SiteKeep Community, or a lapsed licence) an `.rvt` stays a plain file: stored, versioned,
reviewed, no 3D view.

## How it works

```text
upload X.rvt ─► isModelFile(name)?  ── no ──► plain file (derivativeStatus "none")
                     │ yes (a module that is on lists "rvt")
                     ▼
     ifc_to_frag job: module.toIfc(stored file, temp.ifc) ─► IFC worker (Fragments + element index)
                     ▼
     version: derivativeStatus "ready", ifcSummary.source = { format, tool, sourceVersion, approximated, hidden, support },
              ifc_key (the converted IFC, kept), converter ("rvt-rs 0.25.0")
```

| Part | Where |
|---|---|
| Registry: `modelFormatFor`, `isModelFile`, the resolver over the modules that are on | `apps/server/src/files/model-formats.ts` (set in `app/modules.ts`) |
| Module contract: `ServerModule.modelFormats` (`ModelFormat`, `ModelSourceInfo` in the SDK, 0.17.0; `ModelFormat.version` 0.18.0) | `apps/server/src/sdk/module.ts` |
| Conversion before the IFC worker (also for index backfill and in-place rebuilds) | `JobQueue.ifcInput`, `apps/server/src/jobs/queue.ts` |
| Viewer table: `registerModelExtension`, `modelExtensions()` | `packages/shared/src/viewers/viewers.ts` |
| Web: `WebModule.modelExtensions` (registered when the module is turned on) | `apps/web/src/sdk/module.ts` |
| File panel note "Converted automatically from RVT 2024 (rvt-rs 0.25.0)" | `FileDrawer.tsx` (`ModelSourceNote`) |
| Stored versions converted at start-up | `queueModelBackfill`, `apps/server/src/files/model-backfill.ts` (`index.ts`) |
| Converted again after a converter update, failed versions retried once | `queueModelReconversion`, same file |
| "Convert again" (version, failed models of a project), IFC download | `files.ts`: `POST …/versions/:vid/convert-again`, `POST …/model-conversions/retry-failed`, `GET …/versions/:vid/ifc` |
| Tests | `apps/server/test/viewers/model-formats.test.ts`, `model-reconvert.test.ts` |

**Files stored before** (an `.rvt` uploaded before Connect 0.5.0, or while Connect was off): at start-up
`queueModelBackfill` (`apps/server/src/files/model-backfill.ts`) marks every such version without a derivative
(`derivativeStatus` "none") as "pending" and queues its conversion; the queue works through them one at a time.

**The converted IFC is kept** in storage next to the viewer derivative (`file_versions.ifc_key`, never in the API;
the version DTO only says `ifcAvailable`). People with download permission download it from the file panel
("Download IFC", `GET /projects/:pid/versions/:vid/ifc`, audited as `file.downloaded` with `format: "ifc"`). An index
backfill or a rebuild of an older derivative reads the kept IFC instead of converting again; it is removed with the
version (recycle bin purge), unless a copied version still uses it.

**Converting again.** Each conversion records its converter (`file_versions.converter`, the same text as
`ifcSummary.source.tool`, e.g. "rvt-rs 0.25.0"), also when it fails. A module that reports its installed converter
(`ModelFormat.version()`) gets at start-up, after the backfill (`queueModelReconversion`):

- ready models whose converter differs from the installed one (or was never recorded) converted again in place: the
  old model stays open until the new one replaces it, the element index is rebuilt;
- failed versions retried, **once per converter version**: the installed converter is written when the version is
  queued, so a version that fails again waits for the next converter version (no endless retries, no double queueing
  on a restart or a second server).

Current versions are queued first, then older ones, newest first (as in the backfill). Project administrators can
also convert one version again ("Convert again" in the file panel, `POST …/versions/:vid/convert-again`, audit
`file.model_reconverted`) or every failed model of the project (`POST /projects/:pid/model-conversions/retry-failed`,
audit `file.model_retry_failed`); refused while the version is already being converted.

## Rules for a converter

- Throw an `Error` with a message for people when the file cannot be read; the version shows it as the model
  error (`derivativeError`).
- Respect `timeoutMs` (the job's limit) and run external programs as separate processes.
- Report what was approximated (`approximated`) and what was left out of the view (`hidden`), and the support
  level of the source release (`support`), so the file panel can say how far the model can be trusted.

## What a converted model does

Works like an IFC: model viewer, "Modele sor" and model queries (`model/service.ts` `ifcVersion`), version
comparison (`docCompareKind` maps the registered extensions to "ifc"), model markups, the models report dataset.

## Status (18.11.2026)

Released with Connect 0.5.1 and rvt-rs 0.25.0. Tried on Autodesk's sample projects (Revit 2022–2027) and on 56 real
project files saved with Revit 2027: 54 open; structure and MEP come with real shapes, architecture partly as
boxes; two MEP files give no element (Revit 2027 is "experimental" in rvt-rs).

End-to-end test with the real converter: `e2e/specs/revit-model.spec.ts` (skipped unless `RVT_SAMPLE` and
`SITEKEEP_RVT_IFC_PATH` are set; Connect must be installed).

## Open work

In order of priority.

| # | Work | Why | Notes |
|---|---|---|---|
| 3 | **Model sets / clash, IDS, quantities, 4D/5D for converted models** | They read the IFC file itself, so they refuse `.rvt` (`isIfc` in coordination, `visibleVersion` / `visibleIfcFile` in `model/versions.ts`, `ids.ts`). | The converted IFC is now kept (`file_versions.ifc_key`): most only need to read it instead of the upload. Parameter changes stay IFC-only: they write the IFC (the file panel hides the button for converted models). |
| 4 | **Test Autodesk / ACC imports of `.rvt`** | Connect's file import adds versions through the core, so they should convert like uploads; not tested. | A Connect test with a fake APS download of an `.rvt`. |
| 7 | **Product page** | sitekeep.org (Odoo) does not list "open Revit files without Autodesk" under Connect. | For the site owner (issue #130 lists the site's other items). |

Not planned: `.rfa` families (rvt-rs gives metadata and previews only), Revit in SiteKeep Community (the converter
ships with Connect, in the Enterprise image).

Done since the first release: current versions are queued first in the start-up backfill (PR #135); converting
again when the converter changes and retrying failed versions once per converter version (#1), "Download IFC" (#2),
on-prem documentation ([Revit models](../onprem/docker-compose.md#revit-models-enterprise), #5) and the rvt-rs
update procedure (internal, #6). Items 1 and 2 need the Connect release that reports its converter version
(`ModelFormat.version`, SDK 0.18.0); without it the IFC is kept and downloadable, but nothing is converted again
on its own.
