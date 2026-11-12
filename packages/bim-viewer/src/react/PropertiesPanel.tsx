/**
 * Properties of the selected model element (right panel): IFC class and storey at the top, then the
 * attribute and property set groups. Every value can be copied.
 */
import { useEffect, useState } from "react";
import type { SelectedItem } from "../core/ViewerEngine.js";

/** Generic fallback; hosts can inject localized IFC labels. */
export function defaultClassLabel(category: string): string {
  const label = category
    .replace(/(standardcase|elementedcase)$/i, "")
    .replace(/^ifc/i, "");
  return label ? label.charAt(0).toUpperCase() + label.slice(1).toLowerCase() : category;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Insecure origin (http on the LAN): fall back to a hidden text area.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function PropertiesPanel({
  selected,
  onClose,
  classLabel = defaultClassLabel,
}: {
  selected: SelectedItem;
  onClose(): void;
  classLabel?: (category: string) => string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = (key: string, text: string) => {
    void copyText(text).then((ok) => ok && setCopied(key));
  };
  const copyButton = (id: string, text: string, what: string) => (
    <button type="button" className="ghost small vt-copy" title={`${what} kopyala`} aria-label={`${what} kopyala`} onClick={() => copy(id, text)}>
      {copied === id ? "✓" : "⧉"}
    </button>
  );

  return (
    <>
      <div className="row">
        <h3 style={{ margin: 0 }}>{selected.name ?? (selected.category ? classLabel(selected.category) : "Eleman")}</h3>
        <div className="spacer" />
        <button className="ghost small" aria-label="Seçimi kaldır" onClick={onClose}>
          ✕
        </button>
      </div>
      <dl className="vt-props-head">
        {selected.category && (
          <div>
            <dt>IFC Sınıfı</dt>
            <dd>
              {classLabel(selected.category)} <span className="muted mono small">{selected.category}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Kat</dt>
          <dd>{selected.storey ?? <span className="muted">—</span>}</dd>
        </div>
        {selected.globalId && (
          <div>
            <dt>GlobalId</dt>
            <dd className="mono small">
              {selected.globalId} {copyButton("gid", selected.globalId, "GlobalId'yi")}
            </dd>
          </div>
        )}
      </dl>
      {copied && (
        <div className="muted small" role="status">
          Kopyalandı.
        </div>
      )}
      {selected.groups.map((g, gi) => (
        <div key={`${g.name}-${gi}`} className="props-group">
          <h4>{g.name}</h4>
          <table className="props-table">
            <tbody>
              {g.rows.map(([k, v], i) => (
                <tr key={`${k}-${i}`}>
                  <td>{k}</td>
                  <td className="vt-prop-value">
                    <span>{v}</span>
                    {copyButton(`${gi}-${i}`, v, "Değeri")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
