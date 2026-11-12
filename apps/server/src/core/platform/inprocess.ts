/**
 * In-process REST calls through the request bridge (ai/assistant.ts AskBridge): the call runs the
 * normal route, validation and permission checks of the bridged identity. Used by the AI task
 * queue (results are applied as the requesting user) and by the developer tools.
 */
import type { FastifyInstance } from "fastify";
import { CdeError, cdeResult, type CdeCall } from "@sitekeep/cde-tools";
import { BRIDGE_HEADER } from "./bridge.js";

/** CdeCall through the bridge; FormData bodies are sent as multipart. */
export function bridgedCall(app: FastifyInstance, key: string): CdeCall {
  return async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { [BRIDGE_HEADER]: key };
    let payload: string | Buffer | undefined;
    const isForm = body instanceof FormData;
    if (isForm) {
      const encoded = new Request("http://local/", { method: "POST", body });
      payload = Buffer.from(await encoded.arrayBuffer());
      headers["content-type"] = encoded.headers.get("content-type")!;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload });
    if (isForm && res.statusCode === 400) {
      // Uploads report per-file failures with 400; surface them as an error here.
      const data = cdeResult<{ message?: string; results?: { name?: string; errors?: string[] }[] }>(res.statusCode, res.body, true);
      const why = data?.results?.map((r) => `${r.name ?? ""}: ${(r.errors ?? []).join(", ")}`).join("; ");
      throw new CdeError(`HTTP 400: ${data?.message ?? why ?? res.body}`, 400);
    }
    return cdeResult<T>(res.statusCode, res.body, isForm);
  };
}

/** In-process JSON call that returns the status and body instead of throwing (error details stay readable). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawCall = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;

export function bridgedRaw(app: FastifyInstance, key: string): RawCall {
  return async (method, url, body) => {
    const headers: Record<string, string> = { [BRIDGE_HEADER]: key };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, payload });
    let data: unknown = res.body;
    try {
      data = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* text */
    }
    return { status: res.statusCode, body: data };
  };
}

/** Raw in-process GET (binary responses such as PDFs). */
export async function bridgedGet(app: FastifyInstance, key: string, url: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { [BRIDGE_HEADER]: key } });
  return { status: res.statusCode, headers: res.headers, body: res.rawPayload };
}
