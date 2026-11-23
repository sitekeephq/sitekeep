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

  // While the temporary password stands, the server answers only the change and sign-out routes
  // (403 password_change_required), so the app behind the dialog is not mounted at all.
  if (user?.mustChangePassword) return <ForcePasswordChange />;
  return <AppRoutes user={user} />;
}
