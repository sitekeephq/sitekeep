# BCF-XML schemas and sample files (buildingSMART)

The `.xsd` files in this folder and the `.bcf` files in `../bcf-samples/` were copied **unmodified** from buildingSMART International's
[BCF-XML](https://github.com/buildingSMART/BCF-XML) repository (11.10.2026).

| Folder | Source |
|---|---|
| `2.1/` | `release_2_1` branch, `Schemas/` (markup, visinfo, version, project) |
| `3.0/` | `release_3_0` branch, `Schemas/` (all) |
| `../bcf-samples/v21-*.bcf` | `release_3_0` branch, `Test Cases/v2.1/…` (One part visible, user assignment) |
| `../bcf-samples/v30-*.bcf` | `release_3_0` branch, `Test Cases/v3.0/…` (Orthogonal camera, Related topics) |

Licence: © buildingSMART International Ltd., Creative Commons Attribution-NoDerivatives 4.0 International
(CC BY-ND 4.0), see `LICENSE-buildingSMART.txt` (the repository's `release_3_0/LICENSE` file). The `release_2_1` branch has
no separate licence file; the repository licence applies. The files are used only in tests, as verbatim copies.

The tests (`apps/server/test/bcf.test.ts`) validate the exported XML against these schemas. The validator is
`apps/server/test/xsd-lite.ts`: it implements the XSD subset used by the BCF schemas (sequence, choice, attributes,
patterns, lengths, numeric bounds, enumerations) and raises an error on any XSD construct it does not recognise.
