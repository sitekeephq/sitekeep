/**
 * Top bar language menu (left of "Product tour") and the same choice on the sign-in page. Lists every
 * language under i18n/locales; the choice is remembered in the browser and, when signed in, in the
 * user's profile (prefs.language), so it follows the user to other devices.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, currentLanguage, setLanguage } from "../../i18n";
import { hubApi } from "../../shared/api/api-hub";
import { Icon } from "../../shared/ui/Icon";

/** Switches, remembers in the browser and (signed in) in the profile. Best effort for the profile. */
async function chooseLanguage(code: string, signedIn: boolean) {
  const lang = await setLanguage(code);
  if (signedIn) await hubApi.setPrefs({ language: lang }).catch(() => undefined);
}

/**
 * The same choice as rows of the account menu: phones have no room for the top bar button
 * (styles.css hides one or the other by width).
 */
export function LanguageMenuItems({ onChosen }: { onChosen(): void }) {
  const { t } = useTranslation("shell");
  if (LANGUAGES.length < 2) return null;
  const active = currentLanguage();
  return (
    <div className="menu-language-rows" role="group" aria-label={t("language.title")}>
      <div className="menu-heading">{t("language.title")}</div>
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          role="menuitemradio"
          aria-checked={l.code === active}
          className={`menu-item${l.code === active ? " selected" : ""}`}
          lang={l.code}
          onClick={() => {
            onChosen();
            void chooseLanguage(l.code, true);
          }}
        >
          <span className="mono-tag">{l.short}</span>
          <span className="menu-item-text">{l.name}</span>
          {l.code === active && <Icon name="tick" />}
        </button>
      ))}
    </div>
  );
}

export function LanguageSwitcher({ signedIn, variant = "topbar" }: { signedIn: boolean; variant?: "topbar" | "plain" }) {
  const { t, i18n } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const active = LANGUAGES.find((l) => l.code === currentLanguage()) ?? LANGUAGES[0]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (LANGUAGES.length < 2) return null;

  const choose = async (code: string) => {
    setOpen(false);
    await chooseLanguage(code, signedIn);
  };

  return (
    <div className="topbar-popover" ref={box}>
      <button
        type="button"
        className={variant === "topbar" ? "topbar-link topbar-language" : "language-plain"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("language.choose", { language: active.name })}
        title={t("language.title")}
        onClick={() => setOpen((o) => !o)}
        lang={i18n.language}
      >
        <Icon name="globe" />
        <span>{active.short}</span>
      </button>
      {open && (
        <div className="menu menu-language" role="menu" aria-label={t("language.title")}>
          <div className="menu-heading">{t("language.title")}</div>
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              role="menuitemradio"
              aria-checked={l.code === active.code}
              className={`menu-item${l.code === active.code ? " selected" : ""}`}
              lang={l.code}
              onClick={() => void choose(l.code)}
            >
              <span className="mono-tag">{l.short}</span>
              <span className="menu-item-text">{l.name}</span>
              {l.status === "beta" && <span className="menu-item-hint">{t("language.beta")}</span>}
              {l.code === active.code && <Icon name="tick" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
