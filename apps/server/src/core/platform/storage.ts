import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
}

/**
 * Content storage. Phase 1 ships the local-disk driver; an S3/MinIO driver can implement
 * the same interface.
 */
export interface Storage {
  put(stream: Readable, prefix: string): Promise<StoredObject>;
  putBytes(bytes: Uint8Array, prefix: string): Promise<StoredObject>;
  get(key: string): Readable;
  size(key: string): Promise<number>;
  /** Absolute path for workers that read the file directly (local driver only). */
  localPath(key: string): string;
  remove(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(stream: Readable, prefix: string): Promise<StoredObject> {
    const key = `${prefix}/${randomUUID()}`;
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { key, size, sha256: hash.digest("hex") };
  }

  async putBytes(bytes: Uint8Array, prefix: string): Promise<StoredObject> {
    const { Readable } = await import("node:stream");
    return this.put(Readable.from([Buffer.from(bytes)]), prefix);
  }

  get(key: string): Readable {
    return createReadStream(this.resolve(key));
  }

  async size(key: string): Promise<number> {
    return (await stat(this.resolve(key))).size;
  }

  localPath(key: string): string {
    return this.resolve(key);
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
