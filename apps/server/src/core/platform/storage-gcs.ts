import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage as GcsClient, type Bucket } from "@google-cloud/storage";
import { redactSecrets } from "./error-ring.js";
import type { ObjectBackend } from "./object-storage.js";
import { notFoundError, type ByteRange } from "./storage.js";

export interface GcsSettings {
  bucket: string;
  /** Optional; ADC finds it on a GCP VM and from `gcloud auth application-default login`. */
  projectId?: string;
}

function status(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const c = typeof e?.code === "number" ? e.code : (e?.status ?? e?.response?.status);
  return typeof c === "number" ? c : undefined;
}

/**
 * Google Cloud Storage through its JSON API with Application Default Credentials: the VM's attached
 * service account (metadata server), GOOGLE_APPLICATION_CREDENTIALS, or `gcloud auth application-default
 * login`. No keys in SiteKeep's configuration.
 */
export class GcsBackend implements ObjectBackend {
  readonly kind = "gcs" as const;
  readonly bucket: string;
  private readonly b: Bucket;

  constructor(s: GcsSettings, client?: GcsClient) {
    this.bucket = s.bucket;
    const gcs = client ?? new GcsClient({ ...(s.projectId && { projectId: s.projectId }), retryOptions: { autoRetry: true, maxRetries: 4 } });
    this.b = gcs.bucket(s.bucket);
  }

  async putSmall(name: string, body: Buffer): Promise<void> {
    // ifGenerationMatch 0: never replaces an object, and makes the upload safe to retry.
    await this.b.file(name).save(body, { resumable: false, contentType: "application/octet-stream", preconditionOpts: { ifGenerationMatch: 0 } });
  }

  /** Resumable upload, streamed (the library sends it in one request and resumes on errors). */
  async putStream(name: string, body: Readable): Promise<void> {
    const out = this.b.file(name).createWriteStream({
      resumable: true,
      contentType: "application/octet-stream",
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    await pipeline(body, out);
  }

  read(name: string, range?: ByteRange): Promise<Readable> {
    const s = this.b.file(name).createReadStream({
      ...(range && { start: range.start, end: range.end }),
      // A part cannot be checked against the object's checksum.
      validation: range ? false : "crc32c",
      decompress: false,
    });
    return new Promise((resolve, reject) => {
      const onError = (err: unknown) => {
        s.off("response", onResponse);
        s.destroy();
        reject(status(err) === 404 ? notFoundError(name) : err);
      };
      const onResponse = () => {
        s.off("error", onError);
        resolve(s);
      };
      s.once("error", onError);
      s.once("response", onResponse);
      // The library sends the request when the stream is first read from; read(0) starts it without taking data.
      s.read(0);
    });
  }

  async head(name: string): Promise<{ size: number } | null> {
    try {
      const [m] = await this.b.file(name).getMetadata();
      return { size: Number(m.size ?? 0) };
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  }

  async delete(name: string): Promise<void> {
    await this.b.file(name).delete({ ignoreNotFound: true });
  }

  async *list(prefix: string): AsyncIterable<{ name: string; size: number }> {
    let pageToken: string | undefined;
    do {
      const [files, next] = await this.b.getFiles({ prefix, autoPaginate: false, maxResults: 1000, ...(pageToken && { pageToken }) });
      for (const f of files) yield { name: f.name, size: Number(f.metadata.size ?? 0) };
      pageToken = (next as { pageToken?: string } | null)?.pageToken;
    } while (pageToken);
  }

  async ping(): Promise<void> {
    await this.b.getFiles({ autoPaginate: false, maxResults: 1 });
  }

  describeError(err: unknown): string {
    const e = err as { name?: string; message?: string };
    const code = status(err);
    return redactSecrets(`${e?.name ?? "Error"}: ${e?.message ?? String(err)}${code ? ` (HTTP ${code})` : ""}`);
  }
}
