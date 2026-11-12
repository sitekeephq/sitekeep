import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, NavLink, useLocation, useMatch, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { foldTr, type ProjectDto } from "@sitekeep/shared";
import { api, dataLocale, intlLocale } from "../../shared/api/api";
import { useAuth } from "../context/auth";
import { projectNavItems } from "../navigation";
import { BrandMark, BrandName } from "../../shared/ui/BrandMark";
import { editionName } from "../brand";
import { Icon, type IconName } from "../../shared/ui/Icon";
import { NotificationBell } from "./NotificationBell";
import { LanguageMenuItems, LanguageSwitcher } from "./LanguageSwitcher";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { usePhoneWidth } from "../../shared/ui/RecordCards";
import { startProductTour } from "../../features/onboarding/tour";

/** Closes a popover on outside click or Escape. */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

function useProjects() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  useEffect(() => {
    api.projects().then(setProjects, () => setProjects([]));
  }, []);
  return projects;
}

export function TopBar() {
  const { t } = useTranslation("shell");
  const match = useMatch("/projects/:pid/*");
  const projects = useProjects();
  const current = projects?.find((p) => p.id === match?.params.pid) ?? null;
  const tasksTo = current ? `/projects/${current.id}/today` : "/tasks";
  return (
    <header className="topbar">
      <Link to="/home" className="brand" aria-label={t("topbar.homeLabel")} title={editionName()}>
        <BrandMark size={24} />
        <BrandName />
      </Link>
      <span className="topbar-sep" />
      <ProjectSwitcher projects={projects} current={current} />
      <GlobalSearch projects={projects} current={current} />
      <div className="spacer" />
      <LanguageSwitcher signedIn />
      {current && (
        <button type="button" className="topbar-link topbar-tour" aria-label={t("topbar.tour")} title={t("topbar.tour")} onClick={() => startProductTour()}>
          <Icon name="tour" />
          <span>{t("topbar.tour")}</span>
        </button>
      )}
      <NavLink to={tasksTo} className="topbar-link">
        <Icon name="check" />
        <span>{t("topbar.myTasks")}</span>
      </NavLink>
      <NotificationBell />
      <AccountMenu />
    </header>
  );
}

function ProjectSwitcher({ projects, current }: { projects: ProjectDto[] | null; current: ProjectDto | null }) {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  useDismiss(box, open, () => setOpen(false));
  return (
    <div className="topbar-popover" ref={box}>
      <button className="topbar-switcher" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <span className="topbar-switcher-label">{t("topbar.project")}</span>
        <span className="topbar-switcher-value">{current ? `${current.code} · ${current.name}` : t("topbar.chooseProject")}</span>
        <svg className="icon chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="menu menu-wide" role="menu">
          <div className="menu-heading">{t("topbar.projects")}</div>
          {projects === null && <LoadingIndicator compact />}
          {projects?.length === 0 && <div className="menu-empty">{t("topbar.noProjects")}</div>}
          <div className="menu-scroll">
            {projects?.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                className={`menu-item${p.id === current?.id ? " selected" : ""}`}
                onClick={() => {
                  setOpen(false);
                  navigate(`/projects/${p.id}/${location.pathname === "/tasks" ? "today" : "files"}`);
                }}
              >
                <span className="mono-tag">{p.code}</span>
                <span className="menu-item-text">{p.name}</span>
                {p.id === current?.id && (
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m5 12 4.5 4.5L19 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          <div className="menu-footer">
            <Link to="/home" onClick={() => setOpen(false)}>
              {t("topbar.allProjects")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

type SearchResult = { key: string; label: string; hint: string; icon: IconName; to: string };

function GlobalSearch({ projects, current }: { projects: ProjectDto[] | null; current: ProjectDto | null }) {
  const { t } = useTranslation("shell");
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const phone = usePhoneWidth();
  useDismiss(box, open, () => setOpen(false));
  const showMenu = open && (!phone || query.trim().length > 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== "/" || target.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const q = foldTr(query.trim());
    const pages: SearchResult[] = current
      ? projectNavItems().filter((i) => {
          if (i.systemAdmin && !user?.isAdmin) return false;
          return !i.adminOnly || current.isProjectAdmin;
        }).map((i) => ({
          key: `page:${i.to}`,
          label: t(i.labelKey),
          hint: current.code,
          icon: i.icon,
          to: `/projects/${current.id}/${i.to}`,
        }))
      : [];
    const projectHits: SearchResult[] = (projects ?? []).map((p) => ({
      key: `project:${p.id}`,
      label: p.name,
      hint: p.code,
      icon: "folder",
      to: `/projects/${p.id}/files`,
    }));
    const all = [...pages, ...projectHits];
    return (q ? all.filter((r) => foldTr(`${r.label} ${r.hint}`).includes(q)) : all).slice(0, 8);
  }, [query, projects, current, user?.isAdmin, t]);

  function go(r: SearchResult | undefined) {
    if (!r) return;
    setOpen(false);
    setQuery("");
    input.current?.blur();
    navigate(r.to);
  }

  return (
    <div className="topbar-popover topbar-search" ref={box}>
      <svg className="icon search-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.2-4.2" />
      </svg>
      <input
        ref={input}
        type="search"
        placeholder={current ? t("topbar.searchPages") : t("topbar.searchProjects")}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            go(results[active]);
          }
        }}
        aria-label={t("topbar.search")}
      />
      <kbd>/</kbd>
      {showMenu && (
        <div className="menu menu-search" role="listbox">
          {results.length === 0 ? (
            <div className="menu-empty">{t("topbar.noResults")}</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.key}
                role="option"
                aria-selected={i === active}
                className={`menu-item${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r)}
              >
                <Icon name={r.icon} />
                <span className="menu-item-text">{r.label}</span>
                <span className="menu-item-hint">{r.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const { t } = useTranslation("shell");
  const { user, logout } = useAuth();
  const inProject = !!useMatch("/projects/:pid/*");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useDismiss(box, open, () => setOpen(false));
  const initials = (user?.name ?? "")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase(dataLocale());

  function goTo(path: string) {
    setOpen(false);
    navigate(path);
  }

  return (
    <div className="topbar-popover" ref={box}>
      <button className="topbar-account" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={user?.email}>
        <span className="account-avatar">{initials}</span>
      </button>
      {open && (
        <div className="menu menu-right" role="menu">
          <div className="menu-profile">
            <span className="account-avatar large">{initials}</span>
            <div>
              <strong>{user?.name}</strong>
              <span>{user?.email}</span>
            </div>
          </div>
          <button role="menuitem" className="menu-item" onClick={() => goTo("/account")}>
            <Icon name="settings" />
            <span className="menu-item-text">{t("topbar.accountSettings")}</span>
          </button>
          {inProject && (
            // Phones: the top bar has no room for the tour button, so it lives here.
            <button
              role="menuitem"
              className="menu-item menu-item-tour"
              onClick={() => {
                setOpen(false);
                startProductTour();
              }}
            >
              <Icon name="tour" />
              <span className="menu-item-text">{t("topbar.tour")}</span>
            </button>
          )}
          <LanguageMenuItems onChosen={() => setOpen(false)} />
          {user?.isAdmin && (
            <button role="menuitem" className="menu-item" onClick={() => goTo("/administration")}>
              <Icon name="layers" />
              <span className="menu-item-text">{t("topbar.systemAdmin")}</span>
            </button>
          )}
          <div className="menu-divider" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            <Icon name="logout" />
            <span className="menu-item-text">{t("topbar.signOut")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
