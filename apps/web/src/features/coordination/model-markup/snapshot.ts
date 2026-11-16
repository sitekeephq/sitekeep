/**
 * Burns a markup into the viewpoint snapshot, so the picture that travels with the markup (issue,
 * BCF export) shows the drawing or the pin: the live overlay SVG is serialised and drawn over the
 * viewer's snapshot, scaled from the overlay's CSS size to the snapshot's pixel size.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}

export async function composeSnapshot(
  base: string | undefined,
  overlay: { svg?: SVGSVGElement | null; pin?: { x: number; y: number; color: string } | null; width: number; height: number },
): Promise<string | undefined> {
  if (!base || overlay.width <= 0 || overlay.height <= 0) return base;
  try {
    const img = await loadImage(base);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return base;
    ctx.drawImage(img, 0, 0);
    const sx = canvas.width / overlay.width;
    const sy = canvas.height / overlay.height;
    if (overlay.svg) {
      const clone = overlay.svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(overlay.width));
      clone.setAttribute("height", String(overlay.height));
      clone.setAttribute("viewBox", `0 0 ${overlay.width} ${overlay.height}`);
      const text = new XMLSerializer().serializeToString(clone);
      const drawing = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`);
      ctx.drawImage(drawing, 0, 0, canvas.width, canvas.height);
    }
    if (overlay.pin) {
      const r = Math.max(6, 9 * sx);
      ctx.beginPath();
      ctx.arc(overlay.pin.x * sx, overlay.pin.y * sy, r, 0, Math.PI * 2);
      ctx.fillStyle = overlay.pin.color;
      ctx.fill();
      ctx.lineWidth = Math.max(2, 2 * sx);
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return base;
  }
}
