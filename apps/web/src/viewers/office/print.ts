/**
 * "Yazdır / PDF olarak kaydet" for the browser views: the content to print is built into a
 * top-level #vw-print-root, the app is hidden by the print stylesheet (viewers.css) and the
 * browser's print dialog does the rest (A4 or slide-sized pages, a page per page / slide /
 * sheet). The layout is approximate; an exact PDF needs a converter on the server.
 */

export interface PrintPage {
  /** @page size: "A4", "A4 landscape", "10in 5.625in"… */
  size: string;
  /** @page margin ("0", "10mm"). */
  margin: string;
  /** Extra CSS (named pages for mixed page sizes). */
  css?: string;
}

let active: (() => void) | null = null;

/**
 * Builds the print content (and waits for it), waits for its images, opens the print dialog
 * and cleans up afterwards (`cleanup` releases what the build made, e.g. rendered slides).
 */
export async function printContent(build: (root: HTMLElement) => void | Promise<unknown>, page: PrintPage, cleanup?: () => void): Promise<void> {
  active?.();
  const root = document.createElement("div");
  root.id = "vw-print-root";
  const style = document.createElement("style");
  style.textContent = `@page { size: ${page.size}; margin: ${page.margin}; }\n${page.css ?? ""}`;
  document.head.appendChild(style);
  document.body.appendChild(root);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    cleanup?.();
    root.remove();
    style.remove();
    document.documentElement.classList.remove("vw-printing");
    window.removeEventListener("afterprint", done);
    document.removeEventListener("pointerdown", done);
    if (active === done) active = null;
  };
  active = done;
  try {
    await build(root);
  } catch (e) {
    done();
    throw e;
  }
  await Promise.all(Array.from(root.querySelectorAll("img"), (img) => img.decode().catch(() => undefined)));
  document.documentElement.classList.add("vw-printing");
  window.addEventListener("afterprint", done);
  window.print();
  // Browsers without a blocking print() or afterprint: clean up on the next click.
  setTimeout(() => document.addEventListener("pointerdown", done, { once: true }), 500);
}
