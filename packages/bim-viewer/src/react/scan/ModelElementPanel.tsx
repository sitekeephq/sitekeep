import React from "react";
import * as THREE from "three";
import type { IfcMeshMeta } from "../../scan/layers/ifcMesh.js";
import type { ScanElementSelection } from "../../scan/selection/scanSelection.js";

function number(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "112px 1fr", gap: 10, padding: "7px 0", borderBottom: "1px solid color-mix(in srgb, var(--text-muted) 18%, transparent)" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <strong style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{value}</strong>
    </div>
  );
}

export function ModelElementPanel({
  selection,
  meta,
  onClose,
}: {
  selection: ScanElementSelection;
  meta?: IfcMeshMeta;
  onClose: () => void;
}) {
  const size = selection.box.getSize(new THREE.Vector3());
  const center = selection.box.getCenter(new THREE.Vector3());
  const part = meta?.parts?.[selection.part];
  const totalElements = selection.part === "sleepers" ? meta?.counts?.sleepers : meta?.counts?.rails;

  React.useEffect(() => {
    const panel = document.querySelector('[data-model-panel="true"]');
    if (!panel) return;
    const stop = (event: Event) => event.stopPropagation();
    panel.addEventListener("wheel", stop);
    return () => panel.removeEventListener("wheel", stop);
  }, []);

  return (
    <aside
      data-model-panel="true"
      style={{
        position: "absolute",
        top: 64,
        right: 16,
        zIndex: 1300,
        width: 310,
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
        overscrollBehavior: "contain",
        border: "1px solid #38bdf8",
        borderRadius: 12,
        background: "color-mix(in srgb, var(--background-100) 96%, transparent)",
        color: "var(--text)",
        boxShadow: "0 18px 44px rgba(0,0,0,.24)",
        backdropFilter: "blur(12px)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid color-mix(in srgb, var(--text-muted) 24%, transparent)" }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>Model bilgileri</div>
          <div style={{ marginTop: 2, fontSize: 15, fontWeight: 700 }}>{selection.label}</div>
        </div>
        <button
          type="button"
          aria-label="Seçimi temizle"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            minWidth: 28,
            padding: 0,
            border: 0,
            borderRadius: 7,
            background: "var(--background-200)",
            color: "var(--text)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div style={{ padding: "5px 14px 14px", fontSize: 12 }}>
        <Row label="Kaynak IFC" value={meta?.source || "—"} />
        <Row label="Eleman türü" value={selection.part === "sleepers" ? "Travers" : selection.part === "rails" ? "Ray" : selection.part} />
        <Row label="Eleman no" value={`${selection.elementIndex + 1}${totalElements ? ` / ${totalElements}` : ""}`} />
        <Row label="Geometri" value={`${Math.floor((selection.vertexEnd - selection.vertexStart) / 3).toLocaleString("tr-TR")} üçgen`} />
        <Row label="Parça toplamı" value={part?.triangles ? `${part.triangles.toLocaleString("tr-TR")} üçgen` : "—"} />
        <Row label="Boyut X/Y/Z" value={`${number(size.x)} × ${number(size.y)} × ${number(size.z)} m`} />
        <Row label="Merkez X" value={number(center.x, 3)} />
        <Row label="Merkez Y" value={number(center.y, 3)} />
        <Row label="Merkez Z" value={number(center.z, 3)} />
        <Row label="Sahne dosyası" value={part?.file || "—"} />
        <p style={{ marginTop: 12, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
          Optimize edilmiş sahne geometri metadata’sını içeriyor. IFC property set’leri (Pset, malzeme, GUID vb.) bu binary dosyaya aktarılmamış.
        </p>
      </div>
    </aside>
  );
}
