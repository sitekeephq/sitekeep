import React from "react";
export type IotToolbarAction = "list" | "detail" | "sprites" | "heatmap" | "range";

const ACTIONS: { id: IotToolbarAction; label: string; title: string }[] = [
  { id: "list", label: "Liste", title: "Sensör listesi" },
  { id: "detail", label: "Detay", title: "Sensör detayı" },
  { id: "sprites", label: "Noktalar", title: "IoT noktalarını göster/gizle" },
  { id: "heatmap", label: "Heatmap", title: "Hat heatmap" },
  { id: "range", label: "Km", title: "Km aralık grafiği" },
];

export function ScanIotToolbar({
  active,
  onToggle,
}: {
  active: readonly string[];
  onToggle: (action: IotToolbarAction) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="IoT araçları"
      style={{
        position: "absolute",
        left: 16,
        bottom: 16,
        zIndex: 1200,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        maxWidth: "min(100% - 32px, 420px)",
      }}
    >
      {ACTIONS.map(({ id, label, title }) => {
        const isActive = active.includes(id);
        return (
          <button
            key={id}
            type="button"
            title={title}
            data-iot-action={id}
            onClick={() => onToggle(id)}
            style={{
              border: `1px solid ${isActive ? "#3b66f5" : "var(--border-color, #d0d5dd)"}`,
              background: isActive ? "#3b66f5" : "var(--panel-bg, rgba(255,255,255,.94))",
              color: isActive ? "#fff" : "var(--text, #101828)",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(16,24,40,.08)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
