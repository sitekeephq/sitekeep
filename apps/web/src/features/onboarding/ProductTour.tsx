import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../../app/context/auth";
import { PHONE_QUERY } from "../works/record-cards";
import {
  isTourDone,
  markTourDone,
  nextTourIndex,
  scrollTourTarget,
  TOUR_MENU_EVENT,
  TOUR_QUERY,
  TOUR_START_EVENT,
  TOUR_STEPS,
  visibleTourTarget,
  type TourStep,
} from "./tour";

const PAD = 8;

type Box = { top: number; left: number; width: number; height: number };

function setTourMenu(open: boolean) {
  window.dispatchEvent(new CustomEvent(TOUR_MENU_EVENT, { detail: open }));
}

function measure(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return {
    top: Math.max(0, r.top - PAD),
    left: Math.max(0, r.left - PAD),
    width: Math.min(window.innerWidth, r.width + PAD * 2),
    height: Math.min(window.innerHeight, r.height + PAD * 2),
  };
}

function resolveTarget(step: TourStep): HTMLElement | null {
  return visibleTourTarget(step.target) ?? (step.fallback ? visibleTourTarget(step.fallback) : null);
}

export function ProductTour() {
  const { t } = useTranslation(["onboarding", "common"]);
  const { pid } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const forced = params.get(TOUR_QUERY) === "1";
  const blocked = !!user?.mustChangePassword;
  const [index, setIndex] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!pid || blocked) return;
    if (forced) {
      setIndex(0);
      return;
    }
    if (!isTourDone()) setIndex((current) => current ?? 0);
  }, [pid, forced, blocked]);

  useEffect(() => {
    const start = () => setIndex(0);
    window.addEventListener(TOUR_START_EVENT, start);
    return () => window.removeEventListener(TOUR_START_EVENT, start);
  }, []);

  const step: TourStep | null = index !== null ? (TOUR_STEPS[index] ?? null) : null;
  const section = location.pathname.split("/")[3] ?? "";

  const finish = useCallback(() => {
    markTourDone();
    setTourMenu(false);
    setIndex(null);
    setBox(null);
    if (params.get(TOUR_QUERY) === "1") {
      setParams(
        (p) => {
          p.delete(TOUR_QUERY);
          return p;
        },
        { replace: true },
      );
    }
  }, [params, setParams]);

  const go = useCallback(
    (next: number) => {
      if (next >= TOUR_STEPS.length || next < 0) finish();
      else setIndex(next);
    },
    [finish],
  );

  const advance = useCallback(() => {
    const i = indexRef.current;
    if (i === null) return;
    const current = TOUR_STEPS[i];
    if (current?.click) {
      const el = resolveTarget(current);
      if (el) {
        el.click();
        window.setTimeout(() => {
          if (indexRef.current === i) go(i + 1);
        }, 80);
        return;
      }
    }
    go(i + 1);
  }, [go]);

  useEffect(() => {
    if (!step || !pid) return;
    if (section !== step.route) {
      navigate(`/projects/${pid}/${step.route}`, { replace: false });
    }
  }, [step, pid, section, navigate]);

  useEffect(() => {
    if (!step || index === null) return;
    let cancelled = false;
    let tries = 0;
    let target: HTMLElement | null = null;
    const onTargetClick = () => {
      if (!cancelled) go(index + 1);
    };
    const tick = () => {
      if (cancelled) return;
      setTourMenu(!!step.openNav);
      const el = resolveTarget(step);
      if (el) {
        scrollTourTarget(el, step.scroll);
        setBox(measure(el));
        if (step.click) {
          target = el;
          el.addEventListener("click", onTargetClick);
        }
        return;
      }
      tries += 1;
      if (tries < 40) window.setTimeout(tick, 50);
      else if (step.optionalGroup) go(nextTourIndex(index, step.optionalGroup));
      else setBox(null);
    };
    const id = window.setTimeout(tick, 30);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
      target?.removeEventListener("click", onTargetClick);
    };
  }, [step, section, phone, index, go]);

  useEffect(() => {
    if (!step) return;
    const onResize = () => {
      const el = resolveTarget(step);
      setBox(el ? measure(el) : null);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [step]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, finish, advance]);

  useEffect(() => () => setTourMenu(false), []);

  if (!step || index === null) return null;
  const n = index + 1;
  const last = n === TOUR_STEPS.length;
  const hole = box ?? { top: window.innerHeight / 2 - 40, left: 24, width: window.innerWidth - 48, height: 80 };

  return (
    <div className="tour">
      <div className="tour-dim" style={{ top: 0, left: 0, right: 0, height: hole.top }} />
      <div className="tour-dim" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
      <div className="tour-dim" style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} />
      <div className="tour-dim" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
      <div className="tour-ring" style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }} />
      <div
        className={`tour-card${phone ? " tour-card-phone" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("tour.label")}
        style={phone ? undefined : cardStyle(hole)}
      >
        <p className="muted small" style={{ margin: 0 }}>
          {t("tour.progress", { current: n, total: TOUR_STEPS.length })}
        </p>
        <h2 id="tour-title" style={{ margin: "4px 0 8px" }}>
          {t(step.titleKey)}
        </h2>
        <p style={{ margin: "0 0 14px" }}>{t(step.bodyKey)}</p>
        <div className="row wrap">
          <button type="button" onClick={finish}>
            {t("tour.actions.skip")}
          </button>
          <div className="spacer" />
          {index > 0 && (
            <button type="button" onClick={() => go(index - 1)}>
              {t("common:actions.back")}
            </button>
          )}
          <button type="button" className="primary" onClick={last ? () => go(index + 1) : advance}>
            {last ? t("tour.actions.finish") : t("common:actions.next")}
          </button>
        </div>
      </div>
    </div>
  );
}

function cardStyle(hole: Box): CSSProperties {
  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.min(Math.max(12, hole.left), window.innerWidth - width - 12);
  const below = hole.top + hole.height + 12;
  if (below + 180 < window.innerHeight - 12) return { top: below, left, width };
  const above = hole.top - 12;
  if (above > 200) return { bottom: window.innerHeight - hole.top + 12, left, width };
  return { bottom: 16, left, width };
}
