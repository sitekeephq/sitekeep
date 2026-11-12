import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { AttributeDefinition } from "@sitekeep/shared";

/** Input for one typed attribute: dropdown for lists, date picker for dates. */
export function AttributeInput({
  def,
  value,
  onChange,
  emptyLabel = "—",
  style,
}: {
  def: AttributeDefinition;
  value: string;
  onChange(value: string): void;
  emptyLabel?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation("shell");
  if (def.type === "list")
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
        <option value="">{emptyLabel}</option>
        {(def.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {value && !(def.options ?? []).includes(value) && <option value={value}>{t("attribute.invalid", { value })}</option>}
      </select>
    );
  return (
    <input
      type={def.type === "date" ? "date" : "text"}
      inputMode={def.type === "number" ? "decimal" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={style}
    />
  );
}
