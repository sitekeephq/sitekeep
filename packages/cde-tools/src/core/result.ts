import { z } from "zod";
import type { CdeToolDef } from "./types.js";
export class CdeError extends Error { constructor(message: string, readonly status?: number) { super(message); } }
export function cdeResult<T>(status: number, text: string, isForm: boolean): T {
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if ((status < 200 || status >= 300) && !(status === 400 && isForm)) {
    const message = (data as { message?: string } | null)?.message ?? text;
    throw new CdeError(`HTTP ${status}: ${message}`, status);
  }
  return data as T;
}
export function cdeToolJsonSchema(def: Pick<CdeToolDef, "shape">, omit: string[] = []): Record<string, unknown> {
  const shape = Object.fromEntries(Object.entries(def.shape).filter(([key]) => !omit.includes(key)));
  const schema = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
export function cdeParseArgs(def: Pick<CdeToolDef, "shape">, args: unknown): Record<string, unknown> { return z.object(def.shape).parse(args ?? {}) as Record<string, unknown>; }
