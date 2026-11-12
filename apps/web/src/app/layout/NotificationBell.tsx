import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { NotificationDto } from "@sitekeep/shared";
import { api, formatDate } from "../../shared/api/api";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";

const POLL_MS = 30_000;

/** Top-bar bell: unread count, polled; the dropdown lists recent notifications (unread first). */
export function NotificationBell() {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api.notificationCount().then(
        (r) => alive && setUnread(r.unread),
        () => undefined,
      );
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    api.notifications().then(setItems, () => setItems([]));
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  async function openItem(n: NotificationDto) {
    if (!n.readAt) {
      await api.readNotification(n.id).catch(() => undefined);
      setUnread((u) => Math.max(0, u - 1));
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  }

  async function readAll() {
    await api.readAllNotifications().catch(() => undefined);
    setUnread(0);
    setItems((list) => list?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? null);
  }

  return (
    <div className="bell" ref={box}>
      <button className="topbar-icon" aria-label={t("notifications.unreadLabel", { count: unread })} title={t("notifications.title")} onClick={() => setOpen((o) => !o)}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="bell-menu">
          <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
            <strong>{t("notifications.title")}</strong>
            <div className="spacer" />
            {unread > 0 && (
              <button className="small" onClick={() => void readAll()}>
                {t("notifications.actions.readAll")}
              </button>
            )}
          </div>
          {items === null && <LoadingIndicator compact />}
          {items?.length === 0 && <div className="muted small" style={{ padding: 12 }}>{t("notifications.empty")}</div>}
          {items?.map((n) => (
            <div
              key={n.id}
              className={`bell-item${n.readAt ? "" : " unread"}`}
              onClick={() => void openItem(n)}
              role="button"
              tabIndex={0}
            >
              <div className="small">{n.title}</div>
              {n.body && <div className="small muted">{n.body}</div>}
              <div className="small muted">{formatDate(n.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
