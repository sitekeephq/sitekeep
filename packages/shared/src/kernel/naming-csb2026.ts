/**
 * ÇŞB 2026 file naming profile (EK-2 of the regulation on the digital preparation of architecture
 * and engineering projects, Resmî Gazete 5 August 2026, no. 33331): a naming standard built from
 * the official tables (`naming-profiles/csb-2026-ek2.json`). docs/features/NAMING_CSB_2026.md.
 *
 *   Proje Kodu_Bina Kodu_Disiplin_Alt Disiplin/Öge_Dosya Türü_Dosya Tipi_Kat/Konum_Sıra No_Revizyon No
 *   6          2         2        4                 2          3          3          2       3   = 35
 *
 * The construction template generator (apps/server/templates/src/iso19650-yapim.mjs) builds the same
 * standard from the same JSON; a test keeps the two equal.
 */
import profile from "./naming-profiles/csb-2026-ek2.json" with { type: "json" };
import type { NamingStandard, NamingValue, TextField } from "./naming.js";

export const CSB_2026_STANDARD_NAME = "ÇŞB 2026 (EK-2)";
/** EK-1 project code: six characters (two-digit year + four-digit sequence; Tablo 2.1 allows letters). */
export const CSB_PROJECT_CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** The official tables as transcribed (names and codes as printed; see `notes`). */
export const CSB_2026_EK2 = profile;

const CSB_2026_FIELDS = {
  project: "Proje Kodu",
  building: "Bina Kodu",
  discipline: "Disiplin",
  sub: "Alt Disiplin / Öge",
  kind: "Dosya Türü",
  type: "Dosya Tipi",
  level: "Kat / Konum",
  sequence: "Sıra No",
  revision: "Revizyon No",
} as const;

/** Codes allowed after every discipline (2.6: DIGR; "Genel" when no item applies). */
const ANY_DISCIPLINE = new Set(["XXXX", "DIGR"]);
const GENERAL_NAMES: Record<string, string> = { XXXX: "Genel", DIGR: "Diğer" };

/** Alt Disiplin / Öge values merged by code: `parents` lists the disciplines whose table has it. */
function csb2026SubdisciplineValues(): NamingValue[] {
  const byCode = new Map<string, NamingValue>();
  for (const table of profile.subdisciplines) {
    for (const v of table.values) {
      const known = byCode.get(v.code);
      if (ANY_DISCIPLINE.has(v.code)) {
        if (!known) byCode.set(v.code, { code: v.code, description: GENERAL_NAMES[v.code]! });
        continue;
      }
      if (known) known.parents!.push(table.discipline);
      else byCode.set(v.code, { code: v.code, description: v.name, parents: [table.discipline] });
    }
  }
  return [...byCode.values()];
}

/**
 * The ÇŞB 2026 (EK-2) naming standard. `projectCode`: the EK-1 code of the project (the field becomes
 * a one-value list, so names are filled and checked with it), a template token such as "{EK1}"
 * (resolved when a project is created) or nothing (any six letters or digits).
 */
export function csb2026NamingStandard(options: { projectCode?: string } = {}): NamingStandard {
  const F = CSB_2026_FIELDS;
  const code = options.projectCode?.trim();
  const projectText: TextField = { name: F.project, type: "text", minLength: 6, maxLength: 6, charset: "alphanumeric" };
  const project =
    code && !code.includes("{")
      ? { name: F.project, type: "list" as const, values: [{ code, description: "Proje kodu (EK-1)" }] }
      : code
        ? { ...projectText, fixed: code }
        : projectText;
  return {
    name: CSB_2026_STANDARD_NAME,
    delimiter: profile.delimiter,
    maxLength: profile.maxLength,
    fields: [
      project,
      {
        name: F.building,
        type: "text",
        minLength: 2,
        maxLength: 2,
        charset: "alphanumeric",
        suggestions: [{ code: "00", description: "Tek bina" }],
      },
      { name: F.discipline, type: "list", values: profile.disciplines.map((d) => ({ code: d.code, description: d.name })) },
      { name: F.sub, type: "list", dependsOn: F.discipline, values: csb2026SubdisciplineValues() },
      {
        name: F.kind,
        type: "list",
        values: profile.fileKinds.map((k) => ({ code: k.code, description: "note" in k && k.note ? `${k.name} (${k.note})` : k.name })),
      },
      { name: F.type, type: "list", values: profile.fileTypes.flatMap((g) => g.values.map((v) => ({ code: v.code, description: v.name }))) },
      {
        name: F.level,
        type: "text",
        minLength: profile.levelRules.length,
        maxLength: profile.levelRules.length,
        charset: "alphanumeric",
        suggestions: profile.levels.map((l) => ({ code: l.code, description: l.name })),
      },
      { name: F.sequence, type: "number", digits: 2 },
      { name: F.revision, type: "number", digits: 3, inCode: false },
    ],
  };
}
