/**
 * Markup shapes drawn on top of a PDF page. Shapes are stored in PDF user space and converted
 * to page pixels with the pdf.js viewport, so they follow zoom and page rotation.
 */
import type { MarkupShape, PdfPoint } from "@sitekeep/shared";

export type Px = [number, number];

export interface Projection {
  /** PDF user space → page pixels. */
  toPx(p: PdfPoint): Px;
  /** Page pixels → PDF user space. */
  toPdf(p: Px): PdfPoint;
  /** Pixels per PDF point. */
  scale: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Translation keys of the shape names (documents namespace). */
export const SHAPE_LABEL_KEYS = {
  pen: "documents:shapes.pen",
  rect: "documents:shapes.rect",
  cloud: "documents:shapes.cloud",
  arrow: "documents:shapes.arrow",
  text: "documents:shapes.text",
} as const satisfies Record<MarkupShape["type"], string>;

function boxOf(a: Px, b: Px): Box {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** Bounding box of a shape in page pixels. */
export function shapeBox(shape: MarkupShape, pr: Projection): Box {
  switch (shape.type) {
    case "pen": {
      const pts = shape.points.map(pr.toPx);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case "text": {
      const [x, y] = pr.toPx(shape.at);
      const lines = shape.text.split("\n");
      const size = shape.size * pr.scale;
      return { x, y, w: Math.max(...lines.map((l) => l.length)) * size * 0.58, h: lines.length * size * 1.2 };
    }
    default:
      return boxOf(pr.toPx(shape.from), pr.toPx(shape.to));
  }
}

export function unionBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bottom - y };
}

/** Revision cloud: arcs bulging outwards along the rectangle, drawn clockwise. */
function cloudPath(b: Box, step: number): string {
  const pts: Px[] = [];
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let i = 0; i < n; i++) pts.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
  };
  edge(b.x, b.y, b.x + b.w, b.y);
  edge(b.x + b.w, b.y, b.x + b.w, b.y + b.h);
  edge(b.x + b.w, b.y + b.h, b.x, b.y + b.h);
  edge(b.x, b.y + b.h, b.x, b.y);
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length]!;
    const q = pts[i - 1]!;
    const r = Math.max(1, Math.hypot(p[0] - q[0], p[1] - q[1]) / 2);
    d += ` A ${r} ${r} 0 0 1 ${p[0]} ${p[1]}`;
  }
  return `${d} Z`;
}

function arrowHead(from: Px, to: Px, size: number): string {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const p1: Px = [to[0] - size * Math.cos(a - 0.45), to[1] - size * Math.sin(a - 0.45)];
  const p2: Px = [to[0] - size * Math.cos(a + 0.45), to[1] - size * Math.sin(a + 0.45)];
  return `${to[0]},${to[1]} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`;
}

/**
 * SVG for one shape. `hit` adds a wide invisible stroke so thin lines are easy to click.
 */
export function ShapeSvg({ shape, pr, hit }: { shape: MarkupShape; pr: Projection; hit?: boolean }) {
  const sw = Math.max(1, shape.width * pr.scale);
  const common = { stroke: shape.color, strokeWidth: sw, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const hitProps = hit
    ? { stroke: "#000", strokeOpacity: 0, strokeWidth: Math.max(12, sw + 8), fill: "none", pointerEvents: "stroke" as const }
    : null;
  switch (shape.type) {
    case "pen": {
      const points = shape.points.map((p) => pr.toPx(p).join(",")).join(" ");
      return (
        <>
          <polyline points={points} {...common} />
          {hitProps && <polyline points={points} {...hitProps} />}
        </>
      );
    }
    case "rect": {
      const b = boxOf(pr.toPx(shape.from), pr.toPx(shape.to));
      return (
        <>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} {...common} />
          {hitProps && <rect x={b.x} y={b.y} width={b.w} height={b.h} {...hitProps} />}
        </>
      );
    }
    case "cloud": {
      const b = boxOf(pr.toPx(shape.from), pr.toPx(shape.to));
      const d = cloudPath(b, Math.max(6, Math.min(14 * pr.scale, Math.min(b.w, b.h) / 2 || 6)));
      return (
        <>
          <path d={d} {...common} />
          {hitProps && <path d={d} {...hitProps} />}
        </>
      );
    }
    case "arrow": {
      const a = pr.toPx(shape.from);
      const b = pr.toPx(shape.to);
      const head = arrowHead(a, b, Math.max(8, sw * 4));
      return (
        <>
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />
          <polygon points={head} fill={shape.color} stroke={shape.color} strokeWidth={sw} strokeLinejoin="round" />
          {hitProps && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...hitProps} />}
        </>
      );
    }
    case "text": {
      const [x, y] = pr.toPx(shape.at);
      const size = shape.size * pr.scale;
      const box = shapeBox(shape, pr);
      return (
        <>
          <text x={x} y={y} fontSize={size} fill={shape.color} dominantBaseline="hanging" style={{ fontFamily: "Segoe UI, Arial, sans-serif", whiteSpace: "pre" }}>
            {shape.text.split("\n").map((line, i) => (
              <tspan key={i} x={x} dy={i === 0 ? 0 : size * 1.2}>
                {line || " "}
              </tspan>
            ))}
          </text>
          {hit && <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="#000" fillOpacity={0} pointerEvents="all" />}
        </>
      );
    }
  }
}
