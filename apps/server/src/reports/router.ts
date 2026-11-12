/**
 * Dataset router of the AI report builder: picks the few datasets a Turkish request needs, so the
 * system prompt carries only their field lists (the local model has a 16K context and is slow on
 * CPU). Same idea as the "Sor" tool router (ai/assistant.ts routeTools): keyword groups on folded
 * text, plus the module the user opened the builder from and the datasets of the dashboard being
 * edited.
 */
import { foldTr, type ReportModule, type ReportQueryRef } from "@sitekeep/shared";

/** Lower-case ASCII fold (ı→i, ş→s, ç→c, ğ→g, ö→o, ü→u) for keyword matching. */
export function foldAscii(text: string): string {
  return foldTr(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i");
}

/** Keyword groups (on folded text) → datasets. Order = priority when the request matches several. */
export const DATASET_ROUTES: { key: string; re: RegExp; datasets: string[] }[] = [
  { key: "steps", re: /bekletti|bekleme sure|kim ne kadar|darbogaz|adim sure|adimlar|hangi adim|akis sure|onay sure/, datasets: ["workflow_steps"] },
  { key: "correspondence", re: /yazisma|\byazi(?:lar|lari|ya|yi|nin)?\b|cevap bekle|cevaplanmamis|resmi yazi|gelen yazi|giden yazi|\bkep\b|e-?posta gonder/, datasets: ["correspondence"] },
  { key: "rfi", re: /\brfi|bilgi talep/, datasets: ["rfis"] },
  { key: "submittals", re: /submittal|teknik onay|malzeme onay|numune|atolye|onay paket|revizyon sayisi/, datasets: ["submittals"] },
  { key: "meetings", re: /toplanti|tutanak|eylem|aksiyon|gundem|katilimci/, datasets: ["meetings", "actions"] },
  { key: "transmittals", re: /transmittal|gonderim form|alindi onay/, datasets: ["transmittals"] },
  { key: "reviews", re: /incele|review|onay akis|onay zincir|\bzincir|kapi(?:li)? klasor/, datasets: ["reviews", "review_files"] },
  { key: "forms", re: /(?<!gonderim )\bform|kontrol listesi|checklist|denetim|basarisiz|gunluk rapor|\bpuan/, datasets: ["forms"] },
  { key: "locations", re: /konum|lokasyon|mahal|\bblok|\bkat\b|\bkm\b|istasyon/, datasets: ["locations"] },
  { key: "costs", re: /maliyet|\b5d\b|birim fiyat|\bpoz\b|metraj|nakit akis|butce|harcama|hakedis/, datasets: ["model_costs", "cost_cashflow"] },
  { key: "schedule", re: /is program|takvim|faaliyet|(?<!yukleme )aktivite(?!\s*kayd)|kritik yol|s-?egri|baseline|temel plan|\bwbs|is kirilim|ilerleme|tamamlanma|kilometre tasi/, datasets: ["schedule_activities"] },
  { key: "clashes", re: /cakisma|clash|carpisma|koordinasyon|sinif cift/, datasets: ["clash_results"] },
  { key: "compare", re: /karsilastir|antet|revizyon uyari|degisen sayfa|degisiklik/, datasets: ["doc_comparisons"] },
  { key: "spec", re: /sartname/, datasets: ["spec_registers"] },
  { key: "works", re: /\bisler|tum is|\bis\b(?!\s*(?:program|kirilim))|\bisi\b|gorev/, datasets: ["works"] },
  { key: "issues", re: /sorun|issue|ihlal|\beksik/, datasets: ["issues"] },
  { key: "files", re: /dosya|dokuman|belge|yukle|versiyon|klasor|pafta|cizim|boyut|uzanti|\bwip\b|paylasilan|yayinlanan|iso 19650/, datasets: ["files", "versions"] },
  { key: "models", re: /\bmodel|\bifc|eleman/, datasets: ["models"] },
  { key: "activity", re: /aktivite kayd|denetim kayd|kim indirdi|indirme|giris yap/, datasets: ["activity"] },
  { key: "members", re: /\buye|ekip|kullanici/, datasets: ["members"] },
];

/** Datasets used when nothing matches and no module is given. */
export const DEFAULT_DATASETS = ["works", "issues", "files"];
/** Most datasets described in one prompt. */
export const MAX_PROMPT_DATASETS = 4;

export interface RouteInput {
  prompt: string;
  /** Module the builder was opened from ("Rapor" shortcut). */
  module?: ReportModule;
  /** Datasets of that module (registry order). */
  moduleDatasets?: string[];
  /** Queries of the dashboard being edited: their datasets always stay. */
  current?: ReportQueryRef[];
  /** Explicitly requested datasets (e.g. from the UI). */
  datasets?: string[];
  /** Datasets the caller may use. */
  available: string[];
}

export interface RouteResult {
  datasets: string[];
  /** Keyword groups that matched (for logs and tests). */
  matched: string[];
}

/**
 * Picks the datasets for a request: those of the edited dashboard, explicitly requested ones, the
 * keyword matches in order of appearance, then the module's own datasets — at most
 * MAX_PROMPT_DATASETS, only datasets the caller may use.
 */
export function routeDatasets(input: RouteInput): RouteResult {
  const text = foldAscii(input.prompt);
  const hits = DATASET_ROUTES.map((r) => ({ r, at: text.search(r.re) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || DATASET_ROUTES.indexOf(a.r) - DATASET_ROUTES.indexOf(b.r));
  const ordered: string[] = [
    ...(input.current ?? []).map((q) => q.spec.dataset),
    ...(input.datasets ?? []),
    ...hits.flatMap((h) => h.r.datasets),
    ...(input.moduleDatasets ?? []),
  ];
  if (!ordered.length) ordered.push(...DEFAULT_DATASETS);
  const allowed = new Set(input.available);
  const picked: string[] = [];
  for (const d of ordered) {
    if (picked.length >= MAX_PROMPT_DATASETS) break;
    if (allowed.has(d) && !picked.includes(d)) picked.push(d);
  }
  if (!picked.length) for (const d of DEFAULT_DATASETS) if (allowed.has(d) && picked.length < MAX_PROMPT_DATASETS) picked.push(d);
  return { datasets: picked, matched: hits.map((h) => h.r.key) };
}
