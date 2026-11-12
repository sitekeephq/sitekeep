import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.resolve(process.argv[2] ?? "playground/public");

function copyAll(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    copyFileSync(path.join(from, name), path.join(to, name));
    console.log(`Copied ${path.relative(root, path.join(to, name))}`);
  }
}

copyAll(path.join(root, "e2e/fixtures/frags"), path.join(publicDir, "models"));
copyAll(path.join(root, "e2e/fixtures/scans"), path.join(publicDir, "scans"));
const iot = path.join(root, "e2e/fixtures/iot-sample.json");
if (existsSync(iot)) {
  copyFileSync(iot, path.join(publicDir, "iot-sample.json"));
  console.log("Copied iot-sample.json");
}
