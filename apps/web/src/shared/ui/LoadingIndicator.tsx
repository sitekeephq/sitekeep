import { useTranslation } from "react-i18next";

export function LoadingSpinner({ className = "" }: { className?: string }) {
  return <span className={`loading-spinner${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

export function LoadingIndicator({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`loading-state${compact ? " compact" : ""}${className ? ` ${className}` : ""}`} role="status" aria-label={t("status.loading")}>
      <LoadingSpinner />
    </div>
  );
}
