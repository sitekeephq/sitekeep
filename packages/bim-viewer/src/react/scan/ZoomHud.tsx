/**
 * Sol üst Reset + zoom çubuğu.
 * Oran 1×–10×; MAX, raya yaklaşınca (SCAN_CLOSE_DISTANCE) görünür.
 */
import React from "react";

export interface ZoomHudState {
  ratio: number;
  percent: number;
  atMax: boolean;
  ready: boolean;
}

interface Props {
  visible: boolean;
  zoom: ZoomHudState;
  status?: string | null;
  onReset: () => void;
  onZoomPercent: (percent: number) => void;
}

export function ZoomHud({ visible, zoom, status, onReset, onZoomPercent }: Props) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 16,
        top: 16,
        zIndex: 1100,
        width: 168,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {status && (
        <div
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.22)",
            background: "rgba(15, 23, 42, 0.82)",
            color: "#f8fafc",
            fontSize: 11,
            lineHeight: 1.35,
            fontWeight: 500,
            pointerEvents: "none",
          }}
        >
          {status}
        </div>
      )}
      <button
        type="button"
        onClick={onReset}
        style={{
          height: 36,
          padding: "0 14px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.22)",
          background: "rgba(15, 23, 42, 0.82)",
          color: "#f8fafc",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reset
      </button>
      {zoom.ready && (
        <div
          style={{
            padding: "10px 12px 12px",
            borderRadius: 8,
            border: zoom.atMax ? "1px solid rgba(251, 146, 60, 0.7)" : "1px solid rgba(255,255,255,0.22)",
            background: "rgba(15, 23, 42, 0.82)",
            color: "#f8fafc",
            userSelect: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 8,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, letterSpacing: 0.3, opacity: 0.72 }}>Zoom</span>
            <strong style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
              {zoom.atMax ? "MAX" : `${zoom.ratio.toFixed(1)}×`}
            </strong>
          </div>
          <div style={{ position: "relative", height: 8, marginBottom: 6 }}>
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 99,
                background: "rgba(255,255,255,0.12)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${zoom.percent}%`,
                  height: "100%",
                  background: zoom.atMax ? "#fb923c" : "#38bdf8",
                }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={zoom.percent}
              onChange={(event) => onZoomPercent(Number(event.target.value))}
              aria-label="Yakınlaştırma oranı"
              style={{
                position: "absolute",
                inset: "-6px 0",
                width: "100%",
                margin: 0,
                opacity: 0,
                cursor: "pointer",
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, opacity: 0.65 }}>
            <span>1.0×</span>
            <span style={{ color: zoom.atMax ? "#fdba74" : "inherit", opacity: 1 }}>
              {zoom.atMax ? "MAX · 10×" : `${zoom.percent}%`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
