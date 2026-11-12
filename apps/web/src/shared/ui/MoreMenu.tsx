import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

export interface MoreMenuItem<K extends string = string> {
  key: K;
  label: string;
  /** On/off item: a check mark when true (role menuitemcheckbox). */
  checked?: boolean;
  /** Shown but not clickable; `note` explains why (e.g. "Çevrimdışı"). */
  disabled?: boolean;
  note?: string;
}

const EDGE = 8;

/**
 * "⋯ Diğer": a button with a small menu of the actions that do not fit a phone toolbar. Closes on
 * a choice, a tap outside or Escape. Renders nothing without items.
 */
export function MoreMenu<K extends string>({
  items,
  onSelect,
  label,
  defaultOpen = false,
}: {
  items: MoreMenuItem<K>[];
  onSelect(key: K): void;
  label?: string;
  /** Start open (tests). */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(defaultOpen);
  const text = label ?? t("moreMenu.label");
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Fixed to the viewport so a clipping parent cannot cut it; right-aligned to the button when it fits.
  useLayoutEffect(() => {
    if (!open || !ref.current || !list.current) return;
    const place = () => {
      const button = ref.current!.getBoundingClientRect();
      const width = list.current!.offsetWidth;
      const left = Math.min(Math.max(EDGE, button.right - width), window.innerWidth - width - EDGE);
      setPos({ position: "fixed", top: button.bottom + 6, left, right: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="more-menu" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setPos(undefined);
          setOpen((v) => !v);
        }}
      >
        <span aria-hidden="true">⋯</span> {text}
      </button>
      {open && (
        <ul
          ref={list}
          className="more-menu-list"
          role="menu"
          aria-label={text}
          style={pos ?? { visibility: "hidden" }}
        >
          {items.map((it) => (
            <li key={it.key} role="none">
              <button
                type="button"
                role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={it.checked}
                disabled={it.disabled}
                title={it.disabled ? it.note : undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(it.key);
                }}
              >
                <span className="more-menu-check" aria-hidden="true">
                  {it.checked ? "✓" : ""}
                </span>
                <span className="more-menu-label">{it.label}</span>
                {it.note && <span className="more-menu-note">{it.note}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
