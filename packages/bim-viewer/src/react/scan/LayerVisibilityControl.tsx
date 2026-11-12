import React from "react";

function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m3 3 18 18" />
      <path d="M10.6 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-2.1 3.1M6.6 6.6C3.6 8.5 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6" />
    </svg>
  );
}

function LayerButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={`${label} katmanını ${active ? "kapat" : "aç"}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 30,
        padding: "0 10px",
        border: active ? "1px solid color-mix(in srgb, var(--primary) 70%, #15803d)" : "1px solid transparent",
        borderRadius: 7,
        background: active ? "color-mix(in srgb, var(--primary) 18%, var(--background-100))" : "var(--background-200)",
        color: active ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        opacity: active ? 1 : 0.72,
      }}
    >
      <EyeIcon visible={active} />
      {label}
    </button>
  );
}

export function LayerVisibilityControl({
  modelVisible,
  lasVisible,
  onModelVisible,
  onLasVisible,
}: {
  modelVisible: boolean;
  lasVisible: boolean;
  onModelVisible: (visible: boolean) => void;
  onLasVisible: (visible: boolean) => void;
}) {
  return (
    <div
      data-layer-control="true"
      style={{
        position: "absolute",
        top: 14,
        right: 16,
        zIndex: 2100,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 6,
        border: "1px solid color-mix(in srgb, var(--text-muted) 35%, transparent)",
        borderRadius: 10,
        background: "color-mix(in srgb, var(--background-100) 94%, transparent)",
        color: "var(--text)",
        boxShadow: "0 10px 28px rgba(0,0,0,.18)",
        backdropFilter: "blur(10px)",
      }}
    >
      <span style={{ padding: "0 5px", color: "var(--text-muted)", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>
        Katmanlar
      </span>
      <LayerButton label="Model" active={modelVisible} onClick={() => onModelVisible(!modelVisible)} />
      <LayerButton label="LAS" active={lasVisible} onClick={() => onLasVisible(!lasVisible)} />
    </div>
  );
}
