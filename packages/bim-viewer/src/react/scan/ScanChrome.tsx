/**
 * Viewer üst katmanları: yükleniyor, hata, durum metni.
 * 3D sahneye dokunmaz; sadece DOM overlay.
 */
import React from "react";
import { createPortal } from "react-dom";

export type ScanLoadStep = {
  id: string;
  label: string;
  done: boolean;
};

export function LoadingOverlay({
  show,
  title = "Yükleniyor...",
  detail,
  steps,
}: {
  show: boolean;
  title?: string;
  detail?: string;
  steps?: ScanLoadStep[];
}) {
  if (!show || typeof document === "undefined") return null;
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        background: "var(--background)",
        color: "var(--text)",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "3px solid var(--background-200)",
          borderTopColor: "var(--primary)",
          animation: "ob-spin 0.7s linear infinite",
        }}
      />
      <div style={{ fontSize: 16, fontWeight: 650 }}>{title}</div>
      {detail ? (
        <div style={{ fontSize: 13, opacity: 0.7 }}>{detail}</div>
      ) : null}
      {steps?.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4, minWidth: 220 }}>
          {steps.map((step) => (
            <div
              key={step.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 13,
                opacity: step.done ? 1 : 0.55,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: step.done ? "var(--primary)" : "var(--text-muted)",
                }}
              />
              {step.label}
              {step.done ? " · hazır" : ""}
            </div>
          ))}
        </div>
      ) : null}
      <style>{`@keyframes ob-spin { to { transform: rotate(360deg); } }`}</style>
    </div>,
    document.body
  );
}

export function ErrorOverlay({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        color: "white",
        fontSize: "1.2rem",
        background: "rgba(255,0,0,0.7)",
        padding: "10px 20px",
        borderRadius: "4px",
        zIndex: 1500,
      }}
    >
      Hata: {message}
    </div>
  );
}

export function scanStatusText(
  isScan: boolean,
  scanIfcStatus: "off" | "loading" | "ready" | "error"
) {
  if (isScan) {
    if (scanIfcStatus === "loading") return "Güzergah modeli yükleniyor · LAS ve ölçümler hazır";
    if (scanIfcStatus === "error") return "Balıkesir Susurluk · LAS + ölçüm · ray modeli henüz hazır değil";
    if (scanIfcStatus === "ready") return "Balıkesir Susurluk · LAS + Güzergah + ölçüm noktaları";
    return "Balıkesir Susurluk · LAS + ölçüm noktaları";
  }
  return "Model yüklendi · IoT (ekartman / dever)";
}
