/**
 * Built-in OAuth2 authorization server for OpenCDE clients (docs/features/OPENCDE.md). Access tokens live in
 * the shared `tokens` table (kind "oauth"); this file holds the clients, remembered consents,
 * one-time authorization codes and rotating refresh tokens. Only SHA-256 hashes of codes, tokens
 * and client secrets are stored.
 */
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { OAuthClientType, OAuthScope } from "@sitekeep/shared";
import { users } from "./schema.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Applications registered by a system administrator (Yönetim → OAuth Uygulamaları). */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  /** Public identifier the application sends as client_id. */
  clientId: text("client_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").$type<OAuthClientType>().notNull(),
  /** Confidential clients: SHA-256 of the secret (shown once at creation / rotation). */
  secretHash: text("secret_hash"),
  secretSetAt: ts("secret_set_at"),
  /** Exact-match redirect URIs; loopback http URIs match any port (RFC 8252). */
  redirectUris: text("redirect_uris").array().notNull().default(sql`'{}'::text[]`),
  /** Scopes the client may ask for. */
  scopes: text("scopes").array().$type<OAuthScope[]>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Consent a user gave a client ("Onayla"), remembered until revoked in Hesabım. */
export const oauthConsents = pgTable(
  "oauth_consents",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().$type<OAuthScope[]>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** Last authorization, token or refresh for this user and client. */
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clientId] })],
);

/** One-time authorization codes (≤ 60 s), bound to client, redirect URI and PKCE challenge. */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    codeHash: text("code_hash").notNull().unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().$type<OAuthScope[]>().notNull(),
    codeChallenge: text("code_challenge"),
    codeChallengeMethod: text("code_challenge_method").$type<"S256">(),
    /** Token family the exchange creates; a reused code revokes it. */
    familyId: uuid("family_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
  },
  (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)],
);

/**
 * Refresh tokens, one-time use: each refresh rotates to a new token of the same family. Presenting
 * a used token again (reuse) revokes the whole family: every refresh and access token in it.
 */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tokenHash: text("token_hash").notNull().unique(),
    familyId: uuid("family_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().$type<OAuthScope[]>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    /** Rotated (exchanged for a new token). */
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("oauth_refresh_family_idx").on(t.familyId), index("oauth_refresh_user_client_idx").on(t.userId, t.clientId)],
);
