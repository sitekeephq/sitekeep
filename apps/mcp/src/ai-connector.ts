#!/usr/bin/env node
/**
 * Local AI connector for the CDE task queue.
 *
 * It lets a user process "Kendi AI'ımla Çalıştır" tasks with either:
 * - their Cursor account through the official Cursor SDK browser login, or
 * - their Claude subscription through the official, locally authenticated Claude Code CLI.
 *
 * CDE_TOKEN must be a write API token belonging to a project member. The model only receives the
 * read-only CDE MCP tools; claiming/completing tasks stays in this process and server validation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Cursor SDK has its own licence, so SiteKeep does not ship it. The Cursor runtime loads it when
 * used; install it next to the connector first: `npm install @cursor/sdk`. Only what is used is typed here.
 */
interface CursorSdk {
  Cursor: {
    models: { list(): Promise<{ id: string }[]> };
    auth: {
      login(o: { apiKeyName: string }): Promise<{ email?: string }>;
      logout(): Promise<void>;
      status(): Promise<{ status: string; email?: string }>;
    };
  };
  Agent: {
    prompt(
      prompt: string,
      o: { model: { id: string }; tools: string[]; mcpServers: Record<string, unknown>; local: { cwd: string; settingSources: string[] }; name: string },
    ): Promise<{ status: string; result?: string; error?: { message?: string } }>;
  };
}
const CURSOR_SDK = "@cursor/sdk";
async function cursorSdk(): Promise<CursorSdk> {
  try {
    return (await import(CURSOR_SDK)) as CursorSdk;
  } catch {
    throw new Error("Cursor çalışma ortamı için @cursor/sdk gerekli (ayrı lisanslı, SiteKeep ile gelmez): npm install @cursor/sdk");
  }
}

type Runtime = "cursor" | "claude";

interface PendingTask {
  id: string;
  projectId: string;
  label: string;
  summary: string;
}

interface Claim {
  task: PendingTask;
  prompt: {
    messages: { role: string; content: string | unknown[] }[];
    appTools?: { name: string; description?: string }[];
  };
  answer: {
    format: "json" | "text";
    instructions: string;
    schema: Record<string, unknown> | null;
  };
  tools: string[];
}

interface Completion {
  ok: boolean;
  errors?: string[];
}

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args.shift()! : "run";
const runtimeArg = valueOf("--runtime") ?? process.env.CDE_AI_RUNTIME ?? "cursor";
const runtime = runtimeArg === "claude" ? "claude" : runtimeArg === "cursor" ? "cursor" : null;
const once = args.includes("--once");
const pollMs = positiveNumber(valueOf("--interval") ?? process.env.CDE_AI_POLL_MS, 5_000);
const cdeUrl = (process.env.CDE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const cdeToken = process.env.CDE_TOKEN ?? "";
const mcpEntry = fileURLToPath(new URL("./index.js", import.meta.url));

function valueOf(name: string): string | undefined {
  const inline = args.find((x) => x.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function usage(): never {
  console.error(`SiteKeep yerel AI connector

Kurulum:
  sitekeep-ai login cursor
  sitekeep-ai logout cursor
  claude auth login

Çalıştırma:
  CDE_URL=https://cde.example.com CDE_TOKEN=... sitekeep-ai run --runtime cursor
  CDE_URL=https://cde.example.com CDE_TOKEN=... sitekeep-ai run --runtime claude

Seçenekler:
  --once              İlk uygun görevi işleyip çık
  --interval 5000     Bekleyen görev kontrol aralığı (ms)
  --runtime cursor|claude

CDE_TOKEN, Hesabım → API Erişim Anahtarları bölümünden oluşturulan yazma anahtarıdır.`);
  process.exit(2);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cdeUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cdeToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === "string"
          ? parsed
          : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

function textOf(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
      return JSON.stringify(part);
    })
    .join("\n");
}

export function connectorPrompt(claim: Claim, validationErrors: string[] = []): string {
  const conversation = claim.prompt.messages.map((m) => `${m.role.toLocaleUpperCase("en-US")}:\n${textOf(m.content)}`).join("\n\n");
  const tools = claim.tools.length ? `Gerekirse yalnız şu CDE okuma araçlarını kullan: ${claim.tools.join(", ")}.` : "CDE aracı kullanma.";
  const schema = claim.answer.schema ? `\nJSON şeması:\n${JSON.stringify(claim.answer.schema)}` : "";
  const repair = validationErrors.length ? `\nÖnceki cevap reddedildi. Şu hataları düzelt:\n- ${validationErrors.join("\n- ")}` : "";
  return `SiteKeep içindeki tek bir yapay zekâ görevini cevaplıyorsun.
${tools}
Görev kuyruğu araçlarını çağırma; görevi tamamlama işlemini connector yapacak.
Son çıktında açıklama veya Markdown çiti kullanma. Yalnız istenen ${claim.answer.format === "json" ? "JSON değerini" : "metni"} yaz.

${conversation}

CEVAP KURALI:
${claim.answer.instructions}${schema}${repair}`;
}

function mcpServer() {
  if (!existsSync(mcpEntry)) throw new Error(`CDE MCP derlemesi bulunamadı: ${mcpEntry}. Önce npm run build -w @sitekeep/mcp çalıştırın.`);
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [mcpEntry],
    env: { CDE_URL: cdeUrl, CDE_TOKEN: cdeToken, CDE_READ_ONLY: "1" },
  };
}

async function cursorAnswer(prompt: string): Promise<string> {
  const { Agent, Cursor } = await cursorSdk();
  const models = await Cursor.models.list();
  const requested = process.env.CURSOR_MODEL;
  const selected =
    (requested && models.find((m) => m.id === requested)) ??
    models.find((m) => m.id === "composer-2.5") ??
    models.find((m) => m.id === "auto") ??
    models[0];
  if (!selected) throw new Error("Cursor hesabında kullanılabilir model bulunamadı.");
  const result = await Agent.prompt(prompt, {
    model: { id: selected.id },
    tools: ["mcp"],
    mcpServers: { "sitekeep": mcpServer() },
    local: { cwd: process.cwd(), settingSources: [] },
    name: "SiteKeep AI Connector",
  });
  if (result.status !== "finished" || !result.result?.trim()) throw new Error(result.error?.message ?? `Cursor görevi ${result.status} durumunda bitti.`);
  return result.result.trim();
}

async function claudeAnswer(prompt: string): Promise<string> {
  const bin = process.env.CLAUDE_BIN ?? "claude";
  // Passing the inline MCP JSON would expose CDE_TOKEN in the OS process list.
  const temp = await mkdtemp(path.join(os.tmpdir(), "sitekeep-ai-"));
  const config = path.join(temp, "mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { "sitekeep": mcpServer() } }), { mode: 0o600 });
  const cliArgs = [
    "-p",
    "--output-format",
    "text",
    "--mcp-config",
    config,
    "--strict-mcp-config",
    "--tools",
    "mcp__sitekeep__*",
    "--allowedTools",
    "mcp__sitekeep__*",
  ];
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, cliArgs, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      let output = "";
      let error = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude Code 10 dakika içinde cevap vermedi."));
      }, 10 * 60_000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (error += chunk));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(e.message.includes("ENOENT") ? "Claude Code bulunamadı. Önce resmi Claude Code'u kurup `claude auth login` çalıştırın." : e.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && output.trim()) resolve(output.trim());
        else reject(new Error(error.trim() || `Claude Code çıkış kodu: ${code}`));
      });
      child.stdin.end(prompt);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function answer(prompt: string): Promise<string> {
  return runtime === "cursor" ? cursorAnswer(prompt) : claudeAnswer(prompt);
}

async function processTask(task: PendingTask): Promise<void> {
  console.log(`→ ${task.label}: ${task.summary || task.id}`);
  const claim = await api<Claim>("POST", `/projects/${task.projectId}/ai-tasks/${task.id}/claim`);
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const output = await answer(connectorPrompt(claim, errors));
    const completed = await api<Completion>("POST", `/projects/${task.projectId}/ai-tasks/${task.id}/complete`, { result: output });
    if (completed.ok) {
      console.log(`✓ Tamamlandı: ${task.label}`);
      return;
    }
    errors = completed.errors ?? ["Cevap doğrulanamadı."];
    console.warn(`  Cevap reddedildi (${attempt}/3): ${errors.join(" ")}`);
  }
  throw new Error(`Cevap üç denemede doğrulanamadı: ${errors.join(" ")}`);
}

async function run(): Promise<void> {
  if (!runtime) usage();
  if (!cdeToken) throw new Error("CDE_TOKEN tanımlı değil. Hesabım → API Erişim Anahtarları bölümünden yazma anahtarı oluşturun.");
  console.log(`SiteKeep connector başladı · ${runtime === "cursor" ? "Cursor SDK" : "Claude Code"} · ${cdeUrl}`);
  for (;;) {
    const tasks = await api<PendingTask[]>("GET", "/ai-tasks");
    if (tasks[0]) {
      try {
        await processTask(tasks[0]);
      } catch (e) {
        const message = (e as Error).message;
        console.error(`✗ ${message}`);
        try {
          await api("POST", `/projects/${tasks[0].projectId}/ai-tasks/${tasks[0].id}/fail`, { error: message });
        } catch {
          /* The task may have been cancelled or completed while the model worked. */
        }
      }
      if (once) return;
      continue;
    }
    if (once) {
      console.log("Bekleyen görev yok.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function main(): Promise<void> {
  if (command === "login") {
    const target = args[0] ?? runtimeArg;
    if (target === "cursor") {
      const { Cursor } = await cursorSdk();
      const result = await Cursor.auth.login({ apiKeyName: "SiteKeep AI Connector" });
      console.log(`Cursor bağlantısı hazır${result.email ? `: ${result.email}` : ""}.`);
    } else if (target === "claude") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.env.CLAUDE_BIN ?? "claude", ["auth", "login"], { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Claude giriş işlemi başarısız: ${code}`))));
      });
    } else usage();
  } else if (command === "logout") {
    const target = args[0] ?? runtimeArg;
    if (target === "cursor") {
      const { Cursor } = await cursorSdk();
      await Cursor.auth.logout();
      console.log("Yerel Cursor SDK bağlantısı kaldırıldı.");
    } else if (target === "claude") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.env.CLAUDE_BIN ?? "claude", ["auth", "logout"], { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Claude çıkış işlemi başarısız: ${code}`))));
      });
    } else usage();
  } else if (command === "status") {
    const sdk = await cursorSdk().catch(() => null);
    const cursor = sdk ? await sdk.Cursor.auth.status() : null;
    console.log(`Cursor: ${!cursor ? "SDK kurulu değil (npm install @cursor/sdk)" : cursor.status === "logged-in" ? `bağlı${cursor.email ? ` (${cursor.email})` : ""}` : "bağlı değil"}`);
    console.log("Claude: `claude auth status` ile kontrol edin.");
  } else if (command === "run") {
    await run();
  } else {
    usage();
  }
}

main().catch((error: unknown) => {
  console.error(`Hata: ${(error as Error).message}`);
  process.exitCode = 1;
});
