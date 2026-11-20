/**
 * #158: jobs queued in bulk at start-up (payload.background) wait behind anything a person started,
 * and a request is answered in the web app's language, else the user's profile, else Accept-Language.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { LocalStorage } from "../../src/core/platform/storage.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { DEFAULT_LANGUAGE, clientLanguage, requestLanguage } from "../../src/i18n/index.js";

let dataDir: string;
let handle: DbHandle;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "sk-jobs-"));
  handle = await openDb("memory://");
});

afterAll(async () => {
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("job priority", () => {
  it("runs a person's job before older background jobs, oldest first within each group", async () => {
    const jobs = new JobQueue(handle.db, new LocalStorage(path.join(dataDir, "storage")));
    const ran: string[] = [];
    jobs.register("probe", async (job) => {
      ran.push(String(job.payload.name));
    });
    await jobs.enqueue("probe", { name: "reconvert-1", background: true });
    await jobs.enqueue("probe", { name: "reconvert-2", background: true });
    await jobs.enqueue("probe", { name: "upload-1" });
    await jobs.enqueue("probe", { name: "reconvert-3", background: true });
    await jobs.enqueue("probe", { name: "upload-2" });
    await jobs.drain();
    expect(ran).toEqual(["upload-1", "upload-2", "reconvert-1", "reconvert-2", "reconvert-3"]);
  });
});

describe("request language", () => {
  const req = (headers: Record<string, string>, language: string | null = null) => ({ headers, user: language === null ? null : { language } });

  it("the web app's header wins over the profile and the browser", () => {
    expect(requestLanguage(req({ "x-sitekeep-language": "en", "accept-language": "tr-TR,tr;q=0.9" }, "tr"))).toBe("en");
  });

  it("the profile wins over the browser's Accept-Language (a direct API call from a Turkish browser)", () => {
    expect(requestLanguage(req({ "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" }, "en"))).toBe("en");
  });

  it("without a profile the browser decides, then the installation default", () => {
    expect(requestLanguage(req({ "accept-language": "tr-TR,tr;q=0.9" }))).toBe("tr");
    expect(requestLanguage(req({}))).toBe(DEFAULT_LANGUAGE);
  });

  it("clientLanguage ignores the profile (language of a new account)", () => {
    expect(clientLanguage(req({ "x-sitekeep-language": "tr" }))).toBe("tr");
    expect(clientLanguage(req({ "accept-language": "en-GB" }))).toBe("en");
    expect(clientLanguage(req({}))).toBeNull();
  });
});
