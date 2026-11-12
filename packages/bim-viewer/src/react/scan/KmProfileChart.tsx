import React from "react";
import type { LimitBand } from "../../scan/iot/dataView.js";

type Chart = import("chart.js").Chart;

/**
 * The km range chart of the earlier IoT viewer (Chart.js, same options): a filled line over every
 * survey position, AL / IL / IAL limit lines with their legend, value tooltips, up to 40 rotated
 * km labels. Chart.js loads on first use, so hosts that never open the chart do not pay for it.
 */
export function KmProfileChart({
  labels,
  values,
  title,
  unit,
  limits,
  height = 420,
}: {
  labels: string[];
  values: Array<number | null>;
  title: string;
  unit: string;
  limits?: { AL?: LimitBand; IL?: LimitBand; IAL?: LimitBand };
  height?: number;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const chartRef = React.useRef<Chart | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    void import("chart.js/auto")
      .then(({ default: ChartJs }) => {
        if (cancelled) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const style = getComputedStyle(canvas);
        const text = style.getPropertyValue("--text-muted").trim() || "#9ca3af";
        const grid = "rgba(127, 127, 127, 0.22)";
        const n = labels.length;
        const limitDatasets = (["AL", "IL", "IAL"] as const).flatMap((key) => {
          const limit = limits?.[key];
          const color = { AL: "#eab308", IL: "#f97316", IAL: "#ef4444" }[key];
          if (!limit) return [];
          const line = (label: string, value: number) => ({
            label,
            data: Array<number>(n).fill(value),
            borderColor: color,
            borderDash: [6, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0,
          });
          return [line(`${key} +${limit.max}`, limit.max), line(`${key} ${limit.min}`, limit.min)];
        });
        chartRef.current?.destroy();
        chartRef.current = new ChartJs(ctx, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: title,
                data: values,
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.15)",
                pointRadius: n > 200 ? 0 : 2,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.2,
                borderWidth: 1.5,
              },
              ...limitDatasets,
            ],
          },
          options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: {
                labels: {
                  color: text,
                  font: { size: 10 },
                  boxWidth: 20,
                  // The lower limit lines repeat the upper ones' colour; the legend lists each limit once.
                  filter: (item) => !/^(AL|IL|IAL) -/.test(item.text),
                },
              },
              tooltip: {
                filter: (item) => item.datasetIndex === 0,
                callbacks: {
                  title: (items) => items[0]?.label ?? "",
                  label: (item) => `${item.raw == null ? "—" : (item.raw as number).toFixed(3)} ${unit}`,
                },
              },
            },
            scales: {
              x: { ticks: { color: text, font: { size: 9 }, maxRotation: 60, maxTicksLimit: Math.min(n, 40) }, grid: { color: grid } },
              y: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid } },
            },
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [labels, values, title, unit, limits]);

  React.useEffect(() => () => chartRef.current?.destroy(), []);

  return (
    <div style={{ position: "relative", height }}>
      <canvas ref={canvasRef} role="img" aria-label={title} />
    </div>
  );
}
