// i18n-ok-file: Turkish term list and instruction for language-model prompts (model-facing text)
/**
 * The Turkish words the CDE shows instead of the usual English construction-software terms
 * (full list with notes: docs/product/TERIMLER.md). Language-model prompts use this list so generated
 * texts (Sor answers, report titles, summaries) speak the same language as the UI.
 */
export const UI_TERMS_TR: readonly (readonly [en: string, tr: string])[] = [
  ["issue", "sorun"],
  ["review", "inceleme"],
  ["RFI", "bilgi talebi"],
  ["RFI log", "bilgi talebi listesi"],
  ["submittal", "teknik onay"],
  ["submittal register", "teknik onay listesi"],
  ["transmittal", "gönderim formu"],
  ["markup", "işaretleme"],
  ["clash", "çakışma"],
  ["model set", "model seti"],
  ["federated model", "birleşik model"],
  ["viewer", "görüntüleyici"],
  ["dashboard", "panel"],
  ["workflow", "iş akışı"],
  ["template", "şablon"],
  ["ball in court", "sıradaki taraf"],
  ["baseline", "temel plan"],
  ["lookahead", "yakın dönem planı"],
  ["action item", "eylem"],
  ["spec", "şartname"],
  ["token", "erişim anahtarı"],
  ["WIP", "çalışma"],
  ["shared", "paylaşılan"],
  ["published", "yayınlanan"],
  ["archived", "arşivlenen"],
];

/** One sentence for language-model prompts: write the Turkish terms, not the English ones. */
export function termsInstructionTr(): string {
  return (
    "Kullanıcının göreceği metinde İngilizce terim kullanma, CDE'nin Türkçe karşılıklarını yaz: " +
    UI_TERMS_TR.map(([en, tr]) => `${en} → ${tr}`).join(", ") +
    "."
  );
}
