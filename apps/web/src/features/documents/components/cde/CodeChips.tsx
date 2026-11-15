/**
 * ISO 19650 suitability and revision codes of a version (docs/features/CDE_STATES.md "Codes"):
 * the chips shown in the documents list and the file drawer, and the helpers the code inputs share.
 */
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  REVISION_FORM_EXAMPLES,
  allowedRevisionForms,
  allowedSuitability,
  codeProfile,
  type CdeCodeError,
  type CdeCodeProfile,
  type CdeFolderCodesDto,
  type CdeState,
} from "@sitekeep/shared";
import { cdeApi } from "../../../../shared/api/api-cde";
import { useLoad } from "../../../../app/context/project";

/** Suitability and revision chips; nothing when the version has no codes. */
export function CodeChips({ suitability, revision }: { suitability?: string | null; revision?: string | null }) {
  const { t } = useTranslation("cde");
  if (!suitability && !revision) return null;
  return (
    <span className="code-chips">
      {suitability && (
        <span className="badge info code-chip" data-testid="code-suitability" title={t("codes.chipSuitability", { code: suitability })}>
          {suitability}
        </span>
      )}
      {revision && (
        <span className="badge code-chip" data-testid="code-revision" title={t("codes.chipRevision", { code: revision })}>
          {revision}
        </span>
      )}
    </span>
  );
}

export interface FolderCodes {
  dto: CdeFolderCodesDto;
  profile: CdeCodeProfile;
  state: CdeState | null;
}

/** Profile and state of a folder (null while loading or when the folder is unknown). */
export function useFolderCodes(projectId: string, folderId: string | null | undefined): FolderCodes | null {
  const { data } = useLoad(
    () => (folderId ? cdeApi.folderCodes(projectId, folderId).catch(() => null) : Promise.resolve(null)),
    [projectId, folderId],
  );
  if (!data) return null;
  return { dto: data, profile: codeProfile(data), state: data.state };
}

/** "S1, S2, S3, S4" and "P01" for a state (families written as A1…An). */
export function codeHints(profile: CdeCodeProfile, state: CdeState | null) {
  const codes = allowedSuitability(profile, state)
    .filter((c) => profile.customSuitability || !/^[AB][23]$/.test(c))
    .map((c) => (!profile.customSuitability && /^[AB]1$/.test(c) ? `${c[0]}1…${c[0]}n` : c));
  return { codes: codes.join(", "), revision: allowedRevisionForms(profile, state).map((f) => REVISION_FORM_EXAMPLES[f]).join(", ") };
}

/** Text of a code error in the interface language. */
export function codeErrorText(t: TFunction<"cde">, e: CdeCodeError, state: CdeState | null): string {
  return t(`codes.errors.${e.kind}`, { value: e.value, allowed: e.allowed || "—", state: state ? t(`states.${state}`) : "—" });
}
