/**
 * Model viewer tool HUD drawn over the canvas: view cube, tool rail (Yörünge / Yürüme / Plan,
 * Kesit, Ölçü, Görünürlük, X-Işını, Görüntü Al, "?"), the tool panels, the walk bar and phone
 * joystick and our brand mark. Rendering lives in viewer/tools.ts; this file only shows state.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { ViewerTools, ToolsState } from "../tools/tools.js";
import type { ToolPanel } from "../tools/tools-phone.js";
import { SHORTCUT_HELP, type NavMode } from "../tools/shortcuts.js";
import { MEASURE_KIND_LABELS, formatMeasure, formatNumberTr } from "../tools/units.js";
import { NO_MOVE, WALK_SPEED, joystickToMovement } from "../tools/walk-math.js";

const NAV: { mode: NavMode; label: string; icon: string; key: string }[] = [
  { mode: "orbit", label: "Yörünge", icon: "◎", key: "1" },
  { mode: "walk", label: "Yürüme", icon: "🚶", key: "2" },
  { mode: "plan", label: "Plan", icon: "▦", key: "3" },
];

export function ViewerToolsHud({
  tools,
  state,
  panel,
  setPanel,
  loaded,
  branding,
  aboutText,
}: {
  tools: ViewerTools | null;
  state: ToolsState | null;
  panel: ToolPanel | null;
  setPanel(p: ToolPanel | null | ((p: ToolPanel | null) => ToolPanel | null)): void;
  loaded: boolean;
  /** Optional host-owned logo or mark rendered at the lower-left corner. */
  branding?: ReactNode;
  /** Optional attribution/about copy shown in keyboard help. */
  aboutText?: ReactNode;
}) {
  const cubeHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tools || !loaded) return;
    const small = matchMedia("(max-width: 700px)").matches;
    tools.mountCube(cubeHost.current, small ? 52 : 68);
    return () => tools.mountCube(null);
  }, [tools, loaded]);

  const walking = state?.nav === "walk";
  const toggle = (p: ToolPanel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <>
      <div ref={cubeHost} className="vt-cube-host" />
      {tools && state && loaded && (
        <>
          <div className="vt-rail" role="toolbar" aria-label="Görüntüleme Araçları" aria-orientation="vertical">
            <div className="vt-seg" role="radiogroup" aria-label="Gezinme">
              {NAV.map((n) => (
                <button
                  key={n.mode}
                  type="button"
                  role="radio"
                  aria-checked={state.nav === n.mode}
                  className={state.nav === n.mode ? "active" : ""}
                  title={`${n.label} (${n.key})`}
                  onClick={() => void tools.setNav(n.mode)}
                >
                  <span aria-hidden="true">{n.icon}</span>
                  {n.label}
                </button>
              ))}
            </div>
            <RailButton icon="✂" label="Kesit" title="Kesit düzlemi (K) ve kesit kutusu (B)" active={panel === "sections" || state.box || state.planes.length > 0} onClick={() => toggle("sections")} />
            <RailButton icon="📏" label="Ölçü" title="Uzunluk (M), alan, açı, hacim" active={panel === "measure" || !!state.measureTool} onClick={() => toggle("measure")} />
            <RailButton icon="👁" label="Görünürlük" title="Gizle (H), yalnız göster (I), tümünü göster (U)" active={panel === "visibility" || state.hidden} onClick={() => toggle("visibility")} />
            <RailButton icon="⧉" label="X-Işını" title="Diğerlerini saydam yap (X)" active={state.xray} pressed={state.xray} onClick={() => void tools.setXray(!state.xray)} />
            <RailButton icon="📷" label="Görüntü Al" title="Görünümü PNG olarak indir (G)" onClick={() => void tools.screenshot()} />
            <RailButton icon="?" label="Kısayollar" title="Klavye kısayolları (?)" active={state.helpOpen} onClick={() => tools.setHelp(!state.helpOpen)} />
          </div>

          {(state.hint || walking) && <TopBar tools={tools} state={state} />}

          {panel === "sections" && <SectionsPanel tools={tools} state={state} onClose={() => setPanel(null)} />}
          {panel === "measure" && <MeasurePanel tools={tools} state={state} onClose={() => setPanel(null)} />}
          {panel === "visibility" && <VisibilityPanel tools={tools} state={state} onClose={() => setPanel(null)} />}
          {panel === "plan" && state.nav === "plan" && <PlanPanel tools={tools} state={state} onClose={() => setPanel(null)} />}
          {state.helpOpen && <HelpPanel aboutText={aboutText} onClose={() => tools.setHelp(false)} />}
          {walking && <Joystick tools={tools} />}
        </>
      )}
      {branding && <div className={`vt-brand${walking ? " walking" : ""}`}>{branding}</div>}
    </>
  );
}

function RailButton({
  icon,
  label,
  title,
  active,
  pressed,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  title: string;
  active?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={active ? "active" : ""} title={title} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

function PanelHead({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <div className="vt-panel-head">
      <strong>{title}</strong>
      <div className="spacer" />
      <button type="button" className="ghost small" aria-label="Kapat" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/** Hint line; while walking also the speed slider and the way out. */
function TopBar({ tools, state }: { tools: ViewerTools; state: ToolsState }) {
  const walking = state.nav === "walk";
  return (
    <div className="vt-topbar" role="status">
      {state.hint && <span className="vt-topbar-hint">{walking && state.pointerLocked ? "W A S D ile yürüyün · Shift koşar · Esc imleci bırakır" : state.hint}</span>}
      {walking && (
        <>
          <label className="vt-speed">
            Hız
            <input
              type="range"
              min={WALK_SPEED.min}
              max={WALK_SPEED.max}
              step={WALK_SPEED.step}
              value={state.walkSpeed}
              onChange={(e) => tools.setWalkSpeed(Number(e.target.value))}
              aria-label="Yürüme Hızı"
            />
            <span className="mono">{formatNumberTr(state.walkSpeed, 1)} m/sn</span>
          </label>
          <button type="button" className="small" onClick={() => void tools.setNav("orbit")}>
            ✕ Yürümeyi Bırak
          </button>
        </>
      )}
      {!walking && (state.measureTool || state.sectionPlacing) && (
        <button type="button" className="small" onClick={() => void tools.run("escape")}>
          Bitir
        </button>
      )}
    </div>
  );
}

function SectionsPanel({ tools, state, onClose }: { tools: ViewerTools; state: ToolsState; onClose(): void }) {
  return (
    <div className="vt-panel" aria-label="Kesit">
      <PanelHead title="Kesit" onClose={onClose} />
      <div className="row wrap">
        <button type="button" className={`small${state.sectionPlacing ? " primary" : ""}`} aria-pressed={state.sectionPlacing} onClick={() => tools.toggleSectionPlacing()}>
          ✂ Kesit Düzlemi
        </button>
        <button type="button" className={`small${state.box ? " primary" : ""}`} aria-pressed={state.box} onClick={() => void tools.toggleBox()}>
          ▣ {state.box ? "Kutuyu Kaldır" : "Kesit Kutusu"}
        </button>
      </div>
      <p className="muted small">
        Düzlem: bir yüze çift tıklayın, oku sürükleyerek kaydırın. Kutu seçimin çevresine (seçim yoksa tüm modele) kurulur; yüzlerindeki okları
        sürükleyin.
      </p>
      <label className="row small vt-check">
        <input type="checkbox" checked={state.edgesOn} onChange={(e) => tools.sections.setEdgesOn(e.target.checked)} />
        Kesit Dolgusu
      </label>
      {state.edgeMode === "lines" && <p className="muted small">Bu modelde yalnız kesit çizgisi çizilebiliyor (dolgu yok).</p>}
      {state.edgeMode === "off" && <p className="muted small">Kesit çizgisi hesaplanamadı; düzlemler yine de keser.</p>}
      {state.planes.length > 0 && (
        <ul className="vt-list">
          {state.planes.map((p) => (
            <li key={p.id}>
              <label className="row small vt-check">
                <input type="checkbox" checked={p.enabled} onChange={(e) => tools.sections.setEnabled(p.id, e.target.checked)} />
                {p.kind === "plan" ? "Plan Kesiti" : `Düzlem ${p.no}`}
              </label>
              <button type="button" className="ghost small" aria-label="Düzlemi sil" title="Sil" onClick={() => tools.sections.delete(p.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {(state.planes.length > 0 || state.box) && (
        <button type="button" className="small" onClick={() => tools.sections.clear(["plane", "box"])}>
          Tümünü Sil
        </button>
      )}
    </div>
  );
}

function MeasurePanel({ tools, state, onClose }: { tools: ViewerTools; state: ToolsState; onClose(): void }) {
  const kinds = ["length", "area", "angle"] as const;
  return (
    <div className="vt-panel" aria-label="Ölçü">
      <PanelHead title="Ölçü" onClose={onClose} />
      <div className="vt-seg horizontal" role="radiogroup" aria-label="Ölçü Aracı">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={state.measureTool === k}
            className={state.measureTool === k ? "active" : ""}
            onClick={() => tools.setMeasureTool(state.measureTool === k ? null : k)}
          >
            {MEASURE_KIND_LABELS[k]}
          </button>
        ))}
        <button type="button" disabled={!state.hasSelection} title="Seçili elemanların hacmi" onClick={() => tools.setMeasureTool("volume")}>
          {MEASURE_KIND_LABELS.volume}
        </button>
      </div>
      {state.tapPending && <p className="muted small">İkinci noktaya dokunun.</p>}
      {state.measurements.length === 0 ? (
        <p className="muted small">Henüz ölçü yok. Bir araç seçip modele tıklayın; telefonda iki dokunuş bir uzunluktur.</p>
      ) : (
        <ul className="vt-list">
          {state.measurements.map((m) => (
            <li key={m.key}>
              <span className="small">{MEASURE_KIND_LABELS[m.kind]}</span>
              <strong className="mono small vt-value">{m.value === null ? "…" : formatMeasure(m.kind, m.value)}</strong>
              <button type="button" className="ghost small" aria-label="Ölçüyü sil" title="Sil" onClick={() => tools.measure.delete(m.key)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.measurements.length > 0 && (
        <button type="button" className="small" onClick={() => tools.measure.clear()}>
          Tümünü Sil
        </button>
      )}
    </div>
  );
}

function VisibilityPanel({ tools, state, onClose }: { tools: ViewerTools; state: ToolsState; onClose(): void }) {
  return (
    <div className="vt-panel" aria-label="Görünürlük">
      <PanelHead title="Görünürlük" onClose={onClose} />
      <div className="vt-stack">
        <button type="button" className="small" disabled={!state.hasSelection} onClick={() => void tools.hideSelection()}>
          ◌ Gizle <span className="muted">H</span>
        </button>
        <button type="button" className="small" disabled={!state.hasSelection} onClick={() => void tools.isolateSelection()}>
          ◉ Yalnız Göster <span className="muted">I</span>
        </button>
        <button type="button" className="small" disabled={!state.hidden} onClick={() => void tools.showAll()}>
          👁 Tümünü Göster <span className="muted">U</span>
        </button>
        <button type="button" className={`small${state.xray ? " primary" : ""}`} aria-pressed={state.xray} onClick={() => void tools.setXray(!state.xray)}>
          ⧉ X-Işını <span className="muted">X</span>
        </button>
      </div>
      {!state.hasSelection && <p className="muted small">Gizlemek veya yalnız göstermek için önce modelde eleman seçin.</p>}
    </div>
  );
}

function PlanPanel({ tools, state, onClose }: { tools: ViewerTools; state: ToolsState; onClose(): void }) {
  return (
    <div className="vt-panel" aria-label="Plan">
      <PanelHead title="Plan" onClose={onClose} />
      {state.storeysLoading && <p className="muted small">Katlar yükleniyor…</p>}
      {!state.storeysLoading && !state.storeys?.length && <p className="muted small">Modelde kat (IfcBuildingStorey) bulunamadı; tüm model üstten gösteriliyor.</p>}
      <ul className="vt-list">
        <li>
          <label className="row small vt-check">
            <input type="radio" name="vt-storey" checked={state.storeyIndex === null} onChange={() => void tools.selectStorey(null)} />
            Tüm Model
          </label>
        </li>
        {state.storeys?.map((s, i) => (
          <li key={`${s.name}-${i}`}>
            <label className="row small vt-check">
              <input type="radio" name="vt-storey" disabled={s.level === null} checked={state.storeyIndex === i} onChange={() => void tools.selectStorey(i)} />
              {s.name}
            </label>
            {s.elevation !== null && <span className="muted small mono">{`${s.elevation >= 0 ? "+" : ""}${formatNumberTr(s.elevation)} m`}</span>}
          </li>
        ))}
      </ul>
      <p className="muted small">Seçilen katın 1,2 m üstü kesilir; üstteki her şey gizlenir.</p>
    </div>
  );
}

function HelpPanel({ aboutText, onClose }: { aboutText?: ReactNode; onClose(): void }) {
  return (
    <div className="vt-panel vt-help" role="note" aria-label="Kısayollar">
      <PanelHead title="Kısayollar" onClose={onClose} />
      <table className="props-table">
        <tbody>
          {SHORTCUT_HELP.map((r) => (
            <tr key={r.keys}>
              <td>
                <kbd>{r.keys}</kbd>
              </td>
              <td>{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {aboutText && <p className="muted small">{aboutText}</p>}
    </div>
  );
}

/** Phone walking: drag the knob to move (coarse pointers only, CSS). */
function Joystick({ tools }: { tools: ViewerTools }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const active = useRef<number | null>(null);
  const R = 44;

  useEffect(() => () => tools.setJoystick(NO_MOVE), [tools]);

  const move = (e: ReactPointerEvent) => {
    const rect = base.current!.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    setKnob({ x: dx, y: dy });
    tools.setJoystick(joystickToMovement(dx, dy, R));
  };
  const end = () => {
    active.current = null;
    setKnob({ x: 0, y: 0 });
    tools.setJoystick(NO_MOVE);
  };

  return (
    <div
      ref={base}
      className="vt-joystick"
      aria-label="Yürüme Kolu"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => active.current === e.pointerId && move(e)}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div className="vt-joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}
