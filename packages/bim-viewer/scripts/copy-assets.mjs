import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const packageDist = path.dirname(require.resolve("@thatopen/fragments"));
const source = path.join(packageDist, "Worker", "worker.mjs");
const publicDirectory = path.resolve(process.argv[2] ?? "public");
const destination = path.join(publicDirectory, "fragments-worker.mjs");

mkdirSync(publicDirectory, { recursive: true });
copyFileSync(source, destination);
console.log(`Fragments worker copied to ${destination}`);
