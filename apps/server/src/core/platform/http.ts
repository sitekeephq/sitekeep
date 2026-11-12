import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { FALLBACK_LANGUAGE, isMsg, msg, render, requestLanguage, type Msg } from "../../i18n/index.js";
import { recordServerError } from "./error-ring.js";

/**
 * An error the client sees. `message` is a Msg (docs/architecture/i18n.md §8): the error handler
 * renders it in the request's language. `Error.message` holds the English text for logs. A plain
 * string is still accepted (text that is already final, e.g. from a third party).
 */
export class HttpError extends Error {
  readonly msg: Msg | null;
  /** Text from @sitekeep/shared, built in the reader's language (`(lang) => moduleOffMessage(m, lang)`). */
  readonly text: ((lang: string) => string) | null;
  constructor(
    readonly status: number,
    readonly code: string,
    message: Msg | string | ((lang: string) => string),
    readonly details?: unknown,
  ) {
    super(typeof message === "function" ? message(FALLBACK_LANGUAGE) : render(FALLBACK_LANGUAGE, message));
    this.msg = typeof message !== "function" && isMsg(message) ? message : null;
    this.text = typeof message === "function" ? message : null;
  }

  /** The message in a language. */
  messageIn(lang: string): string {
    return this.text ? this.text(lang) : this.msg ? render(lang, this.msg) : this.message;
  }
}

/** `notFound(msg("works:entities.work"))` → "Work not found." / "İş bulunamadı." */
export const notFound = (what: Msg | string = msg("errors:entities.record")) =>
  new HttpError(404, "not_found", typeof what === "string" ? `${what} bulunamadı.` : msg("errors:notFound", { what })); // i18n-ok: legacy string
export const forbidden = (message: Msg | string = msg("errors:forbidden")) => new HttpError(403, "forbidden", message);
export const badRequest = (message: Msg | string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const conflict = (message: Msg | string, details?: unknown) => new HttpError(409, "conflict", message, details);

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  const lang = requestLanguage(req);
  if (err instanceof HttpError) {
    return reply.status(err.status).send({ error: err.code, message: err.messageIn(lang), details: err.details });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({ error: "validation", message: render(lang, msg("errors:validation")), details: err.issues });
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (e.statusCode && e.statusCode < 500) {
    return reply.status(e.statusCode).send({ error: e.code ?? "bad_request", message: e.message ?? render(lang, msg("errors:generic")) });
  }
  // Unique violations from Postgres / PGlite.
  if (e.code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
    return reply.status(409).send({ error: "conflict", message: render(lang, msg("errors:duplicate")) });
  }
  // Foreign key violations: the request named a record that does not exist.
  if (e.code === "23503" || (e as { cause?: { code?: string } }).cause?.code === "23503") {
    return reply.status(400).send({ error: "bad_request", message: render(lang, msg("errors:validation")) });
  }
  recordServerError("http", err, { url: `${req.method} ${req.url}` });
  req.log.error(err);
  return reply.status(500).send({ error: "internal", message: render(lang, msg("errors:internal")) });
}
