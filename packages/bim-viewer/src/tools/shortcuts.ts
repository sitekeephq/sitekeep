/**
 * Model viewer keyboard shortcuts and the "?" help list. Letters are read from KeyboardEvent.key,
 * so they follow the user's layout (Turkish Q: "ı" and "i" both isolate); walking uses the
 * physical WASD keys (walk-math.ts).
 */

export type NavMode = "orbit" | "walk" | "plan";
export type MeasureTool = "length" | "area" | "angle" | "volume";

export type ToolCommand =
  | "nav:orbit"
  | "nav:walk"
  | "nav:plan"
  | "fit"
  | "section:plane"
  | "section:box"
  | "measure:length"
  | "hide"
  | "isolate"
  | "show_all"
  | "xray"
  | "screenshot"
  | "help"
  | "escape";

const BY_KEY: Record<string, ToolCommand> = {
  "1": "nav:orbit",
  "2": "nav:walk",
  "3": "nav:plan",
  f: "fit",
  k: "section:plane",
  b: "section:box",
  m: "measure:length",
  h: "hide",
  i: "isolate",
  ı: "isolate",
  u: "show_all",
  x: "xray",
  g: "screenshot",
  "?": "help",
  escape: "escape",
};

/** Letters the walk mode needs for itself (W A S D Q E). */
const WALK_LETTERS = new Set(["w", "a", "s", "d", "q", "e"]);

/** Key event → command, or null (modifier shortcuts and typing in fields are not ours). */
export function shortcutCommand(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ToolCommand | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLocaleLowerCase("tr-TR") : e.key.toLowerCase();
  if (WALK_LETTERS.has(key)) return null;
  return BY_KEY[key] ?? null;
}

/** Rows of the "?" help popover: keys → what they do. */
export const SHORTCUT_HELP: { keys: string; text: string }[] = [
  { keys: "1 · 2 · 3", text: "Yörünge · Yürüme · Plan" },
  { keys: "W A S D · Oklar", text: "Yürüme: ileri, sola, geri, sağa" },
  { keys: "Fare", text: "Yürüme: etrafa bak (tıklayınca imleç kilitlenir, Esc bırakır)" },
  { keys: "Shift", text: "Yürüme: koş" },
  { keys: "Q · E", text: "Yürüme: alçal · yüksel" },
  { keys: "Çift Tık", text: "Yörüngede zemine çift tık: oraya in ve yürü" },
  { keys: "F", text: "Sığdır" },
  { keys: "K", text: "Kesit düzlemi: bir yüze çift tıklayın" },
  { keys: "B", text: "Kesit kutusu (seçim ya da tüm model)" },
  { keys: "M", text: "Uzunluk ölç" },
  { keys: "H · I · U", text: "Seçimi gizle · yalnız seçimi göster · tümünü göster" },
  { keys: "X", text: "X-ışını (diğerlerini saydam yap)" },
  { keys: "G", text: "Görüntü al (PNG)" },
  { keys: "Esc", text: "Aracı ya da yürümeyi bırak" },
  { keys: "?", text: "Bu yardım" },
];

/** True when the event target is a text field (shortcuts must not fire while typing). */
/** Inputs that keep the focus after a click but take no text (panel check boxes, storey radios, the walk speed). */
const NON_TEXT_INPUTS = /^(checkbox|radio|range|button|submit|reset|color)$/i;

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "INPUT" && NON_TEXT_INPUTS.test(el.type ?? "")) return false;
  return el.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}
