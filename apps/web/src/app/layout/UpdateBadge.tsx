import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { updatesApi, type UpdatesDto } from "../../shared/api/api-updates";
import { UPDATES_EVENT } from "../../features/admin/pages/AdminUpdates";
import { useAuth } from "../context/auth";

const DISMISSED = "sitekeep.updateBadgeDismissed";

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}

/**
 * Top bar, administrators only: a small badge when a newer release is known (Administration → System Status
 * has the details). It reads what the server already knows; it makes no outside call. Dismissed per version, per browser.
 */
export function UpdateBadge() {
  const { user } = useAuth();
  return user?.isAdmin ? <UpdateBadgeForAdmin /> : null;
}

function UpdateBadgeForAdmin() {
  const { t } = useTranslation("shell");
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(dismissedVersion);

  useEffect(() => {
    let alive = true;
    updatesApi.get().then(
      (r) => alive && setVersion(r.updateAvailable && r.latest ? r.latest.version : null),
      () => undefined,
    );
    const onChange = (e: Event) => {
      const r = (e as CustomEvent<UpdatesDto>).detail;
      setVersion(r.updateAvailable && r.latest ? r.latest.version : null);
    };
    window.addEventListener(UPDATES_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(UPDATES_EVENT, onChange);
    };
  }, []);

  if (!version || dismissed === version) return null;
  const v = version;
  function dismiss() {
    try {
      localStorage.setItem(DISMISSED, v);
    } catch {
      // Without storage it comes back at the next visit.
    }
    setDismissed(v);
  }
  return (
    <span className="topbar-update">
      <Link to="/administration?tab=status" className="badge info" title={t("topbar.updateTitle", { version: v })}>
        {t("topbar.update", { version: v })}
      </Link>
      <button type="button" className="topbar-update-close" aria-label={t("topbar.updateDismiss")} title={t("topbar.updateDismiss")} onClick={dismiss}>
        ×
      </button>
    </span>
  );
}
