import type { AskBridge } from "../core/platform/ask-bridge.js";
import type { Converters } from "../previews/converters.js";
import type { OfficeIntegration } from "../office/service.js";
import type { ReportLlm } from "../reports/llm.js";
import type { LetterMailer } from "../works/letter.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Storage } from "../core/platform/storage.js";
import type { Db } from "../db/index.js";
import type { OAuthOptions, ResolvedOAuthOptions } from "../oauth/config.js";
import type { FailureLimiter } from "../oauth/rate-limit.js";

export interface AppDeps {
  db: Db;
  storage: Storage;
  jobs: JobQueue;
  /** Built web app to serve at / (optional). */
  webDist?: string;
  /** Mark session cookies Secure (behind HTTPS). */
  secureCookies?: boolean;
  /**
   * Reverse proxies in front of the server (CDE_TRUST_PROXY): "1" trusts every hop, otherwise a
   * comma-separated list of addresses / CIDRs. Client IP (sign-in limits, logs) and HTTPS then come
   * from X-Forwarded-*. Unset: the socket address, as before.
   */
  trustProxy?: boolean | string[];
  logger?: boolean;
  maxUploadBytes?: number;
  /**
   * 32-byte key for secrets at rest (AI provider API keys): CDE_SECRET_KEY or DATA_DIR/secret.key,
   * see secrets.ts. When omitted a random key is used for this process only.
   */
  secretKey?: Buffer;
  /** Language model for the AI report builder; without it /reports/generate answers 503. */
  reportLlm?: ReportLlm;
  /** AI module: tests may replace the external Claude/Cursor credential probe; production uses the real provider call. */
  personalAiTest?: (
    db: Db,
    secretKey: Buffer,
    userId: string,
    selection: "anthropic" | "cursor",
    candidate?: { apiKey?: string; model?: string; workspaceId?: string | null; models?: { id: string; label: string }[] | null },
  ) => Promise<{ ok: true; model: string; reply: string; latencyMs: number }>;
  /** AI module: tests may replace the Claude model list (GET /v1/models); production asks Anthropic. */
  personalAiModels?: (apiKey: string, workspaceId?: string | null) => Promise<{ id: string; label: string }[]>;
  /** Identity bridge for the "Sor" assistant's in-process tool calls (tests pass their own). */
  askBridge?: AskBridge;
  /** SMTP sender for official letters (CDE_SMTP_URL / CDE_SMTP_FROM); without it letters are e-mailed by hand (.eml). */
  mailer?: LetterMailer | null;
  /** Local converter processes: DWG → DXF (LibreDWG) and the last-resort soffice; default: found from env/PATH. */
  converters?: Converters;
  /** Office integration (WOPI editor, office → PDF converter); default: settings from the database and env. */
  office?: OfficeIntegration;
  /** Environment for the office integration defaults (tests pass their own). */
  officeEnv?: NodeJS.ProcessEnv;
  /** Database driver, shown by the developer health check. */
  dbKind?: "postgres" | "pglite";
  /**
   * Developer tools (/api/v1/dev/*, cde_dev_* over MCP). Default: CDE_DEV_TOOLS=1 and NODE_ENV is
   * not production (dev/flag.ts). Never on in production defaults.
   */
  devTools?: boolean;
  /** Web app address for links in developer tool answers (default CDE_WEB_URL, else http://localhost:5173). */
  webUrl?: string;
  /** Where data lives, for Gizlilik Merkezi → Özet (no credentials). Default: database kind and storage root. */
  dataLocation?: { database?: string; storage?: string };
  /**
   * OAuth2 server and OpenCDE Foundation API (docs/features/OPENCDE.md). Defaults from the environment:
   * CDE_PUBLIC_URL, CDE_OAUTH_AUTH_URL, CDE_OAUTH_TOKEN_URL, CDE_OPENCDE_APIS.
   */
  oauth?: OAuthOptions;
  /** OpenCDE Documents API upload part size in bytes (tests use small parts); default 16 MiB. */
  documentsPartBytes?: number;
  /** Destination of the request log when `logger` is on (tests capture it); default stdout. */
  logStream?: NodeJS.WritableStream;
  /** Optional Google OpenID Connect login. Only existing, enabled users may sign in. */
  googleAuth?: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  };
  /** Autodesk APS 3-legged PKCE integration. */
  autodeskAuth?: {
    clientId: string;
    callbackUrl: string;
    /** Only for APS "Traditional Web App" clients; public (PKCE-only) clients have none. */
    clientSecret?: string;
  };
}

/** Dependencies after buildApp filled the defaults. */
export type ResolvedDeps = Omit<AppDeps, "oauth"> & {
  oauth: ResolvedOAuthOptions;
  /** Failed /oauth2/token and /oauth2/revoke requests per client IP. */
  oauthLimiter: FailureLimiter;
  secretKey: Buffer;
  askBridge: AskBridge;
  converters: Converters;
  office: OfficeIntegration;
  devTools: boolean;
  webUrl: string;
};

export const SESSION_COOKIE = "cde_session";
