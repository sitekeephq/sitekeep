import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { resolveModules, type WorkSummaryDto } from "@sitekeep/shared";
import { api, intlLocale } from "../../../shared/api/api";
import { worksApi } from "../../../shared/api/api-works";
import { useLoad, useProject } from "../../../app/context/project";
import { useEmbedded } from "../../../app/context/embedded";
import { WORK_QUICK_FILTERS as QUICK, WORK_SECTIONS } from "../../../app/navigation/nav";
import { FilterBar, type FilterChip } from "../../../shared/ui/FilterBar";
import { RecordCards, usePhoneWidth } from "../../../shared/ui/RecordCards";
import { ReportShortcut, worksSectionModule } from "../../documents/components/ReportShortcut";
import { MyItems } from "../components/MyItems";
import { WorkDetail } from "../components/WorkDetail";
import { WorksTable } from "../components/WorksList";
import { workCard } from "../record-cards";
import { webCapability } from "../../../sdk/capabilities";

export { WORK_SECTIONS };
export { CreateWorkDialog, CompanyChips, FieldInputs, MemberSelect, type WorkPrefill } from "../components/CreateWorkDialog";
export { WorkStatusBadge, dueClass } from "../components/work-status";

type GroupBy = "" | "type" | "status" | "company" | "month";
const GROUP_LABELS = [
  ["", "list.options.groupBy.none"],
  ["type", "list.options.groupBy.type"],
  ["status", "list.options.groupBy.status"],
  ["company", "list.options.groupBy.company"],
  ["month", "list.options.groupBy.month"],
] as const satisfies readonly (readonly [GroupBy, string])[];
const DUE_LABELS = {
  overdue: "list.options.due.overdue",
  soon: "list.options.due.soon",
} as const;
/** Empty list of a section, before anything was created. */
const SECTION_EMPTY = {
  yazismalar: "list.empty.sections.correspondence",
  "bilgi-talepleri": "list.empty.sections.rfi",
  "teknik-onaylar": "list.empty.sections.submittal",
  toplantilar: "list.empty.sections.meeting",
  gonderimler: "list.empty.sections.transmittal",
} as const;

/** "2026-10" → "October 2026". */
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString(intlLocale(), { month: "long", year: "numeric" });
}

/**
 * The works views of the İşler hub: Tüm İşler, the sections (?bolum=…) and Bana Düşenler
 * (?bolum=bana). Filters live in the URL (q, tip, durum, termin, acik, grup, hizli), so a view
 * can be saved and shared; the record opens in the detail pane next to the list.
 */
export function WorksPage() {
  // The submittal register and RFI log views are Manage's.
  const RegisterView = webCapability("manage.ui")?.RegisterView;
  const { t } = useTranslation(["works", "common"]);
  const { t: ts } = useTranslation("shell");
  const project = useProject();
  const { wid } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const bolum = search.get("bolum") ?? "";
  const mineView = bolum === "bana";
  const section = WORK_SECTIONS.find((x) => x.key === bolum) ?? null;
  const modules = project.modules ?? resolveModules(null);
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const open_ = (id: string) => navigate(`/projects/${project.id}/works/${id}${suffix}`);

  const type = search.get("tip") ?? "";
  const status = search.get("durum") ?? "";
  const query = search.get("q") ?? "";
  const dueParam = search.get("termin");
  const due: "" | "overdue" | "soon" = dueParam === "overdue" || dueParam === "soon" ? dueParam : "";
  const open = search.get("acik") === "1";
  const groupParam = search.get("grup") ?? "";
  const groupBy: GroupBy = GROUP_LABELS.some(([k]) => k === groupParam) ? (groupParam as GroupBy) : "";
  const quickParam = search.get("hizli") ?? "";
  const quickList = section ? QUICK.filter((x) => section.quick.includes(x.key)) : [];
  const quick = quickList.some((x) => x.key === quickParam) ? quickParam : "";
  const q0 = QUICK.find((x) => x.key === quick);

  const setFilters = (patch: Record<string, string>) =>
    setSearch(
      (p) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        p.delete("gorunum");
        return p;
      },
      { replace: true },
    );

  const embedded = useEmbedded();
  const phone = usePhoneWidth();
  const [q, setQ] = useState(query);
  const [mineTick, setMineTick] = useState(0);
  const latest = useRef({ setFilters, query });
  latest.current = { setFilters, query };
  useEffect(() => setQ((cur) => (cur.trim() === query ? cur : query)), [query]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim() !== latest.current.query) latest.current.setFilters({ q: q.trim() });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const { data: allTypes } = useLoad(() => worksApi.types(project.id), [project.id]);
  const types = useMemo(
    () => (section ? allTypes?.filter((t) => section.categories.includes(t.category)) : allTypes),
    [allTypes, section],
  );
  const { data: works, error, reload } = useLoad(
    () =>
      mineView
        ? Promise.resolve([] as WorkSummaryDto[])
        : worksApi.list(project.id, {
            type: type || undefined,
            status: status || undefined,
            q: query || undefined,
            due: due || undefined,
            open,
            category: section?.categories.join(","),
            view: q0?.letters,
          }),
    [project.id, type, status, query, due, open, q0?.letters, section?.key, mineView, embedded?.refreshKey],
  );
  const { data: companies } = useLoad(() => api.companies(), []);
  const cname = useMemo(() => new Map(companies?.map((c) => [c.id, c.name])), [companies]);
  const statuses = useMemo(() => {
    const list = (type ? types?.filter((t) => t.key === type) : types) ?? [];
    const seen = new Map<string, string>();
    for (const t of list) for (const s of t.statuses) if (!seen.has(s.key)) seen.set(s.key, s.label);
    return [...seen];
  }, [types, type]);
  const groups = useMemo(() => {
    if (!works) return [];
    if (!groupBy) return [{ key: "", label: "", rows: works }];
    const keyOf = (w: WorkSummaryDto): string => {
      switch (groupBy) {
        case "type":
          return w.typeName;
        case "status":
          return w.statusLabel;
        case "company": {
          const incoming = types?.find((t) => t.id === w.typeId)?.settings.incoming;
          const other = incoming ? w.fromCompanyId : w.toCompanyIds[0];
          return (other && cname.get(other)) || t("list.noCompany");
        }
        default:
          return (w.sentAt ?? w.createdAt).slice(0, 7);
      }
    };
    const map = new Map<string, WorkSummaryDto[]>();
    for (const w of works) {
      const k = keyOf(w);
      map.set(k, [...(map.get(k) ?? []), w]);
    }
    const keys = [...map.keys()];
    if (groupBy === "month") keys.sort().reverse();
    return keys.map((k) => ({ key: k, label: groupBy === "month" ? monthLabel(k) : k, rows: map.get(k)! }));
  }, [works, groupBy, types, cname, t]);
  const cardGroups = useMemo(() => {
    if (!phone) return [];
    const incoming = new Set(allTypes?.filter((t) => t.settings.incoming).map((t) => t.id));
    return groups.map((g) => ({
      ...g,
      rows: g.rows.map((w) => workCard(w, { incoming: incoming.has(w.typeId), companyNames: cname })),
    }));
  }, [phone, groups, allTypes, cname]);

  if (mineView)
    return (
      <div className={`split${wid ? " with-detail" : ""}`}>
        <div className="page" style={{ maxWidth: "none", width: "100%", overflow: "auto" }}>
          <MyItems keepSearch={suffix} refresh={mineTick} />
        </div>
        {wid && allTypes && (
          <WorkDetail
            key={wid}
            workId={wid}
            types={allTypes}
            companies={companies ?? []}
            onChanged={() => setMineTick((t) => t + 1)}
          />
        )}
      </div>
    );

  const register = section?.quick.includes("rfi-log") ? "rfi-log" : section?.quick.includes("register") ? "register" : null;
  const letterQuick = quickList.filter((x) => x.letters);
  const typeName = types?.find((t) => t.key === type)?.name ?? type;
  const statusName = statuses.find(([k]) => k === status)?.[1] ?? status;
  const chips: FilterChip[] = [
    ...(query ? [{ key: "q", label: t("list.chips.search", { query }), clear: () => setFilters({ q: "" }) }] : []),
    ...(type ? [{ key: "tip", label: t("list.chips.type", { type: typeName }), clear: () => setFilters({ tip: "", durum: "" }) }] : []),
    ...(status ? [{ key: "durum", label: t("list.chips.status", { status: statusName }), clear: () => setFilters({ durum: "" }) }] : []),
    ...(due ? [{ key: "termin", label: t(DUE_LABELS[due]), clear: () => setFilters({ termin: "" }) }] : []),
    ...(open ? [{ key: "acik", label: t("list.options.openOnly"), clear: () => setFilters({ acik: "" }) }] : []),
    ...(groupBy
      ? [{ key: "grup", label: t(GROUP_LABELS.find(([k]) => k === groupBy)![1]), clear: () => setFilters({ grup: "" }) }]
      : []),
    ...(q0?.letters ? [{ key: "hizli", label: ts(q0.labelKey), clear: () => setFilters({ hizli: "" }) }] : []),
  ];
  const filtered = chips.length > 0;
  const sectionEmpty = section ? SECTION_EMPTY[section.key as keyof typeof SECTION_EMPTY] : undefined;
  const emptyText = filtered
    ? t("list.empty.filtered")
    : sectionEmpty
      ? t(sectionEmpty)
      : t("list.empty.all");

  return (
    <div className={`split${wid ? " with-detail" : ""}`}>
      <div className="page" style={{ maxWidth: "none", width: "100%", overflow: "auto" }}>
        <FilterBar
          search={q}
          onSearch={setQ}
          placeholder={t("list.placeholder")}
          chips={chips}
          onClearAll={() => {
            setQ("");
            setFilters({ q: "", tip: "", durum: "", termin: "", acik: "", grup: "", hizli: "" });
          }}
          popover={
            <>
              {(types?.length ?? 0) > 1 && (
                <>
                  <label>{t("list.columns.type")}</label>
                  <select aria-label={t("list.columns.type")} value={type} onChange={(e) => setFilters({ tip: e.target.value, durum: "" })}>
                    <option value="">{t("common:status.all")}</option>
                    {types?.map((t) => (
                      <option key={t.id} value={t.key}>
                        {t.icon} {t.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label>{t("common:fields.status")}</label>
              <select aria-label={t("common:fields.status")} value={status} onChange={(e) => setFilters({ durum: e.target.value })}>
                <option value="">{t("list.options.allStatuses")}</option>
                {statuses.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <label>{t("common:fields.dueDate")}</label>
              <select aria-label={t("common:fields.dueDate")} value={due} onChange={(e) => setFilters({ termin: e.target.value })}>
                <option value="">{t("list.options.allDueDates")}</option>
                <option value="overdue">{t(DUE_LABELS.overdue)}</option>
                <option value="soon">{t(DUE_LABELS.soon)}</option>
              </select>
              {letterQuick.length > 0 && (
                <>
                  <label>{t("list.fields.quickFilter")}</label>
                  <select
                    aria-label={t("list.fields.quickFilter")}
                    value={q0?.letters ? quick : ""}
                    onChange={(e) => setFilters({ hizli: e.target.value })}
                  >
                    <option value="">{t("common:status.none")}</option>
                    {letterQuick.map((x) => <option key={x.key} value={x.key}>{ts(x.labelKey)}</option>)}
                  </select>
                </>
              )}
              <label>{t("list.fields.groupBy")}</label>
              <select value={groupBy} onChange={(e) => setFilters({ grup: e.target.value })} aria-label={t("list.fields.groupBy")}>
                {GROUP_LABELS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
              </select>
              <label className="check" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={open} onChange={(e) => setFilters({ acik: e.target.checked ? "1" : "" })} /> {t("list.options.openOnly")}
              </label>
            </>
          }
          extra={
            <>
              {register && (
                <div className="seg" role="group" aria-label={t("list.fields.display")}>
                  <button className={!q0?.view ? "active" : ""} onClick={() => setFilters({ hizli: "" })}>{t("list.options.list")}</button>
                  <button className={q0?.view ? "active" : ""} onClick={() => setFilters({ hizli: register })}>
                    {ts(QUICK.find((x) => x.key === register)!.labelKey)}
                  </button>
                </div>
              )}
              {section?.key === "teknik-onaylar" && modules.spec && (
                <Link className="btn" to={`/projects/${project.id}/spec`} title={t("list.specRegisterHint")}>
                  {t("list.actions.specRegister")}
                </Link>
              )}
              {modules.reports && <ReportShortcut module={worksSectionModule(section?.key)} />}
            </>
          }
        />
        {q0?.view && RegisterView ? (
          <RegisterView kind={q0.view} stamp={works} onOpen={open_} />
        ) : (
          <>
            {error && <p className="error">{error}</p>}
            {phone ? (
              <RecordCards groups={cardGroups} selectedId={wid} onOpen={open_} emptyText={works ? emptyText : null} label={ts("nav.items.isler")} />
            ) : (
              <WorksTable
                groups={groups}
                works={works}
                selectedId={wid}
                companyNames={cname}
                emptyText={emptyText}
                onOpen={open_}
              />
            )}
          </>
        )}
      </div>
      {wid && allTypes && <WorkDetail key={wid} workId={wid} types={allTypes} companies={companies ?? []} onChanged={reload} />}
    </div>
  );
}
