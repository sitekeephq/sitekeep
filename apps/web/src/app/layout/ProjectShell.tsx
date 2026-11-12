import { useCallback, useEffect, useState } from "react";
import type { ProjectDto } from "@sitekeep/shared";
import { NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { webCapability } from "../../sdk/capabilities";

import { isModelAskVisible, MODEL_ASK_VISIBILITY_EVENT } from "../../shared/ai/panel-coordination";
import { api } from "../../shared/api/api";
import { Icon } from "../../shared/ui/Icon";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { ProjectContext } from "../context/project";
import { useAuth } from "../context/auth";
import { projectNav, projectNavItems } from "../navigation";
import { ProductTour } from "../../features/onboarding/ProductTour";
import { TOUR_MENU_EVENT } from "../../features/onboarding/tour";

const PROJECT_NAV_COLLAPSED_KEY = "cde.projectNav.collapsed";

export function ProjectShell() {
  // "Projeye Sor" is the AI module's; without it there is no Sor button.
  const AskPanel = webCapability("ai.ui")?.AskPanel;
  const { t } = useTranslation("shell");
  const { pid } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Sor" panel: mounted on first open, then only hidden so the conversation is kept.
  const [askOpen, setAskOpen] = useState(false);
  const [askMounted, setAskMounted] = useState(false);
  const [modelAskOpen, setModelAskOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem(PROJECT_NAV_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const openAsk = useCallback(() => {
    if (modelAskOpen) return;
    setMenuOpen(false);
    setAskMounted(true);
    setAskOpen(true);
  }, [modelAskOpen]);
  const closeAsk = useCallback(() => setAskOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (modelAskOpen) return;
        setAskMounted(true);
        setAskOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modelAskOpen]);

  useEffect(() => {
    const onVisibility = (event: Event) => {
      const open = (event as CustomEvent<boolean>).detail;
      setModelAskOpen(open);
      if (open) setAskOpen(false);
    };
    window.addEventListener(MODEL_ASK_VISIBILITY_EVENT, onVisibility);
    setModelAskOpen(isModelAskVisible());
    return () => window.removeEventListener(MODEL_ASK_VISIBILITY_EVENT, onVisibility);
  }, []);

  useEffect(() => {
    setAskOpen(false);
    setAskMounted(false);
    setModelAskOpen(false);
    setMenuOpen(false);
  }, [pid]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onTourMenu = (event: Event) => setMenuOpen(!!(event as CustomEvent<boolean>).detail);
    window.addEventListener(TOUR_MENU_EVENT, onTourMenu);
    return () => window.removeEventListener(TOUR_MENU_EVENT, onTourMenu);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("nav-drawer-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("nav-drawer-open");
    };
  }, [menuOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECT_NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0");
    } catch {
      // The navigation still works when browser storage is unavailable.
    }
  }, [navCollapsed]);

  useEffect(() => {
    setProject(null);
    setError(null);
    api.project(pid!).then(setProject, (e: Error) => setError(e.message));
  }, [pid]);

  useEffect(() => {
    const onChange = () => void api.project(pid!).then(setProject, () => undefined);
    window.addEventListener("cde:project-changed", onChange);
    return () => window.removeEventListener("cde:project-changed", onChange);
  }, [pid]);

  if (error) return <div className="page error">{error}</div>;
  if (!project) return <LoadingIndicator className="page" />;

  const section = location.pathname.split("/")[3] ?? "";
  const current = projectNavItems().find((i) => i.to === section || (section === "view" && i.to === "files"));

  return (
    <ProjectContext.Provider value={project}>
      <div className={`project-layout${navCollapsed ? " nav-collapsed" : ""}`}>
        <aside className={`sidenav${menuOpen ? " menu-open" : ""}`} aria-label={t("projectShell.navLabel")} data-collapsed={navCollapsed || undefined}>
          <div className="sidenav-bar">
            <button
              type="button"
              className="sidenav-menu-btn"
              aria-label={menuOpen ? t("projectShell.closeMenu") : t("projectShell.openMenu")}
              aria-expanded={menuOpen}
              aria-controls="project-nav-drawer"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="sidenav-menu-icon" aria-hidden="true" />
            </button>
            <span className="sidenav-code">{project.code}</span>
            <strong className="sidenav-current">{current ? t(current.labelKey) : project.name}</strong>
            {AskPanel && (
              <button
                type="button"
                className="sidenav-ask sidenav-ask-bar"
                aria-label={t("projectShell.ask")}
                onClick={openAsk}
                disabled={modelAskOpen}
                title={modelAskOpen ? t("projectShell.askBlocked") : t("projectShell.askTitle")}
              >
                <Icon name="spark" />
                <span>{t("projectShell.ask")}</span>
              </button>
            )}
          </div>
          {menuOpen && (
            <button type="button" className="sidenav-backdrop" aria-label={t("projectShell.dismissMenu")} onClick={() => setMenuOpen(false)} />
          )}
          <div className="sidenav-drawer" id="project-nav-drawer">
            <div className="sidenav-project">
              <span className="sidenav-code">{project.code}</span>
              <div className="sidenav-project-copy">
                <strong title={project.name}>{project.name}</strong>
                <span>{project.isProjectAdmin ? t("projectShell.projectAdmin") : t("projectShell.projectMember")}</span>
              </div>
            </div>
            <nav className="sidenav-scroll">
              {projectNav().map((group) => {
                const items = group.items.filter((i) => {
                  if (i.systemAdmin && !user?.isAdmin) return false;
                  return !i.adminOnly || project.isProjectAdmin;
                });
                if (!items.length) return null;
                return (
                  <div className="sidenav-group" key={group.titleKey}>
                    <div className="sidenav-title">{t(group.titleKey)}</div>
                    {items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className="sidenav-link"
                        title={navCollapsed ? t(item.labelKey) : undefined}
                        data-tour={`nav-${item.to}`}
                      >
                        <Icon name={item.icon} />
                        <span>{t(item.labelKey)}</span>
                      </NavLink>
                    ))}
                  </div>
                );
              })}
            </nav>
            {AskPanel && (
              <button
                className="sidenav-ask"
                onClick={openAsk}
                disabled={modelAskOpen}
                title={modelAskOpen ? t("projectShell.askBlocked") : t("projectShell.askTitle")}
              >
                <Icon name="spark" />
                <span>{t("projectShell.ask")}</span>
                <kbd>⌘K</kbd>
              </button>
            )}
            <button
              className="sidenav-collapse"
              onClick={() => setNavCollapsed((value) => !value)}
              title={navCollapsed ? t("projectShell.expand") : t("projectShell.collapse")}
              aria-label={navCollapsed ? t("projectShell.expand") : t("projectShell.collapse")}
              aria-expanded={!navCollapsed}
            >
              <span aria-hidden="true">{navCollapsed ? "›" : "‹"}</span>
              <span className="sidenav-collapse-label">{navCollapsed ? t("projectShell.expandShort") : t("projectShell.collapse")}</span>
            </button>
          </div>
        </aside>
        <div className="project-content">
          <div className="breadcrumbs" aria-label={t("projectShell.breadcrumbs")}>
            <NavLink to="/home">{t("projectShell.projects")}</NavLink>
            <span className="sep">/</span>
            <NavLink to={`/projects/${project.id}/files`}>{project.code}</NavLink>
            {current && (
              <>
                <span className="sep">/</span>
                <span aria-current="page">{t(current.labelKey)}</span>
              </>
            )}
          </div>
          <div className="project-outlet">
            <Outlet />
          </div>
        </div>
      </div>
      {AskPanel && askMounted && <AskPanel projectId={project.id} open={askOpen} onClose={closeAsk} />}
      <ProductTour />
    </ProjectContext.Provider>
  );
}
