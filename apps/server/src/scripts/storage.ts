/**
 * File storage administration (docs/onprem/object-storage.md). In the image:
 *   node apps/server/dist/scripts/storage.js <command>      (on-prem: sudo sitekeep storage <command>)
 * Development: npm run storage -w @sitekeep/server -- <command>
 *
 *   --to=s3|gcs                   (any command) the target driver, while CDE_STORAGE is still local
 *   check                         the configured storage: driver, location, write/read/list/delete probe
 *   migrate [--dry-run] [--verify=sha256|size] [--concurrency=N]
 *                                 copies DATA_DIR/storage to the bucket configured by CDE_STORAGE=s3|gcs
 *                                 (+ its variables); resumable; local files stay
 *   prune-local --yes [--dry-run] removes local files the migration verified and the bucket still has
 *   pull <dir> [--link-dest=<prev dir>]   copies the bucket into dir (backup)
 *   push <dir>                    uploads dir's files the bucket does not have (restore)
 *
 * The target is the storage the environment configures (the same variables as the server); migrate and
 * prune-local read the local files from DATA_DIR/storage. Exit code 1 when anything failed.
 */
import path from "node:path";
import { ObjectStorage } from "../core/platform/object-storage.js";
import { describeStorage, openStorage } from "../core/platform/storage-config.js";
import { migrateToObjectStorage, pruneLocal, pullObjects, pushObjects } from "../core/platform/storage-migrate.js";
import { LocalStorage } from "../core/platform/storage.js";

// Flags may stand anywhere (sitekeep storage --to=s3 migrate --dry-run); the first other word is the command.
const flags = new Map<string, string>();
const words: string[] = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1]!, m[2] ?? "1");
  else words.push(a);
}
const [cmd, ...args] = words;
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const log = (line: string) => console.log(line);

function usage(): never {
  console.error("Usage: storage [--to=s3|gcs] check | migrate [--dry-run] [--verify=sha256|size] [--concurrency=N] | prune-local --yes [--dry-run] | pull <dir> [--link-dest=<dir>] | push <dir>");
  process.exit(2);
}

// --to=s3|gcs: the target driver while the server (and its CDE_STORAGE) still uses the local disk.
const env = flags.get("to") ? { ...process.env, CDE_STORAGE: flags.get("to") } : process.env;

async function bucket(): Promise<ObjectStorage> {
  const s = await openStorage(dataDir, env, { cache: false });
  if (!(s instanceof ObjectStorage)) {
    console.error("CDE_STORAGE is local: set CDE_STORAGE=s3 or gcs (or pass --to=s3|gcs) and the bucket's variables first.");
    process.exit(2);
  }
  return s;
}

async function main(): Promise<number> {
  const manifestPath = path.join(dataDir, "storage-migration.jsonl");
  const concurrency = Number(flags.get("concurrency") ?? 4);
  switch (cmd) {
    case "check": {
      const s = await openStorage(dataDir, env, { cache: false });
      const p = await s.ping();
      log(`${describeStorage(s)}: write/read/list/delete probe OK, ping ${p.ms} ms`);
      return 0;
    }
    case "migrate": {
      const target = await bucket();
      const source = new LocalStorage(path.join(dataDir, "storage"));
      const dryRun = flags.has("dry-run");
      const verify = flags.get("verify") === "size" ? "size" : "sha256";
      log(`${dryRun ? "Dry run: " : ""}${source.root} → ${target.info().location} (verify ${verify}, ${concurrency} at a time)`);
      const r = await migrateToObjectStorage({ source, target, manifestPath, dryRun, verify, concurrency, log });
      log(`Local files: ${r.files} (${gb(r.bytes)}). Already in the bucket: ${r.alreadyThere}.`);
      if (dryRun) log(`Would copy: ${r.wouldCopy} (${gb(r.wouldCopyBytes)}).`);
      else log(`Copied and verified: ${r.copied} (${gb(r.copiedBytes)}). Manifest: ${manifestPath}`);
      if (r.failed.length) {
        log(`FAILED: ${r.failed.length} (run migrate again; it continues where it stopped)`);
        return 1;
      }
      if (!dryRun) log("Complete. Local files were NOT removed (prune-local --yes does that, after the switch).");
      return 0;
    }
    case "prune-local": {
      if (!flags.has("yes") && !flags.has("dry-run")) {
        console.error("prune-local deletes local files: add --yes (or --dry-run to see what it would delete).");
        return 2;
      }
      const target = await bucket();
      const source = new LocalStorage(path.join(dataDir, "storage"));
      const r = await pruneLocal({ source, target, manifestPath, dryRun: flags.has("dry-run"), log });
      log(`${flags.has("dry-run") ? "Would remove" : "Removed"}: ${r.removed} (${gb(r.removedBytes)}); kept (not verified in the bucket): ${r.kept + r.notInManifest}`);
      return r.kept ? 1 : 0;
    }
    case "pull": {
      if (!args[0]) usage();
      const target = await bucket();
      const r = await pullObjects({ target, dir: path.resolve(args[0]), linkDest: flags.get("link-dest"), concurrency, log });
      log(`Objects: ${r.objects} (${gb(r.bytes)}); downloaded ${r.downloaded}, linked ${r.linked}, unchanged ${r.kept}, failed ${r.failed}`);
      return r.failed ? 1 : 0;
    }
    case "push": {
      if (!args[0]) usage();
      const target = await bucket();
      const r = await pushObjects({ target, dir: path.resolve(args[0]), concurrency, log });
      log(`Files: ${r.files}; uploaded ${r.uploaded}, already there ${r.alreadyThere}, failed ${r.failed}`);
      return r.failed ? 1 : 0;
    }
    default:
      usage();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
