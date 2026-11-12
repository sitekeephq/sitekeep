import { isIP } from "node:net";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

/**
 * True when a host name or IP address stays inside the customer's network:
 * localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10,
 * *.local, *.internal, *.lan, *.localhost, *.home.arpa and single-label names (e.g. the "ollama"
 * service in docker compose), which public DNS does not resolve.
 *
 * The check is on the name, not on DNS answers: a private-looking name that the customer's DNS maps
 * to a public address is the customer's own configuration.
 */
export function isPrivateHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  const ipVersion = isIP(h);
  if (ipVersion === 4) return isPrivateIpv4(h);
  if (ipVersion === 6) return isPrivateIpv6(h);
  if (h === "localhost") return true;
  if (!h.includes(".")) return true;
  return [".local", ".internal", ".lan", ".localhost", ".home.arpa"].some((s) => h.endsWith(s));
}

/** Loopback only: localhost, 127.0.0.0/8, ::1 (and *.localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (isIP(h) === 4) return h.split(".")[0] === "127";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return !!mapped && mapped[1]!.startsWith("127.");
}

function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

function isPrivateIpv4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isPrivateIpv6(ip: string): boolean {
  if (ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

// ---- "İç ağ" list (Gizlilik Merkezi) ----------------------------------------------------------

/**
 * Hosts the administrator declared inside the network although their names look public, e.g. an
 * on-prem GPU server "ai.firma.com.tr" or a VPN range. Entries: an exact host, "*.firma.com.tr"
 * (any sub-domain) or an IPv4 range "100.64.0.0/10". Kept in memory (loaded from the privacy
 * settings at start and on save), because host checks are synchronous.
 */
let lanList: string[] = [];

export function setLanAllowlist(entries: string[]): void {
  lanList = normalizeLanList(entries);
}

export function lanAllowlist(): string[] {
  return [...lanList];
}

/** Trims, lower-cases and de-duplicates entries; invalid ones are dropped. */
export function normalizeLanList(entries: string[]): string[] {
  const out = new Set<string>();
  for (const raw of entries) {
    const e = raw.trim().toLowerCase().replace(/\.$/, "");
    if (e && lanEntryProblem(e) === null) out.add(e);
  }
  return [...out];
}

/** Why an "iç ağ" entry is not usable, as text in the installation's language, or null (lanEntryProblemMsg: as Msg). */
export function lanEntryProblem(entry: string): string | null {
  const problem = lanEntryProblemMsg(entry);
  return problem ? render(DEFAULT_LANGUAGE, problem) : null;
}

/** Why an "iç ağ" entry is not usable, or null. */
export function lanEntryProblemMsg(entry: string): Msg | null {
  const e = entry.trim().toLowerCase();
  if (!e) return msg("ai:errors.hostEmpty");
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(e);
  if (cidr) return isIP(cidr[1]!) === 4 && Number(cidr[2]) <= 32 ? null : msg("ai:errors.hostInvalidRange", { entry });
  if (isIP(e)) return null;
  const name = e.startsWith("*.") ? e.slice(2) : e;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name) ? null : msg("ai:errors.hostInvalidName", { entry });
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

function onLanList(host: string): boolean {
  const h = normalizeHost(host);
  if (!h || !lanList.length) return false;
  const v4 = isIP(h) === 4;
  for (const e of lanList) {
    if (e === h) return true;
    if (e.startsWith("*.") && h.endsWith(e.slice(1))) return true;
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(e);
    if (cidr && v4) {
      const bits = Number(cidr[2]);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((ipv4ToInt(h) & mask) === (ipv4ToInt(cidr[1]!) & mask)) return true;
    }
  }
  return false;
}

/** Inside the customer's network: a private address/name or an entry of the "iç ağ" list. */
export function isLanHost(host: string): boolean {
  return isPrivateHost(host) || onLanList(host);
}

/** True when the URL's host is outside the customer's network (or the URL is invalid). */
export function isExternalUrl(url: string): boolean {
  try {
    return !isLanHost(new URL(url).hostname);
  } catch {
    return true;
  }
}
