import { useEffect, useMemo, useState } from "react";
import { webModules } from "../../../app/modules";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { webCapability } from "../../../sdk/capabilities";
import { resolveModules, type HubViewKey, type NewRecordKind, type SavedViewDto } from "@sitekeep/shared";
import { hubApi } from "../../../shared/api/api-hub";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmbeddedContext } from "../../../app/context/embedded";
import { NewRecordDialog } from "../components/NewRecordDialog";
import { NavIcon } from "../../../shared/ui/NavIcon";
import { HUB_LABELS, HUB_VIEWS, type HubView } from "../../../app/navigation/nav";
import { useLoad, useProject } from "../../../app/context/project";
import { filtersOfSearch, hubViewFilters, rememberHubFilters, rememberHubPath } from "../../../shared/lib/remember";
import { hubListPath, hubViewPath, placeOf } from "../../../app/navigation/routes-table";

/** "+ Yeni" tiles shown first (one is preselected) in each view. */
const PREFERRED: Partial<Record<HubViewKey, NewRecordKind[]>> = {
  yazismalar: ["gelen-yazi", "giden-yazi"],
  "bilgi-talepleri": ["rfi"],
  "teknik-onaylar": ["submittal"],
  toplantilar: ["meeting", "action"],
  gonderimler: ["transmittal"],
  sorunlar: ["issue"],
  incelemeler: ["review"],
  formlar: ["form"],
};

/** Views whose list takes a dropped file ("Bırak, kaydet"); Sorunlar, İncelemeler and Formlar have their own pages. */
const DROP_VIEWS = new Set<HubViewKey>(["bana", "tum", "yazismalar", "bilgi-talepleri", "teknik-onaylar", "gonderimler"]);

/** These records already have first-level entries in the main project navigation. */
const MAIN_NAV_VIEWS = new Set<HubViewKey>(["sorunlar", "incelemeler", "formlar"]);

/**
 * "İşler": one hub for every record that waits for someone. A view list (vertical on desktop, a
 * select on phones) with the built-in views and the user's saved views; Sorunlar, İncelemeler and
 * Formlar render their own pages inside. One "+ Yeni" button, "Görünümü Kaydet" for the filters.
 */
export function WorksHub() {
  const { t } = useTranslation(["works", "common"]);
  const { t: ts } = useTranslation("shell");
  const project = useProject();
  const location = useLocation();
  const navigate = useNavigate();
  const base = `/projects/${project.id}`;
  const rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : "";
  const place = placeOf(rest, location.search);
  const viewKey: HubViewKey = place?.hubView ?? "tum";
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const activeSavedId = params.get("gorunum");
  const modules = project.modules ?? resolveModules(null);
  const installed = new Set(webModules.map((m) => m.id));
  const views = HUB_VIEWS.filter((v) => !MAIN_NAV_VIEWS.has(v.key) && (!v.module || modules[v.module]) && (!v.webModule || installed.has(v.webModule)));
  const { data: saved, reload: reloadSaved } = useLoad(() => hubApi.savedViews(project.id), [project.id]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<"new" | "save" | "manage" | null>(null);
  // "Bırak, kaydet": a file dropped on the list opens "+ Yeni" with its prefilled record form.
  const [dropFile, setDropFile] = useState<File | null>(null);
  // Dropping a file makes a record from it ("Bırak, kaydet"): Manage's.
  const canDrop = DROP_VIEWS.has(viewKey) && !!webCapability("manage.ui");
  const [dragging, setDragging] = useState(false);

  // İşler in the menu opens the last view (without the record) next time. Each view also keeps
  // its own filters, so leaving Toplantılar and coming back does not drop them.
  useEffect(() => {
    const list = hubListPath(rest, location.search);
    if (list) rememberHubPath(project.id, list);
    if (!params.get("gorunum")) rememberHubFilters(project.id, viewKey, filtersOfSearch(params));
  }, [project.id, rest, location.search, viewKey, params]);

  const current = HUB_VIEWS.find((v) => v.key === viewKey)!;
  const activeSaved = saved?.find((v) => v.id === activeSavedId) ?? null;
  const title = activeSaved?.name ?? ts(current.labelKey);
  const moduleOff = !!current.module && !modules[current.module];
  // A record open next to the list: the view list folds into the select to leave room (CSS).
  const detailOpen = rest.replace(/^\/+/, "").split("/").filter(Boolean).length > 1;
  // Phones (CSS, ≤ 700px): an open record fills the screen; "← Geri" returns to the list with its ?bolum and filters.
  const backUrl = `${base}/${hubListPath(rest, location.search) ?? hubViewPath(viewKey)}`;

  const viewUrl = (v: HubView) => {
    const live = v.key === viewKey && !activeSavedId;
    return `${base}/${hubViewPath(v.key, live ? filtersOfSearch(params) : hubViewFilters(project.id, v.key))}`;
  };
  const savedUrl = (s: SavedViewDto) => `${base}/${hubViewPath(s.view, { ...s.params, gorunum: s.id })}`;
  /** Filters of the current view as saved: the URL query without the view selector. */
  const currentParams = () => {
    const p: Record<string, string> = {};
    params.forEach((v, k) => {
      if (k !== "gorunum" && k !== "bolum" && v) p[k] = v;
    });
    return p;
  };

  return (
    <EmbeddedContext.Provider value={{ in: "hub", refreshKey }}>
      <div className={`hub${detailOpen ? " detail-open" : ""}`}>
        <aside className="hub-views" aria-label={ts(HUB_LABELS.views)}>
          {views.map((v) => (
            <Link key={v.key} to={viewUrl(v)} className={`hub-view${!activeSaved && v.key === viewKey ? " active" : ""}`}>
              <NavIcon name={v.icon} size={16} />
              <span>{ts(v.labelKey)}</span>
            </Link>
          ))}
          {!!saved?.length && (
            <>
              <div className="hub-views-head">
                <span>{ts(HUB_LABELS.savedViews)}</span>
                <button className="ghost small" onClick={() => setDialog("manage")} title={ts(HUB_LABELS.manageViews)} aria-label={ts(HUB_LABELS.manageViews)}>
                  ✎
                </button>
              </div>
              {saved.map((s) => (
                <Link key={s.id} to={savedUrl(s)} className={`hub-view saved${s.id === activeSavedId ? " active" : ""}`} title={s.shared ? t("hub.sharedBy", { owner: s.ownerName ?? "" }) : undefined}>
                  <NavIcon name="star" size={15} />
                  <span>{s.name}</span>
                  {s.shared && <span className="badge small-badge">{t("hub.badges.shared")}</span>}
                </Link>
              ))}
            </>
          )}
        </aside>
        <div className="hub-main">
          <div className="hub-head">
            {detailOpen && (
              <Link className="btn hub-back" to={backUrl}>
                ← {t("common:actions.back")}
              </Link>
            )}
            <select
              className="hub-view-select"
              aria-label={ts(HUB_LABELS.views)}
              value={activeSaved ? `s:${activeSaved.id}` : `v:${viewKey}`}
              onChange={(e) => {
                const [kind, id] = [e.target.value.slice(0, 1), e.target.value.slice(2)];
                if (kind === "v") navigate(viewUrl(HUB_VIEWS.find((v) => v.key === id)!));
                else navigate(savedUrl(saved!.find((s) => s.id === id)!));
              }}
            >
              <optgroup label={ts(HUB_LABELS.views)}>
                {views.map((v) => (
                  <option key={v.key} value={`v:${v.key}`}>
                    {ts(v.labelKey)}
                  </option>
                ))}
              </optgroup>
              {!!saved?.length && (
                <optgroup label={ts(HUB_LABELS.savedViews)}>
                  {saved.map((s) => (
                    <option key={s.id} value={`s:${s.id}`}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <h1 className="hub-title">{title}</h1>
            <div className="spacer" />
            {!place?.record && viewKey !== "bana" && (
              <button onClick={() => setDialog("save")} title={t("hub.saveViewHint")}>
                {ts(HUB_LABELS.saveView)}
              </button>
            )}
            <button className="primary" onClick={() => setDialog("new")}>
              {ts(HUB_LABELS.newRecord)}
            </button>
          </div>
          {moduleOff && (
            <p className="notice small hub-notice">
              {t("hub.moduleOff")}
            </p>
          )}
          <div
            className={`hub-body${dragging ? " dragging" : ""}`}
            onDragOver={(e) => {
              if (!canDrop || !e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              if (!canDrop) return;
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (!f) return;
              setDropFile(f);
              setDialog("new");
            }}
          >
            <Outlet />
          </div>
        </div>
      </div>
      {dialog === "new" && (
        <NewRecordDialog
          preferred={PREFERRED[viewKey]}
          initialFile={dropFile ?? undefined}
          onClose={() => {
            setDialog(null);
            setDropFile(null);
          }}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {dialog === "save" && (
        <SaveViewDialog
          defaultName={title}
          canShare={!!project.isProjectAdmin}
          onClose={() => setDialog(null)}
          onSave={async (name, shared) => {
            const v = await hubApi.createView(project.id, { name, view: viewKey, params: currentParams(), shared });
            setDialog(null);
            reloadSaved();
            navigate(savedUrl(v), { replace: true });
          }}
        />
      )}
      {dialog === "manage" && saved && (
        <ManageViewsDialog
          views={saved}
          canShare={!!project.isProjectAdmin}
          onClose={() => setDialog(null)}
          onChanged={reloadSaved}
        />
      )}
    </EmbeddedContext.Provider>
  );
}

function SaveViewDialog({
  defaultName,
  canShare,
  onClose,
  onSave,
}: {
  defaultName: string;
  canShare: boolean;
  onClose(): void;
  onSave(name: string, shared: boolean): Promise<void>;
}) {
  const { t } = useTranslation(["works", "common"]);
  const { t: ts } = useTranslation("shell");
  const [name, setName] = useState(defaultName);
  const [shared, setShared] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={ts(HUB_LABELS.saveView)} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg(null);
          try {
            await onSave(name.trim(), shared);
          } catch (err) {
            setMsg((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("hub.saveDialog.description")}
        </p>
        <label>{t("common:fields.name")}</label>
        <input autoFocus value={name} maxLength={80} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        {canShare && (
          <label className="check">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> {ts(HUB_LABELS.shareWithProject)}
            <span className="muted small"> — {t("hub.saveDialog.shareHint")}</span>
          </label>
        )}
        {msg && <p className="error">{msg}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button type="submit" className="primary" disabled={!name.trim() || busy}>
            {t("common:actions.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Rename, reorder, share and delete saved views. */
function ManageViewsDialog({
  views,
  canShare,
  onClose,
  onChanged,
}: {
  views: SavedViewDto[];
  canShare: boolean;
  onClose(): void;
  onChanged(): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const { t: ts } = useTranslation("shell");
  const { confirm } = useAsk();
  const project = useProject();
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(views.map((v) => [v.id, v.name])));
  const [msg, setMsg] = useState<string | null>(null);
  const mine = views.filter((v) => v.mine);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const move = (id: string, by: number) => {
    const ids = mine.map((v) => v.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void act(() => hubApi.orderViews(project.id, ids));
  };

  return (
    <Dialog title={ts(HUB_LABELS.manageViews)} onClose={onClose} wide>
      <ul className="manage-views">
        {views.map((v) => {
          const i = mine.findIndex((x) => x.id === v.id);
          return (
            <li key={v.id}>
              <input
                value={names[v.id] ?? ""}
                disabled={!v.canEdit}
                maxLength={80}
                aria-label={t("hub.manage.fields.viewName")}
                onChange={(e) => setNames({ ...names, [v.id]: e.target.value })}
                onBlur={() => {
                  const n = (names[v.id] ?? "").trim();
                  if (v.canEdit && n && n !== v.name) void act(() => hubApi.updateView(project.id, v.id, { name: n }));
                }}
              />
              <span className="muted small manage-views-owner">{v.mine ? (v.shared ? t("hub.badges.shared") : t("hub.manage.private")) : t("hub.manage.sharedBy", { owner: v.ownerName ?? "" })}</span>
              {v.mine && (
                <>
                  <button className="ghost small" disabled={i <= 0} onClick={() => move(v.id, -1)} aria-label={t("hub.manage.actions.moveUp")} title={t("hub.manage.actions.up")}>
                    ↑
                  </button>
                  <button className="ghost small" disabled={i < 0 || i >= mine.length - 1} onClick={() => move(v.id, 1)} aria-label={t("hub.manage.actions.moveDown")} title={t("hub.manage.actions.down")}>
                    ↓
                  </button>
                </>
              )}
              {canShare && v.canEdit && (
                <button className="small" onClick={() => void act(() => hubApi.updateView(project.id, v.id, { shared: !v.shared }))}>
                  {v.shared ? t("hub.manage.actions.unshare") : t("hub.manage.actions.share")}
                </button>
              )}
              {v.canEdit && (
                <button
                  className="small danger"
                  onClick={() =>
                    void confirm({
                      title: t("hub.manage.delete.title"),
                      message: t("hub.manage.delete.confirm", { name: v.name }),
                      confirmLabel: t("common:actions.delete"),
                      danger: true,
                    }).then((ok) => {
                      if (ok) return act(() => hubApi.deleteView(project.id, v.id));
                    })
                  }
                >
                  {t("common:actions.delete")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {msg && <p className="error">{msg}</p>}
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          {t("common:actions.ok")}
        </button>
      </div>
    </Dialog>
  );
}

