/**
 * Defence in depth for HTML made from office files in the browser (pptx slides, docx pages):
 * the libraries escape text, but a crafted file must still not run script, load remote
 * content or open javascript: links. Works on an inert <template> (nothing loads or runs).
 */

/** Elements that never stay (script, frames, embeds, forms, external styles, SVG script hooks). */
const DROP = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "foreignobject",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "handler",
  "listener",
]);

/** Image sources allowed: embedded data and blob URLs only. */
const SAFE_SRC = /^(data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml|x-emf|x-wmf|tiff);|blob:)/i;
const SAFE_LINK = /^(https?:|mailto:)/i;
/** url(...) in inline styles: embedded data, blob or a local fragment (#marker) only. */
const STYLE_URL = /url\(\s*(['"]?)(?!data:image\/|blob:|#)[^)]*\1\s*\)/gi;

export function sanitizeElement(root: Element | DocumentFragment): void {
  const all = Array.from(root.querySelectorAll("*"));
  for (const el of all) {
    const tag = el.localName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || name === "formaction" || name === "srcdoc" || name === "srcset") el.removeAttribute(attr.name);
      else if (name === "src" || name === "poster") {
        if (!SAFE_SRC.test(value)) el.removeAttribute(attr.name);
      } else if (name === "href" || name === "xlink:href") {
        // SVG references inside the slide (#marker) and embedded images stay; links only to the web.
        const ok = value.startsWith("#") || (tag === "image" && SAFE_SRC.test(value)) || (tag === "a" && SAFE_LINK.test(value));
        if (!ok) el.removeAttribute(attr.name);
      } else if (name === "style" && /url\(|expression\(|@import/i.test(value)) {
        el.setAttribute("style", value.replace(STYLE_URL, "none").replace(/expression\(|@import/gi, ""));
      }
    }
    if (tag === "a" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
}

/** Sanitized copy of an HTML string. */
export function sanitizeHtml(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  sanitizeElement(t.content);
  return t.innerHTML;
}
