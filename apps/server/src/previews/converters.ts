/**
 * External converters run as separate processes (never linked):
 * - LibreOffice (MPL-2.0) headless: office files → PDF, optional last-resort converter (office files
 *   are viewed in the browser; see office/converters.ts for ONLYOFFICE / Collabora / Gotenberg)
 * - LibreDWG dwg2dxf (GPL-3.0): DWG → DXF
 *
 * Paths: CDE_SOFFICE_PATH / CDE_DWG2DXF_PATH, else common install paths, else PATH.
 * One conversion at a time, each in its own temp directory (LibreOffice also gets its own user
 * profile there, so a running desktop LibreOffice or a stale lock does not block it).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConverterStatusDto, ConvertersDto } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** Converter texts are stored with the preview (its error) and shown later: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

export const SOFFICE_HINT = t("previews:converter.sofficeHint");
export const DWG2DXF_HINT = t("previews:converter.dwg2dxfHint");

/** The converter binary is not installed: the preview becomes "unavailable", not "failed". */
export class ConverterUnavailableError extends Error {
  constructor(readonly hint: string) {
    super(hint);
  }
}

export class ConverterTimeoutError extends Error {}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Lines with "ERROR" over the whole stderr (stderr itself is kept only up to 20 000 characters). */
  errorLines?: number;
}

/** "ERROR" lines in a text (LibreDWG writes one per object it cannot read). */
export function countErrorLines(s: string): number {
  return s.match(/^.*ERROR.*$/gm)?.length ?? 0;
}

/** Oldest LibreDWG whose DXF output is clean: 0.13 breaks MTEXT values over lines (repaired, see repairDxfFile). */
export const DWG2DXF_MIN_VERSION = [0, 14] as const;

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs a process; injectable so tests do not need LibreOffice or LibreDWG. */
export type ProcessRunner = (command: string, args: string[], opts: RunOptions) => Promise<RunResult>;

export interface ConvertersOptions {
  sofficePath?: string | null;
  dwg2dxfPath?: string | null;
  runner?: ProcessRunner;
  /** Max time for one conversion (default 180 s, CDE_CONVERT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Parent of the per-conversion temp directories (default os.tmpdir()). */
  tmpDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Admin warnings (old dwg2dxf); default console.warn. */
  warn?: (msg: string) => void;
}

type Found = { path: string; source: "env" | "auto" | "path" } | null;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) if (isFile(path.join(d, n))) return path.join(d, n);
  return null;
}

/** Finds soffice: CDE_SOFFICE_PATH, known install paths (Windows, Linux, macOS), PATH. */
export function findSoffice(env: NodeJS.ProcessEnv = process.env): Found {
  const fromEnv = env.CDE_SOFFICE_PATH?.trim();
  if (fromEnv) return isFile(fromEnv) ? { path: fromEnv, source: "env" } : null;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"]) {
      if (base) candidates.push(path.join(base, "LibreOffice", "program", "soffice.exe"));
    }
  } else {
    candidates.push(
      "/usr/bin/soffice",
      "/usr/lib/libreoffice/program/soffice",
      "/usr/local/bin/soffice",
      "/snap/bin/libreoffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    );
    // Official .deb/.rpm builds install to /opt/libreofficeX.Y.
    try {
      for (const d of readdirSync("/opt")) if (d.startsWith("libreoffice")) candidates.push(`/opt/${d}/program/soffice`);
    } catch {
      /* no /opt */
    }
  }
  const auto = candidates.find(isFile);
  if (auto) return { path: auto, source: "auto" };
  const p = onPath(process.platform === "win32" ? ["soffice.exe", "soffice.com"] : ["soffice", "libreoffice"], env);
  return p ? { path: p, source: "path" } : null;
}

/** Finds dwg2dxf: CDE_DWG2DXF_PATH, known install paths, PATH. */
export function findDwg2dxf(env: NodeJS.ProcessEnv = process.env): Found {
  const fromEnv = env.CDE_DWG2DXF_PATH?.trim();
  if (fromEnv) return isFile(fromEnv) ? { path: fromEnv, source: "env" } : null;
  const candidates =
    process.platform === "win32"
      ? [env.ProgramFiles, "C:\\Program Files"].filter(Boolean).map((b) => path.join(b!, "LibreDWG", "dwg2dxf.exe"))
      : ["/usr/local/bin/dwg2dxf", "/usr/bin/dwg2dxf", "/opt/libredwg/bin/dwg2dxf"];
  const auto = candidates.find(isFile);
  if (auto) return { path: auto, source: "auto" };
  const p = onPath(process.platform === "win32" ? ["dwg2dxf.exe"] : ["dwg2dxf"], env);
  return p ? { path: p, source: "path" } : null;
}

/** Default runner: spawn without a shell, kill the whole process tree on timeout. */
export const spawnRunner: ProcessRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      // Own process group on POSIX so soffice.bin dies with soffice.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let errorLines = 0;
    let carry = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 20_000) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (stderr.length < 20_000) stderr += text;
      const lines = (carry + text).split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const l of lines) if (l.includes("ERROR")) errorLines++;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new ConverterTimeoutError(t("previews:converter.timeout")));
      else resolve({ code, stdout, stderr, errorLines: errorLines + (carry.includes("ERROR") ? 1 : 0) });
    });
  });

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export class Converters {
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ConvertersOptions = {}) {
    this.runner = opts.runner ?? spawnRunner;
    this.env = opts.env ?? process.env;
    this.timeoutMs = opts.timeoutMs ?? (Number(this.env.CDE_CONVERT_TIMEOUT_MS) || 180_000);
  }

  private soffice(): Found {
    if (this.opts.sofficePath !== undefined) return this.opts.sofficePath ? { path: this.opts.sofficePath, source: "env" } : null;
    return findSoffice(this.env);
  }

  private dwg2dxf(): Found {
    if (this.opts.dwg2dxfPath !== undefined) return this.opts.dwg2dxfPath ? { path: this.opts.dwg2dxfPath, source: "env" } : null;
    return findDwg2dxf(this.env);
  }

  status(): ConvertersDto {
    const one = (f: Found, hint: string): ConverterStatusDto => ({
      available: !!f,
      path: f?.path ?? null,
      source: f?.source ?? null,
      hint: f ? "Kurulu." : hint,
    });
    return { soffice: one(this.soffice(), SOFFICE_HINT), dwg2dxf: one(this.dwg2dxf(), DWG2DXF_HINT) };
  }

  /** One conversion at a time (LibreOffice is heavy; dwg2dxf can use a lot of memory). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs with a hard timeout even if the runner ignores it. */
  private async run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConverterTimeoutError(t("previews:converter.timeout"))), this.timeoutMs + Math.min(5_000, this.timeoutMs));
    });
    try {
      return await Promise.race([this.runner(cmd, args, { cwd, timeoutMs: this.timeoutMs, env: this.env }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const parent = this.opts.tmpDir ?? os.tmpdir();
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(path.join(parent, "7dcde-conv-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }

  /**
   * Converts an office file to PDF and copies it to `outPath`. `extension` names the input
   * format (storage keys have no extension; LibreOffice picks the import filter from it).
   */
  officeToPdf(inputPath: string, extension: string, outPath: string): Promise<void> {
    const bin = this.soffice();
    if (!bin) return Promise.reject(new ConverterUnavailableError(SOFFICE_HINT));
    return this.serial(() =>
      this.withTempDir(async (dir) => {
        const src = path.join(dir, `input.${extension.replace(/[^a-z0-9]/gi, "") || "bin"}`);
        await copyFile(inputPath, src);
        const out = path.join(dir, "out");
        await mkdir(out);
        const profile = pathToFileURL(path.join(dir, "profile")).href;
        const r = await this.run(
          bin.path,
          [
            `-env:UserInstallation=${profile}`,
            "--headless",
            "--invisible",
            "--nodefault",
            "--nofirststartwizard",
            "--nolockcheck",
            "--nologo",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            out,
            src,
          ],
          dir,
        );
        const pdf = (await readdir(out)).find((f) => f.toLowerCase().endsWith(".pdf"));
        if (!pdf || (await stat(path.join(out, pdf))).size === 0) {
          throw new Error(t("previews:converter.libreofficeFailed", { code: r.code, detail: tail(r.stderr || r.stdout) }).trim());
        }
        await copyFile(path.join(out, pdf), outPath);
      }),
    );
  }

  /**
   * Converts a DWG to DXF (LibreDWG keeps the drawing's DXF version). Returns the number of error
   * lines dwg2dxf wrote: many errors mean objects it could not read (Civil 3D objects, see
   * cadCheck in service.ts).
   */
  dwgToDxf(inputPath: string, outPath: string): Promise<{ errors: number }> {
    const bin = this.dwg2dxf();
    if (!bin) return Promise.reject(new ConverterUnavailableError(DWG2DXF_HINT));
    return this.serial(() =>
      this.withTempDir(async (dir) => {
        await this.checkDwg2dxfVersion(bin.path, dir);
        const src = path.join(dir, "input.dwg");
        await copyFile(inputPath, src);
        const out = path.join(dir, "output.dxf");
        const r = await this.run(bin.path, ["-y", "-o", out, src], dir);
        // dwg2dxf exits non-zero on recoverable warnings too: the output decides.
        if (!existsSync(out) || (await stat(out)).size === 0) {
          throw new Error(t("previews:converter.dwgFailed", { code: r.code, detail: tail(r.stderr || r.stdout) }).trim());
        }
        await copyFile(out, outPath);
        return { errors: r.errorLines ?? countErrorLines(r.stderr) };
      }),
    );
  }

  private readonly versionChecked = new Set<string>();

  /** Warns once per binary when dwg2dxf is older than 0.14 (its DXF has broken MTEXT lines; they are repaired). */
  private async checkDwg2dxfVersion(bin: string, cwd: string): Promise<void> {
    // Only the real binary: test runners answer conversions, not --version.
    if (this.runner !== spawnRunner || this.versionChecked.has(bin)) return;
    this.versionChecked.add(bin);
    try {
      const r = await this.run(bin, ["--version"], cwd);
      const m = /(\d+)\.(\d+)/.exec(r.stdout || r.stderr);
      if (!m) return;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      const [minMajor, minMinor] = DWG2DXF_MIN_VERSION;
      if (major < minMajor || (major === minMajor && minor < minMinor)) {
        (this.opts.warn ?? console.warn)(
          `LibreDWG dwg2dxf ${m[0]} (${bin}) eski: 0.14 veya üstü gerekli; 0.13 MTEXT değerlerini satırlara bölüyor (sunucu onarıyor, docs/features/VIEWERS.md).`, // i18n-ok: log line
        );
      }
    } catch {
      /* the conversion itself reports problems */
    }
  }
}

function tail(s: string): string {
  const t = s.trim().split(/\r?\n/).slice(-3).join(" ");
  return t.length > 300 ? `…${t.slice(-300)}` : t;
}
