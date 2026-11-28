import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { redactSecrets } from "./error-ring.js";
import type { ObjectBackend } from "./object-storage.js";
import { notFoundError, type ByteRange } from "./storage.js";

export interface S3Settings {
  /** Empty for AWS S3; e.g. http://minio:9000, https://<account>.r2.cloudflarestorage.com. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Path-style URLs (MinIO and most self-hosted stores). */
  forcePathStyle: boolean;
  /** Part size of multipart uploads (bytes, at least 5 MiB). */
  partSize: number;
  /** Parts uploaded at the same time. */
  concurrency: number;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** S3-compatible object storage: AWS S3, MinIO, Cloudflare R2 (and other S3 APIs). */
export class S3Backend implements ObjectBackend {
  readonly kind = "s3" as const;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly client: S3Client;

  constructor(private readonly s: S3Settings) {
    this.bucket = s.bucket;
    this.region = s.region;
    if (s.endpoint) this.endpoint = new URL(s.endpoint).host;
    this.client = new S3Client({
      region: s.region,
      ...(s.endpoint && { endpoint: s.endpoint }),
      forcePathStyle: s.forcePathStyle,
      ...(s.accessKeyId && s.secretAccessKey && { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } }),
      // MinIO, R2 and other S3 APIs do not all accept the newer default CRC checksums.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 4,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    });
  }

  async putSmall(name: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: name, Body: body, ContentLength: body.length }));
  }

  /** Multipart upload: parts of `partSize`, `concurrency` at a time; memory stays at about partSize × (concurrency + 1). */
  async putStream(name: string, body: Readable): Promise<void> {
    const { UploadId } = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: name }));
    const parts: { PartNumber: number; ETag: string }[] = [];
    const inflight = new Set<Promise<void>>();
    let failure: unknown = null;
    let n = 0;
    const send = (data: Buffer) => {
      const PartNumber = ++n;
      const p = this.client
        .send(new UploadPartCommand({ Bucket: this.bucket, Key: name, UploadId, PartNumber, Body: data, ContentLength: data.length }))
        .then((r) => {
          parts.push({ PartNumber, ETag: r.ETag! });
        })
        .catch((err: unknown) => {
          failure ??= err;
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    };
    try {
      let buf: Buffer[] = [];
      let len = 0;
      for await (const chunk of body) {
        const b = chunk as Buffer;
        buf.push(b);
        len += b.length;
        if (len >= this.s.partSize) {
          send(Buffer.concat(buf, len));
          buf = [];
          len = 0;
          while (inflight.size >= this.s.concurrency) await Promise.race(inflight);
          if (failure) throw failure;
        }
      }
      if (len > 0 || n === 0) send(Buffer.concat(buf, len));
      await Promise.all(inflight);
      if (failure) throw failure;
      parts.sort((a, b) => a.PartNumber - b.PartNumber);
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: name, UploadId, MultipartUpload: { Parts: parts } }));
    } catch (err) {
      await Promise.allSettled(inflight);
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: name, UploadId })).catch(() => {});
      throw err;
    }
  }

  async read(name: string, range?: ByteRange): Promise<Readable> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: name, ...(range && { Range: `bytes=${range.start}-${range.end}` }) }),
      );
      return r.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw notFoundError(name);
      throw err;
    }
  }

  async head(name: string): Promise<{ size: number } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: name }));
      return { size: r.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(name: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: name }));
  }

  async *list(prefix: string): AsyncIterable<{ name: string; size: number }> {
    let ContinuationToken: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }));
      for (const o of r.Contents ?? []) if (o.Key) yield { name: o.Key, size: o.Size ?? 0 };
      ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  async ping(): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }

  describeError(err: unknown): string {
    const e = err as { name?: string; message?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    const status = e?.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : "";
    let text = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}${status}`;
    if (this.s.secretAccessKey) text = text.split(this.s.secretAccessKey).join("***");
    return redactSecrets(text);
  }
}
