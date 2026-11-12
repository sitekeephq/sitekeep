import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PRIVACY_CHANGED_EVENT, privacyApi } from "../../shared/api/api-privacy";
import { useAuth } from "../context/auth";
import { TopBar } from "./TopBar";

export function Shell() {
  const { user } = useAuth();

  return (
    <div className="app">
      <TopBar />
      {user?.isAdmin && <KillSwitchBanner />}
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function KillSwitchBanner() {
  const { t } = useTranslation("shell");
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void privacyApi.status().then(
        (status) => alive && setOn(status.killSwitch),
        () => undefined,
      );
    load();
    window.addEventListener(PRIVACY_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(PRIVACY_CHANGED_EVENT, load);
    };
  }, []);

  if (!on) return null;

  return (
    <div className="privacy-banner" role="status">
      {t("privacyBanner.message")} <Link to="/administration?tab=privacy">{t("privacyBanner.link")}</Link>
    </div>
  );
}
