/**
 * In front of the CAD viewer: picks the loading path (prebuilt 2D scene or DXF, see
 * scene-loader.ts) and shows a card instead of an empty canvas for Civil 3D drawings, failed
 * conversions and drawings too large for a phone while their scene is being prepared.
 */
import { lazy, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CadCheck, PreviewDto } from "@sitekeep/shared";
import { formatSize } from "../../shared/api/api";
import { documentsApi } from "../../features/documents/api";
import type { ViewerProps } from "../types";
import { isPhone, planCad, type CadSource } from "./scene-loader";

const CadViewer = lazy(() => import("../CadViewer"));

/** Server phases of building the scene (preview meta.phase). */
const PHASES = ["parse", "build", "compress"] as const;
const isPhase = (p: string): p is (typeof PHASES)[number] => (PHASES as readonly string[]).includes(p);

export default function CadGate(props: ViewerProps) {
  const { t } = useTranslation(["viewers", "common"]);
  const { info, onRequest, projectId } = props;
  const [openDxf, setOpenDxf] = useState(false);
  const phone = useRef(isPhone()).current;
  // Once the viewer is up its source stays: a scene finishing later does not reload the drawing.
  const chosen = useRef<CadSource | null>(null);
  const plan = planCad(info, { phone, openDxf });

  if (plan.show === "viewer") {
    chosen.current ??= plan.source;
    return <CadViewer {...props} source={chosen.current} notice={plan.notice} />;
  }
  if (chosen.current) return <CadViewer {...props} source={chosen.current} notice={null} />;

  const download = info.canDownload && (
    <a className="btn" href={documentsApi.downloadUrl(projectId, info.versionId)}>
      ⬇ {t("common:actions.download")}
    </a>
  );
  if (plan.show === "civil3d" || plan.show === "empty") {
    return (
      <div className="vw-center">
        <div className="vw-card">
          <h2>{plan.show === "civil3d" ? t("cad.gate.civil3d.title") : t("cad.gate.empty.title")}</h2>
          {plan.show === "civil3d" ? (
            <p className="notice">{t("cad.gate.civil3d.description")}</p>
          ) : (
            <p className="notice">{t("cad.gate.empty.description")}</p>
          )}
          <CadFacts cad={plan.cad} />
          <div className="row wrap">{download}</div>
        </div>
      </div>
    );
  }

  const scene = plan.scene;
  return (
    <div className="vw-center">
      <div className="vw-card">
        <h2>{info.fileName}</h2>
        <p>
          {plan.show === "too-big"
            ? t("cad.gate.tooBig", { size: formatSize(plan.dxfBytes) })
            : t("cad.gate.preparingLarge", { size: formatSize(plan.dxfBytes) })}
        </p>
        <SceneStatus scene={scene} />
        <div className="row wrap">
          {(scene?.status === "failed" || scene?.status === "unavailable") && <button onClick={() => onRequest("scene")}>{t("common:actions.retry")}</button>}
          {plan.show === "preparing" && plan.canOpenDxf && (
            <button onClick={() => setOpenDxf(true)} title={t("cad.gate.openRawDxfHint")}>
              {t("cad.gate.actions.openRawDxf")}
            </button>
          )}
          {download}
        </div>
      </div>
    </div>
  );
}

function SceneStatus({ scene }: { scene?: PreviewDto }) {
  const { t } = useTranslation("viewers");
  if (scene?.status === "failed")
    return <p className="error">{scene.error ? t("cad.gate.errors.sceneFailedWith", { error: scene.error }) : t("cad.gate.errors.sceneFailed")}</p>;
  if (scene?.status === "unavailable") return <p className="error">{t("cad.gate.errors.sceneUnavailable")}</p>;
  const raw = scene?.status === "processing" ? scene.meta.phase : undefined;
  const phase = raw && isPhase(raw) ? t(`cad.gate.phases.${raw}`) : null;
  return (
    <p>
      <span className="vw-spin" />
      {phase
        ? t("cad.gate.messages.preparingPhase", { phase })
        : scene?.status === "processing"
          ? t("cad.gate.messages.preparing")
          : t("cad.gate.messages.preparingQueued")}
    </p>
  );
}

function CadFacts({ cad }: { cad: CadCheck }) {
  const { t } = useTranslation("viewers");
  return (
    <dl className="vw-meta">
      <dt>{t("cad.gate.fields.objects")}</dt>
      <dd>{cad.entities}</dd>
      {cad.aeccClasses > 0 && (
        <>
          <dt>{t("cad.gate.fields.civil3dClasses")}</dt>
          <dd>{cad.aeccClasses}</dd>
        </>
      )}
      {cad.converterErrors > 0 && (
        <>
          <dt>{t("cad.gate.fields.converterErrors")}</dt>
          <dd>{cad.converterErrors}</dd>
        </>
      )}
    </dl>
  );
}
