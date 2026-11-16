import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewFolderDto, TemplateSlot } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { Icon } from "../../../shared/ui/Icon";

/** A folder of a template preview with its state, naming standard, gate and grants (keyboard: Enter / Space toggles). */
export function PreviewNode({ node, depth, slots }: { node: PreviewFolderDto; depth: number; slots: TemplateSlot[] }) {
  const { t } = useTranslation(["projects", "common"]);
  const levelLabel = useLabel();
  const [open, setOpen] = useState(depth < 1);
  const hasKids = !!node.children?.length;
  const label = (key: string) => (key === "*" ? t("wizard.preview.allRoles") : (slots.find((s) => s.key === key)?.label ?? key));
  return (
    <div>
      <div className="row" style={{ gap: 6, paddingLeft: depth * 16, minHeight: 26, flexWrap: "wrap" }}>
        {hasKids ? (
          <button
            type="button"
            className="tree-toggle ghost"
            aria-expanded={open}
            aria-label={open ? t("wizard.preview.collapse", { name: node.name }) : t("wizard.preview.expand", { name: node.name })}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <span className="row"><Icon name="folder" size={15} /> {node.name}</span>
        {node.state && <span className="badge info">{node.stateLabel ?? levelLabel("folderState", node.state)}</span>}
        {node.naming && <span className="badge" title={t("wizard.preview.namingStandard")}>{node.naming}</span>}
        {node.gate && <span className="badge warn">{t("wizard.preview.badges.gate")}</span>}
        {node.grants?.map((g) => (
          <span key={g.slot} className="badge ok" title={levelLabel("level", g.level)}>
            {t("wizard.preview.grant", { role: label(g.slot), level: levelLabel("level", g.level) })}
          </span>
        ))}
        {!!node.onDemandTotal && (
          <span className="muted small" title={node.onDemand?.join(", ")}>
            {t("wizard.template.onDemand", { count: node.onDemandTotal })}
          </span>
        )}
      </div>
      {open && node.children?.map((c) => <PreviewNode key={c.name} node={c} depth={depth + 1} slots={slots} />)}
    </div>
  );
}
