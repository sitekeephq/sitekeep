/**
 * Keyword rules: a quick ModelQuery from a Turkish (or English) question without a language model.
 * Used for the instant first answer and when AI is off; the AI answer replaces it when it arrives.
 */
import { foldPlain, type ModelAggOp, type ModelChangeKind, type ModelQuery, type ModelQueryFilter, type ModelVocabDto } from "@sitekeep/shared";
import { compactFold } from "./model-index.js";

type Vocab = Pick<ModelVocabDto, "classes" | "storeys" | "properties">;

/** Folded word stems → IFC classes (checked against the classes present in the model). */
const CLASS_WORDS: [RegExp, string[]][] = [
  [/\b(yangin kapi|kapi|door)/, ["IfcDoor"]],
  [/\b(pencere|window)/, ["IfcWindow"]],
  [/\b(giydirme|curtain)/, ["IfcCurtainWall"]],
  [/\b(duvar|wall)/, ["IfcWall"]],
  [/\b(doseme|dosem|slab|floor slab|plak)/, ["IfcSlab"]],
  [/\b(cati|roof)/, ["IfcRoof", "IfcSlab"]],
  [/\b(kolon|column)/, ["IfcColumn"]],
  [/\b(kiris|beam)/, ["IfcBeam"]],
  [/\b(merdiven|stair)/, ["IfcStair", "IfcStairFlight"]],
  [/\b(rampa|ramp)/, ["IfcRamp", "IfcRampFlight"]],
  [/\b(korkuluk|railing)/, ["IfcRailing"]],
  [/\b(kaplama|covering|tavan|ceiling)/, ["IfcCovering"]],
  [/\b(temel|footing)/, ["IfcFooting"]],
  [/\b(kazik|pile)/, ["IfcPile"]],
  [/\b(mobilya|furniture)/, ["IfcFurnishingElement", "IfcFurniture"]],
  [/\b(boru|pipe)/, ["IfcPipeSegment", "IfcFlowSegment"]],
  [/\b(kanal|duct)/, ["IfcDuctSegment", "IfcFlowSegment"]],
  [/\b(menfez|air terminal)/, ["IfcAirTerminal"]],
  [/\b(aydinlatma|armatur|light)/, ["IfcLightFixture"]],
  [/\b(levha|plate)/, ["IfcPlate"]],
  [/\b(proxy|genel eleman)/, ["IfcBuildingElementProxy"]],
];

const AREA_RE = /\b(m2|metrekare\w*|alan\w*|area)\b|m²/;
const VOLUME_RE = /\b(m3|metrekup\w*|hacim\w*|volume)\b|m³/;
const LENGTH_RE = /\b(uzunlu\w*|metre tul|mtul|length)\b/;
const TRUE_FLAGS: [RegExp, string, boolean][] = [
  [/\b(dis|harici|external)\b/, "IsExternal", true],
  [/\b(ic|dahili|internal)\b (duvar|kapi|pencere)/, "IsExternal", false],
  [/\b(tasiyici|load ?bearing)\b/, "LoadBearing", true],
];

function hasClass(vocab: Vocab, cls: string): boolean {
  const c = cls.toLowerCase();
  return vocab.classes.some((v) => {
    const n = v.name.toLowerCase();
    return n === c || n === `${c}standardcase` || n === `${c}elementedcase`;
  });
}

/** Property key whose short name is one of the names (prefers the most used). */
function findProp(vocab: Vocab, names: string[]): string | null {
  for (const n of names) {
    const hit = vocab.properties.find((p) => compactFold(p.name) === compactFold(n));
    if (hit) return hit.name;
  }
  return null;
}

/** Storey named in the question: "2. kat", "kat 2", "zemin kat", "bodrum", "çatı katı" or a literal storey name. */
export function findStorey(q: string, vocab: Pick<Vocab, "storeys">): string | null {
  const storeys = vocab.storeys.filter((s) => s.name);
  if (!storeys.length) return null;
  // A storey name that literally occurs in the question.
  const literal = [...storeys].sort((a, b) => b.name.length - a.name.length).find((s) => s.name.length > 1 && q.includes(foldPlain(s.name)));
  if (literal) return literal.name;
  const ground = () => {
    const named = storeys.find((s) => /zemin|ground|giris|00\b/.test(foldPlain(s.name)));
    if (named) return named;
    const withElev = storeys.filter((s) => s.elevation !== null);
    return withElev.sort((a, b) => Math.abs(a.elevation!) - Math.abs(b.elevation!))[0] ?? storeys[0]!;
  };
  if (/\bzemin\b|\bground\b|\bgiris kat/.test(q)) return ground().name;
  if (/\bbodrum\b|\bbasement\b/.test(q)) {
    const named = storeys.find((s) => /bodrum|basement|b1|-1/.test(foldPlain(s.name)));
    if (named) return named.name;
    const g = storeys.indexOf(ground());
    return g > 0 ? storeys[g - 1]!.name : null;
  }
  const m = /(-?\d+)\s*\.?\s*(?:kat|normal kat|floor|level)|\b(?:kat|floor|level)\s*(-?\d+)/.exec(q);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  // A storey whose name carries the number ("Kat 2", "2. Kat", "Level 02", "+2").
  const byName = storeys.find((s) => {
    const nums = foldPlain(s.name).match(/-?\d+/g)?.map(Number) ?? [];
    return nums.length > 0 && nums[0] === n;
  });
  if (byName) return byName.name;
  const g = storeys.indexOf(ground());
  return storeys[g + n]?.name ?? null;
}

/** Fire-rating style tokens: EI60, REI 90, EI-30, E30. */
const RATING_RE = /\b(r?e?i|e|r|rei)\s*-?\s*(\d{2,3})\b/;

export function rulesQuery(question: string, vocab: Vocab, opts: { comparing?: boolean } = {}): ModelQuery {
  const q = foldPlain(question);
  const query: ModelQuery = {};
  const filters: ModelQueryFilter[] = [];

  // Classes
  const classes: string[] = [];
  for (const [re, list] of CLASS_WORDS) {
    if (!re.test(q)) continue;
    const present = list.filter((c) => hasClass(vocab, c));
    classes.push(...(present.length ? present : [list[0]!]));
  }
  if (classes.length) query.classes = [...new Set(classes)];

  // Storey
  const storey = findStorey(q, vocab);
  if (storey) query.storeys = [storey];

  // Comparison: kind of change.
  if (opts.comparing) {
    const change: ModelChangeKind[] = [];
    if (/\b(eklenen|eklendi|yeni|added|new)\b/.test(q)) change.push("added");
    if (/\b(silinen|silindi|kaldirilan|removed|deleted)\b/.test(q)) change.push("removed");
    if (/\b(degisen|degisti|degistirilen|changed|modified)\b/.test(q)) change.push("changed");
    if (change.length && change.length < 3) query.change = change;
  }

  // Fire rating value (EI60 …) with negation ("olmayan", "değil", "hariç").
  const negated = /\b(olmayan|degil|haric|disinda|without|not)\b/.test(q);
  const rating = RATING_RE.exec(q);
  const fireKey = findProp(vocab, ["FireRating", "YanginDayanimi", "Yangın Dayanımı", "FireResistance"]) ?? "FireRating"; // i18n-ok: property names matched in the model
  if (rating) {
    const value = `${rating[1]!.toUpperCase()}${rating[2]}`;
    filters.push({ field: fireKey, op: negated ? "!=" : "=", value });
  } else if (/\byangin\b|\bfire\b/.test(q)) {
    filters.push({ field: fireKey, op: negated ? "missing" : "exists" });
  }

  for (const [re, prop, val] of TRUE_FLAGS) {
    if (re.test(q)) {
      const key = findProp(vocab, [prop]) ?? prop;
      filters.push({ field: key, op: "=", value: val });
    }
  }

  // Quoted value: «… "Beton" …» → material / name / type contains.
  const quoted = /["“”'«](.+?)["“”'»]/.exec(question);
  if (quoted) filters.push({ field: /malzeme|material/.test(q) ? "material" : /\btip|type\b/.test(q) ? "type" : "name", op: "contains", value: quoted[1]!.trim() });
  else if (/\b(beton|celik|ahsap|tugla|gazbeton|alci|cam|alumin)/.test(q)) {
    const m = /\b(beton|celik|ahsap|tugla|gazbeton|alci|cam|alumin\w*)/.exec(q)!;
    filters.push({ field: "material", op: "contains", value: m[1]! });
  }

  // Aggregates: "kaç m² döşeme", "toplam hacim", "uzunluk".
  const sumOp: ModelAggOp = /\b(ortalama|average|avg)\b/.test(q) ? "avg" : "sum";
  if (AREA_RE.test(q) || VOLUME_RE.test(q) || LENGTH_RE.test(q)) {
    const names = VOLUME_RE.test(q)
      ? ["NetVolume", "GrossVolume", "Volume", "Hacim"]
      : LENGTH_RE.test(q)
        ? ["Length", "Uzunluk"]
        : classes.some((c) => /wall|window|door|curtain/i.test(c))
          ? ["NetSideArea", "GrossSideArea", "NetArea", "Area", "GrossArea", "Alan"]
          : ["NetArea", "GrossArea", "Area", "Alan", "NetSideArea"];
    const key = findProp(vocab, names);
    query.aggregate = { op: sumOp, field: key ?? names[0]! };
  }

  // Grouping: "katlara göre", "kat bazında", "tipe göre", "sınıfa göre".
  const groupBy: string[] = [];
  if (/\bkat(lara|a)? (gore|bazinda)|\bper (storey|floor|level)|\bkat kat\b/.test(q)) groupBy.push("storey");
  if (/\btip(lere|e)? (gore|bazinda)|\bper type\b/.test(q)) groupBy.push("type");
  if (/\bsinif(lara|a)? (gore|bazinda)|\bper class\b/.test(q)) groupBy.push("class");
  if (/\bmalzeme(lere|ye)? (gore|bazinda)\b/.test(q)) groupBy.push("material");
  if (groupBy.length) query.groupBy = groupBy.slice(0, 2);

  if (filters.length) query.filters = filters;
  return query;
}
