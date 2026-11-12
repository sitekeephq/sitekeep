import { useTranslation } from "react-i18next";
import { BrandMark } from "../shared/ui/BrandMark";
import { ForcePasswordChange } from "../features/auth/components/ForcePasswordChange";
import { useAuth } from "./context/auth";
import { AppRoutes } from "./routes/AppRoutes";

export function App() {
  const { user, loading } = useAuth();
  const { t } = useTranslation("shell");

  if (loading) {
    return (
      <div className="login-loading" role="status">
        <BrandMark size={36} />
        <span>{t("app.loading")}</span>
      </div>
    );
  }

  return (
    <>
      <AppRoutes user={user} />
      {user?.mustChangePassword ? <ForcePasswordChange /> : null}
    </>
  );
}
