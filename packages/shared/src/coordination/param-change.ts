/**
 * "Değişiklik Talebi" (parameter change request): change element information (property set values)
 * of an IFC model and produce a new version. Step 1 applies it in the CDE (web-ifc); step 2 (later)
 * hands the same request to the authoring team (Revit via AEC Pilot) and only verifies the result.
 * See docs/features/PARAMETRE_DEGISIKLIGI.md.
 */
export const PARAM_CHANGE_STATUSES = [
  "draft",
  "pending",
  "approved",
  "applying",
  "applied",
  "rejected",
  "cancelled",
  "authoring",
  "values_lost",
] as const;

export type ParamChangeStatus = (typeof PARAM_CHANGE_STATUSES)[number];

export const PARAM_CHANGE_STATUS_LABELS_TR: Record<ParamChangeStatus, string> = {
  draft: "Taslak",
  pending: "Onay Bekliyor",
  approved: "Onaylandı",
  applying: "Uygulanıyor",
  applied: "Uygulandı",
  rejected: "Reddedildi",
  cancelled: "İptal",
  authoring: "Revit'te Uygulanacak",
  values_lost: "Değerler Kayboldu",
};

/**
 * Who owns the values: "revit" = the authoring model must get the change too (a Revit re-export
 * without it loses the value); "cde_only" = information added in the CDE only (enrichment).
 */
export const PARAM_CHANGE_OWNERSHIPS = ["revit", "cde_only"] as const;

export type ParamChangeOwnership = (typeof PARAM_CHANGE_OWNERSHIPS)[number];

export const PARAM_CHANGE_OWNERSHIP_LABELS_TR: Record<ParamChangeOwnership, string> = {
  revit: "Revit'e de İşlenecek",
  cde_only: "Yalnızca CDE'de",
};

/** Value types of a property change. */
export const PARAM_VALUE_TYPES = ["text", "number", "boolean", "enum"] as const;

export type ParamValueType = (typeof PARAM_VALUE_TYPES)[number];

export const PARAM_VALUE_TYPE_LABELS_TR: Record<ParamValueType, string> = {
  text: "Metin",
  number: "Sayı",
  boolean: "Evet / Hayır",
  enum: "Seçenek",
};

/**
 * Values that live on the type object: "instance" writes the value on the element (overrides the
 * type, default), "type" changes the type (every instance of the type changes).
 */
export const PARAM_TYPE_MODES = ["instance", "type"] as const;

export type ParamTypeMode = (typeof PARAM_TYPE_MODES)[number];

export const PARAM_TYPE_MODE_LABELS_TR: Record<ParamTypeMode, string> = {
  instance: "Elemana Yaz",
  type: "Tipte Değiştir",
};

/** Where the current value of an item lives. */
export type ParamItemSource = "instance" | "type" | "missing";

export const PARAM_ITEM_SOURCE_LABELS_TR: Record<ParamItemSource, string> = {
  instance: "Eleman",
  type: "Tip",
  missing: "Eklenecek",
};

export type ParamItemResult = "pending" | "ok" | "failed" | "lost" | "skipped";

export const PARAM_ITEM_RESULT_LABELS_TR: Record<ParamItemResult, string> = {
  pending: "Bekliyor",
  ok: "Tamam",
  failed: "Başarısız",
  lost: "Kayboldu",
  skipped: "Atlandı",
};

export type ParamChangeSource = "selection" | "query" | "ai";

export const PARAM_CHANGE_SOURCE_LABELS_TR: Record<ParamChangeSource, string> = {
  selection: "Seçimden",
  query: "Sorgudan",
  ai: "Cümleden",
};

/** Project setting "parametre değişikliği onay gerektirir" and the approver role. */
export interface ParamChangeSettings {
  approvalRequired: boolean;
  /** Members of this project role may approve (besides project administrators). */
  approverRoleId: string | null;
}
