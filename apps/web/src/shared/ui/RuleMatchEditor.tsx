/**
 * Element selection of a 4D link rule or a 5D cost rule: storeys, IFC classes, element name and
 * a property condition, from the model's vocabulary (element index on the server).
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelVocabDto, RuleMatch } from "@sitekeep/shared";
import { useLabel } from "../../i18n";
import { intlLocale } from "../lib/format";

export function RuleMatchEditor({
  vocab,
  value,
  onChange,
  target,
}: {
  vocab: ModelVocabDto | null;
  value: RuleMatch;
  onChange(m: RuleMatch): void;
  target: "activity" | "cost";
}) {
  const { t } = useTranslation(["sim", "common"]);
  const label = useLabel();
  const [classQ, setClassQ] = useState("");
  const locale = intlLocale();
  const classes = useMemo(() => {
    const q = classQ.trim().toLocaleLowerCase(locale);
    return (vocab?.classes ?? []).filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.label.toLocaleLowerCase(locale).includes(q) ||
        label("ifcClass", c.name).toLocaleLowerCase(locale).includes(q),
    );
  }, [vocab, classQ, locale, label]);
  const props = useMemo(() => [...new Set((vocab?.properties ?? []).map((p) => p.name))].sort((a, b) => a.localeCompare(b, locale)), [vocab, locale]);

  const toggle = (list: string[] | undefined, item: string) => {
    const s = new Set(list ?? []);
    if (s.has(item)) s.delete(item);
    else s.add(item);
    return [...s];
  };
  const p = value.property;
  const propMode = !p ? "none" : p.equalsTarget ? "target" : "value";

  return (
    <div className="sim-rule-editor">
      <div className="sim-field">
        <span className="sim-field-label">{t("rule.fields.storey")}</span>
        <div className="sim-chips">
          {(vocab?.storeys ?? []).map((s) => (
            <label key={s.name} className="check sim-chip">
              <input type="checkbox" checked={!!value.storeys?.includes(s.name)} onChange={() => onChange({ ...value, storeys: toggle(value.storeys, s.name) })} />
              {s.name}
              <span className="muted"> ({s.count})</span>
            </label>
          ))}
          {!vocab?.storeys.length && <span className="muted small">{t("rule.noStoreys")}</span>}
        </div>
      </div>
      <div className="sim-field">
        <span className="sim-field-label">{t("rule.fields.class")}</span>
        <div>
          {(vocab?.classes.length ?? 0) > 12 && (
            <input value={classQ} onChange={(e) => setClassQ(e.target.value)} placeholder={t("rule.classSearch")} style={{ width: 180, marginBottom: 4 }} />
          )}
          <div className="sim-chips">
            {classes.map((c) => (
              <label key={c.name} className="check sim-chip" title={c.name}>
                <input type="checkbox" checked={!!value.classes?.includes(c.name)} onChange={() => onChange({ ...value, classes: toggle(value.classes, c.name) })} />
                {label("ifcClass", c.name)}
                <span className="muted"> ({c.count})</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="sim-field">
        <span className="sim-field-label">{t("rule.fields.nameContains")}</span>
        <input value={value.nameContains ?? ""} onChange={(e) => onChange({ ...value, nameContains: e.target.value })} placeholder={t("rule.namePlaceholder")} style={{ width: 200 }} />
      </div>
      <div className="sim-field">
        <span className="sim-field-label">{t("rule.fields.property")}</span>
        <div className="row wrap" style={{ gap: 6 }}>
          <select
            value={propMode}
            onChange={(e) => {
              const mode = e.target.value;
              if (mode === "none") onChange({ ...value, property: undefined });
              else if (mode === "target") onChange({ ...value, property: { key: p?.key ?? "", equalsTarget: "code" } });
              else onChange({ ...value, property: { key: p?.key ?? "", op: "=", value: "" } });
            }}
            aria-label={t("rule.propertyCondition")}
          >
            <option value="none">{t("rule.options.noProperty")}</option>
            <option value="value">{t("rule.options.propertyValue")}</option>
            <option value="target">{target === "cost" ? t("rule.options.propertyItemCode") : t("rule.options.propertyActivity")}</option>
          </select>
          {p && (
            <>
              <input
                list="sim-prop-names"
                value={p.key}
                onChange={(e) => onChange({ ...value, property: { ...p, key: e.target.value } })}
                placeholder={t("rule.propertyPlaceholder")}
                style={{ width: 180 }}
              />
              <datalist id="sim-prop-names">
                {props.slice(0, 300).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              {propMode === "value" && (
                <>
                  <select value={p.op ?? "="} onChange={(e) => onChange({ ...value, property: { ...p, op: e.target.value as "=" | "contains" } })} aria-label={t("rule.comparison")}>
                    <option value="=">=</option>
                    <option value="contains">{t("rule.options.contains")}</option>
                  </select>
                  <input value={p.value ?? ""} onChange={(e) => onChange({ ...value, property: { ...p, value: e.target.value } })} placeholder={t("rule.valuePlaceholder")} style={{ width: 140 }} />
                </>
              )}
              {propMode === "target" && target === "activity" && (
                <select value={p.equalsTarget} onChange={(e) => onChange({ ...value, property: { ...p, equalsTarget: e.target.value as "code" | "wbs" } })} aria-label={t("rule.matchedField")}>
                  <option value="code">{label("ruleTarget", "code")}</option>
                  <option value="wbs">{label("ruleTarget", "wbs")}</option>
                </select>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Drops empty parts before sending. */
export function cleanMatch(m: RuleMatch): RuleMatch {
  const out: RuleMatch = {};
  if (m.storeys?.length) out.storeys = m.storeys;
  if (m.classes?.length) out.classes = m.classes;
  if (m.nameContains?.trim()) out.nameContains = m.nameContains.trim();
  if (m.property?.key.trim()) out.property = { ...m.property, key: m.property.key.trim() };
  return out;
}

export const isEmptyMatch = (m: RuleMatch) => !Object.keys(cleanMatch(m)).length;
