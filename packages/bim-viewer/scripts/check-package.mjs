/**
 * Package contract check: packs the package as it would be published, installs the tarball into a
 * throw-away consumer and checks what hosts rely on — every `exports` target is in the tarball,
 * the imports 7D CDE uses (and the README examples) typecheck against the packed .d.ts files, the
 * copy-assets script copies the Fragments worker, and no source / test folders are shipped.
 * Run after `npm run build` (npm pack runs it again through prepack).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const work = mkdtempSync(path.join(tmpdir(), "bim-viewer-pack-"));
const consumer = path.join(work, "consumer");
const failures = [];
const fail = (message) => failures.push(message);

try {
  // 1. Pack and unpack like `npm install <tarball>`.
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" }));
  const files = packed.files.map((f) => f.path);
  const installed = path.join(consumer, "node_modules", "@7dimensions-project", "bim-viewer");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(work, packed.filename), "-C", installed, "--strip-components=1"]);
  console.log(`packed ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(0)} KiB`);

  // 2. Nothing but the build, the styles and the asset script.
  for (const file of files) {
    if (/^(src|tests|e2e|playground|coverage)\//.test(file)) fail(`ships ${file}`);
  }

  // 3. Every exports target exists in the tarball.
  for (const [entry, target] of Object.entries(pkg.exports)) {
    const targets = typeof target === "string" ? [target] : Object.values(target);
    for (const t of targets) if (!existsSync(path.join(installed, t))) fail(`exports["${entry}"] → ${t} is missing`);
  }

  // 4. The consumer resolves the package's own dependencies from this repository.
  const modules = path.join(consumer, "node_modules");
  for (const name of readdirSync(path.join(root, "node_modules"))) {
    if (name.startsWith(".") || name === "@7dimensions-project") continue;
    symlinkSync(path.join(root, "node_modules", name), path.join(modules, name));
  }

  // 5. What hosts import typechecks against the packed declarations.
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["consumer.tsx"],
    }),
  );
  writeFileSync(
    path.join(consumer, "consumer.tsx"),
    `// The 7D CDE web app's imports (apps/web) and the README examples.
import { CLASH_COLORS, COMPARE_COLORS, ViewerEngine, rebaseViewpoint, type IssueViewpoint, type SelectedItem, type ViewerExtension } from "@7dimensions-project/bim-viewer";
import { PropertiesPanel, ScanViewer, ViewerCanvas, ViewerToolsHud, useViewerTools } from "@7dimensions-project/bim-viewer/react";
import {
  COST_RAMP,
  GuidCache,
  SIM_GHOST,
  SIM_LATE,
  SIM_PALETTE,
  clearSim,
  downloadBlob,
  isToolMoreKey,
  paintCost,
  paintSim,
  recordCanvas,
  toolMoreItems,
} from "@7dimensions-project/bim-viewer/tools";
import { configureIotApi, configureScanAssets } from "@7dimensions-project/bim-viewer/scan";
import "@7dimensions-project/bim-viewer/styles.css";
import "@7dimensions-project/bim-viewer/tools.css";

export const issuePins: ViewerExtension = {
  id: "cde-issue-pins",
  activate({ engine }) {
    engine.setPins([]);
    return () => engine.setPins([]);
  },
};

export async function open(container: HTMLElement, viewpoint: IssueViewpoint): Promise<SelectedItem | null> {
  const engine = await ViewerEngine.create(container, { workerUrl: "/fragments-worker.mjs" });
  await engine.load("model", "/models/site.frag");
  await engine.align("model");
  await engine.applyViewpoint(rebaseViewpoint(viewpoint, [0, 0, 0]));
  await engine.showClash({ a: { modelId: "model", globalId: "a" }, b: { modelId: "model", globalId: "b" } });
  const saved: IssueViewpoint = await engine.viewpoint();
  void saved;
  let picked: SelectedItem | null = null;
  engine.onSelect = (item) => (picked = item);
  engine.dispose();
  return picked;
}

export function Hud({ engine }: { engine: ViewerEngine | null }) {
  const tools = useViewerTools(engine, { loaded: engine?.loadedIds ?? [], onFit: () => void engine?.fit() });
  const menu = toolMoreItems(tools.state).filter((item) => isToolMoreKey(item.key));
  return (
    <>
      <ViewerCanvas workerUrl="/fragments-worker.mjs" extensions={[issuePins]} onReady={(e) => void e.fit()} />
      <ViewerToolsHud {...tools} loaded={menu.length > 0} aboutText="About" />
      <ScanViewer fragmentRoutes={["/models/a.frag"]} />
    </>
  );
}

export const Props = (selected: SelectedItem) => <PropertiesPanel selected={selected} onClose={() => undefined} />;
export const used = [CLASH_COLORS.a, COMPARE_COLORS.added, COST_RAMP, GuidCache, SIM_GHOST, SIM_LATE, SIM_PALETTE, clearSim, downloadBlob, paintCost, paintSim, recordCanvas];
configureScanAssets("/scans");
configureIotApi(null);
`,
  );
  try {
    execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", consumer], { cwd: consumer, encoding: "utf8" });
  } catch (error) {
    fail(`consumer typecheck failed:\n${error.stdout || error.message}`);
  }

  // 6. copy-assets copies the version-matched Fragments worker, as hosts run it.
  execFileSync(process.execPath, [path.join(installed, "scripts/copy-assets.mjs"), "public"], { cwd: consumer, encoding: "utf8" });
  if (!existsSync(path.join(consumer, "public/fragments-worker.mjs"))) fail("copy-assets did not copy fragments-worker.mjs");
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`package check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("package check passed");
