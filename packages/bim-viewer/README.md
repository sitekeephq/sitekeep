# @7dimensions-project/bim-viewer

Shared BIM viewer engine, tools and React HUD for 7Dimensions products. It owns
the Three.js / That Open lifecycle, Fragments loading, selection, BCF-compatible
viewpoints, plan/walk navigation, sections, measurements, visibility and the
view cube. Product APIs, routing, authentication and branding stay in hosts.

## Install

```bash
npm install @7dimensions-project/bim-viewer
```

React is a peer dependency. The renderer dependencies are package-owned so the
viewer can be introduced into products that still contain a legacy That Open
stack. Aligned hosts deduplicate the same versions during installation.

Copy the fragments worker to the host's public directory:

```bash
node node_modules/@7dimensions/bim-viewer/scripts/copy-assets.mjs public
```

## React

```tsx
import { ViewerCanvas } from "@7dimensions-project/bim-viewer/react";
import "@7dimensions-project/bim-viewer/styles.css";

export function ModelViewer() {
  return (
    <ViewerCanvas
      workerUrl="/fragments-worker.mjs"
      onReady={(engine) => void engine.load("model", "/models/site.frag")}
      onSelectionChange={(selection) => console.log(selection)}
    />
  );
}
```

`extensions` add host-specific behavior without adding application dependencies
to the shared package:

```ts
import type { ViewerExtension } from "@7dimensions-project/bim-viewer";

export const issuePins: ViewerExtension = {
  id: "cde-issue-pins",
  activate({ engine }) {
    engine.setPins([]);
    return () => engine.setPins([]);
  },
};
```

Keep extension arrays referentially stable in React (module constants or
`useMemo`), because changing the array intentionally recreates the viewer.

## Core API

Use `ViewerEngine.create(container, options)` directly outside React. Always
call `dispose()` when the host unmounts. The root export also includes complete
package-owned viewpoint/section/measurement types and `rebaseViewpoint`.

## Viewer tools and HUD

```tsx
import { ViewerToolsHud, useViewerTools } from "@7dimensions-project/bim-viewer/react";
import { toolMoreItems } from "@7dimensions-project/bim-viewer/tools";
import "@7dimensions-project/bim-viewer/tools.css";

const viewerTools = useViewerTools(engine, {
  loaded: engine?.loadedIds ?? [],
  onFit: () => void engine?.fit(),
  storeyLoader: (modelId) => myApi.loadStoreys(modelId),
});

<ViewerToolsHud
  {...viewerTools}
  loaded={!!engine?.loadedIds.length}
  branding={<MyBrandMark />}
  aboutText="Viewer attribution and product information"
/>;
```

`PropertiesPanel` accepts a `classLabel` function for host localization.
`storeyLoader`, branding and about copy are optional; no product API or brand
module is imported by this package.

The `./tools` entry point exports `ViewerTools`, section/measurement/walk
controllers, pure storey/walk/shortcut helpers, viewpoint-extra serializers and
phone-menu descriptors. Generic 4D/5D simulation painting, cost heat maps and
canvas recording are exported from the same entry point; hosts provide schedule
and cost data.

## Assets and styles

`styles.css` contains the canvas base styles. `tools.css` contains the reusable
HUD/tool styles and uses host theme variables such as `--primary`, `--surface`,
`--text`, `--border`, `--radius` and `--shadow`.

The worker URL is configurable through `ViewerEngine.create(..., { workerUrl })`
or `<ViewerCanvas workerUrl="..." />`. The default is
`/fragments-worker.mjs`.

## Scan viewer and IoT

`ScanViewer` reads its LAS / güzergah assets from `configureScanAssets(base)`
(default `/scans`). IoT data comes from a live API only when the host sets one,
with `configureIotApi("https://…/iot")` or the `VITE_IOT_API` build variable;
otherwise the bundled `/iot-sample.json` is used without any network call.
A host with a dense survey (`IotProfile`: one row every 25 cm per year) sets it with
`configureIotProfile("/iot-profile.json")` or `VITE_IOT_PROFILE` (or serves it as
the API's `/profile`): every surveyed position then becomes a point in the list,
the points layer and the heatmap, and the km range chart draws all of them.
Without one nothing is requested and the sample's sensors are used.
(Until 0.3.1 the default was `http://localhost:8080/iot`; hosts that relied on
it must now configure it.)

## Boundaries

- Shared: renderer lifecycle, fragments, camera, selection, viewpoints,
  navigation, generic coloring, sections/measurement/visibility tools, HUD and
  extension contracts.
- 7D CDE: issue, clash, schedule, comparison and model-set workflows.
- OpenBIM: LAS scans, route models, IoT sensors, heatmaps and project data.
- Never import a consumer's API client, store, route or domain DTO here.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:e2e
npm run build
```

`npm test` is Vitest: units for tools, engine (stubbed That Open), React HUD,
scan / IoT and simulation painting.

`npm run test:e2e` starts the playground (`npm run playground`, a host wired
like the CDE Viewer page) and runs Playwright against real Fragments built from
the IFC fixtures in `e2e/fixtures/ifc` (`npm run fixtures` rebuilds them after a
Fragments upgrade). Specs check what is drawn (canvas pixels), not only engine
state: loading and federation, selection and properties, sections, measurements,
navigation (orbit / walk / plan), BCF viewpoints across a reload, comparison /
4D / clash colours, remount and extension lifecycle, and the scan viewer.

`section-performance.spec.ts` loads one building as three discipline models
(`scripts/build-discipline-frags.mjs`) and checks the section box with fills:
cut meshes hold only their real segments and frames stay close to frames
without a box. The viewer compacts That Open's fixed-size section buffers before
each frame (`src/tools/section-meshes.ts`); without it every cut line drew
100 000 instances and multi-discipline section boxes stalled.

Projects follow the CDE harness: `chromium` (desktop), `iphone` (iPhone 13 in
Chromium, `mobile-*.spec.ts`: "⋯ Diğer" menu, touch measuring, joystick,
bottom sheets, no sideways scroll) and `safari` (WebKit iPhone smoke, CI only;
locally `E2E_SAFARI=1`). `e2e/support/fixtures.ts` fails a test on page errors,
console errors, failed requests and WebGL context loss. Known viewer bugs are
kept as `test.fail` so a fix shows up as an unexpected pass.

```bash
npx playwright install chromium webkit
npm run test:e2e
npx playwright test -c e2e/playwright.config.ts --project=iphone
```
