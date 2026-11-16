import type { FastifyReply } from "fastify";
import { SESSION_COOKIE } from "../app/deps.js";
import { hashToken, newToken } from "../core/security/auth.js";
import type { Db } from "../db/index.js";
import { tokens } from "../db/schema.js";

const SESSION_DAYS = 14;

/** A browser session for the user: the token in an httpOnly cookie, its hash in the database. */
export async function createSession(db: Db, userId: string, reply: FastifyReply, secure: boolean) {
  const token = newToken("s");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(tokens).values({ userId, kind: "session", tokenHash: hashToken(token), expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}
