// Yönetim → Lisans (server: src/license/routes.ts).
import { request } from "./client";

export type LicenseStatus = "none" | "not_yet" | "active" | "expiring" | "grace" | "read_only" | "invalid";
export type LicenseProblem = "format" | "unknown_key" | "dev_key_in_production" | "signature" | "payload" | "other_installation" | "build_after_support";

export interface AdminLicenseDto {
  installationId: string;
  status: LicenseStatus;
  problem: LicenseProblem | null;
  enforced: boolean;
  clockBehind: boolean;
  daysLeft: number | null;
  readOnlyAt: string | null;
  seatsUsed: number;
  /** Active accounts beyond the licence's seats: Enterprise modules read-only. */
  seatsOver: number;
  license: {
    lid: string;
    customer: string;
    edition: "enterprise" | "trial";
    seats: number | null;
    modules: string[];
    validFrom: string;
    validUntil: string | null;
    supportUntil: string;
    graceDays: number;
  } | null;
}

export const licenseApi = {
  get: () => request<AdminLicenseDto>("GET", "/admin/license"),
  install: (file: string) => request<AdminLicenseDto>("PUT", "/admin/license", { file }),
  remove: () => request<AdminLicenseDto>("DELETE", "/admin/license"),
};
