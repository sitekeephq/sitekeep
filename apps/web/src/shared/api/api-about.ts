import { get } from "./client";

/** GET /api/v1/app-info (public): what this installation runs and where its source is (AGPL-3.0 §13). */
export interface AppInfoDto {
  product: string;
  edition: string;
  modules: string[];
  /** The release version; null for a development build. */
  version: string | null;
  sourceUrl: string;
}

export const aboutApi = {
  appInfo: () => get<AppInfoDto>("/app-info"),
  /** THIRD_PARTY_NOTICES.md as text. */
  notices: () => get<string>("/legal/notices"),
};
