import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatChainage, type LocationDto, type LocationLinkKind } from "@sitekeep/shared";
import { api } from "../api/api";

/** Locations in tree order with their depth. */
export function flattenLocations(list: LocationDto[]): { loc: LocationDto; depth: number }[] {
  const kids = new Map<string | null, LocationDto[]>();
  const ids = new Set(list.map((l) => l.id));
  for (const l of list) {
    const p = l.parentId && ids.has(l.parentId) ? l.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), l]);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "tr"));
  const out: { loc: LocationDto; depth: number }[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const l of kids.get(pid) ?? []) {
      out.push({ loc: l, depth });
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function locationLabel(l: LocationDto): string {
  const km = l.kmStart !== null || l.kmEnd !== null ? ` · Km ${formatChainage(l.kmStart)}${l.kmEnd !== null ? `–${formatChainage(l.kmEnd)}` : ""}` : "";
  return `${l.code ? `${l.code} ` : ""}${l.name}${km}`;
}

export function LocationSelect({
  locations,
  value,
  onChange,
  disabled,
  emptyLabel,
}: {
  locations: LocationDto[] | null | undefined;
  value: string | null;
  onChange(id: string | null): void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const { t } = useTranslation("shell");
  return (
    <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{emptyLabel ?? t("location.none")}</option>
      {flattenLocations(locations ?? []).map(({ loc, depth }) => (
        <option key={loc.id} value={loc.id}>
          {"  ".repeat(depth)}
          {depth ? "└ " : ""}
          {locationLabel(loc)}
        </option>
      ))}
    </select>
  );
}

/** Location field for an issue / file: reads and writes the location link. */
export function LocationLinkField({
  projectId,
  kind,
  targetId,
  disabled,
}: {
  projectId: string;
  kind: LocationLinkKind;
  targetId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("shell");
  const [locations, setLocations] = useState<LocationDto[] | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.locations(projectId).then(setLocations, () => setLocations([]));
    api.locationLinks(projectId, { kind, targetId }).then((l) => setValue(l[0]?.locationId ?? null), () => undefined);
  }, [projectId, kind, targetId]);
  if (locations && !locations.length) return null;
  return (
    <div>
      <label>{t("location.field")}</label>
      <LocationSelect
        locations={locations}
        value={value}
        disabled={disabled}
        onChange={async (id) => {
          setError(null);
          try {
            await api.setLocationLink(projectId, kind, targetId, id);
            setValue(id);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
