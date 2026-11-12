import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiMode } from "../api/api";
import { i18n } from "../../i18n";

/** Translation keys (namespace "ai") of the AI mode names. */
export const MODE_LABEL_KEYS = {
  off: "mode.options.off",
  local_only: "mode.options.localOnly",
  allow_external: "mode.options.allowExternal",
} as const satisfies Record<AiMode, string>;

/** The mode's name in the current interface language. */
export function modeLabel(mode: AiMode): string {
  return i18n.t(`ai:${MODE_LABEL_KEYS[mode]}`);
}

/**
 * Mode names; each read returns the current interface language (getters, nothing fixed at module
 * load), so `MODE_LABEL[mode]` in a render stays correct. New code: modeLabel() / MODE_LABEL_KEYS.
 */
export const MODE_LABEL: Readonly<Record<AiMode, string>> = Object.defineProperties(
  {} as Record<AiMode, string>,
  Object.fromEntries((Object.keys(MODE_LABEL_KEYS) as AiMode[]).map((m) => [m, { get: () => modeLabel(m), enumerable: true }])),
);

export function ModeBadge({ mode }: { mode: AiMode }) {
  const { t } = useTranslation("ai");
  if (mode === "local_only") return <span className="badge ok" title={t("mode.localOnlyHint")}>{t("mode.badges.localOnly")}</span>;
  if (mode === "off") return <span className="badge">{t("mode.badges.off")}</span>;
  return <span className="badge warn" title={t("mode.allowExternalHint")}>{t("mode.badges.allowExternal")}</span>;
}

/** Same rule as the server (apps/server/src/ai/hosts.ts), for live hints only — the server decides. */
export function isExternalUrl(url: string): boolean {
  let h: string;
  try {
    h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
  }
  if (h.includes(":")) {
    if (h === "::1") return false;
    const first = parseInt(h.split(":")[0] || "0", 16);
    return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
  }
  if (h === "localhost" || !h.includes(".")) return false;
  return ![".local", ".internal", ".lan", ".localhost", ".home.arpa"].some((s) => h.endsWith(s));
}

export function Snippet({ text }: { text: string }) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <pre>{text}</pre>
      <button
        type="button"
        className="small"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? t("status.copied") : t("actions.copy")}
      </button>
    </div>
  );
}

export function mcpUrl(): string {
  return `${window.location.origin}/mcp`;
}
