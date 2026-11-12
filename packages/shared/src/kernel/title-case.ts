// i18n-ok-file: Turkish title-case rules (word list of Turkish conjunctions)
/**
 * "Her Kelime Büyük Harf İle Başlasın": names and labels (menu items, titles, tabs, buttons,
 * column headers, type and status names) are written in Title Case with Turkish casing rules.
 * Sentences (help texts, messages, placeholders) stay in sentence case. See docs/product/TERMINOLOGY.md.
 *
 * Labels are written title-cased in the source; this helper serves the seed upgrade of stored
 * default labels and the checks that keep the label tables in Title Case.
 */

/**
 * Words that stay lower case unless they open the name ("Formlar ve Konumlar", "Açık mı"): the
 * conjunctions ve, ile, veya, ya da, için, de/da, ki and, as in the TDK rule for titles, the
 * question particle mı/mi/mu/mü.
 */
export const TITLE_CASE_SMALL_WORDS_TR: readonly string[] = ["ve", "ile", "veya", "ya da", "için", "de", "da", "ki", "mı", "mi", "mu", "mü"];

const SMALL = new Set(TITLE_CASE_SMALL_WORDS_TR.filter((w) => !w.includes(" ")));
/** Words after which "ya" is the first half of "ya da". */
const YA_NEXT = new Set(["da", "de"]);

const lowerTr = (s: string) => s.toLocaleLowerCase("tr-TR");
const upperTr = (s: string) => s.toLocaleUpperCase("tr-TR");

/** Leading punctuation, the first letter and the rest of a word ("(çalışmada)" → "(", "ç", "alışmada)"). */
const WORD_RE = /^([^\p{L}\p{N}]*)(\p{L})(.*)$/su;

/** The letters of a word without surrounding punctuation ("(ve)" → "ve"). */
function core(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Title Case with Turkish casing: every word starts with a capital ("iş programı" → "İş Programı",
 * "ılık" → "Ilık"), except the conjunctions ve, ile, veya, ya da, için, de/da, ki and the question
 * particle mı/mi/mu/mü inside the text. Words that already start with a capital or a digit are
 * kept as they are, so abbreviations (PDF, IFC, BIM, ISO, KEP, MCP, BT, GF), numbers and
 * mixed-case names stay unchanged.
 * Words are separated by spaces and "/" ("Evet / hayır" → "Evet / Hayır").
 *
 * Text in parentheses is a note, not part of the name, and keeps its case:
 * "yeni şifre (en az 10 karakter)" → "Yeni Şifre (en az 10 karakter)", "aç (PDF)" → "Aç (PDF)".
 */
export function titleCaseTr(text: string): string {
  const parts = text.split(/(\s+|\/)/);
  // Words outside parentheses, with their index in `parts`.
  const words: number[] = [];
  let depth = 0;
  parts.forEach((p, i) => {
    if (!p || /^(\s+|\/)$/.test(p)) return;
    const lead = /^[^\p{L}\p{N}]*/u.exec(p)![0];
    const startDepth = depth + (lead.match(/\(/g)?.length ?? 0) - (lead.match(/\)/g)?.length ?? 0);
    depth += (p.match(/\(/g)?.length ?? 0) - (p.match(/\)/g)?.length ?? 0);
    if (depth < 0) depth = 0;
    if (startDepth <= 0 && /[\p{L}\p{N}]/u.test(p)) words.push(i);
  });
  words.forEach((idx, n) => {
    const word = parts[idx]!;
    const c = lowerTr(core(word));
    const isUpperWord = core(word).length > 1 && core(word) === upperTr(core(word));
    if (n > 0 && !isUpperWord) {
      const next = n + 1 < words.length ? lowerTr(core(parts[words[n + 1]!]!)) : "";
      if (SMALL.has(c) || (c === "ya" && YA_NEXT.has(next))) {
        parts[idx] = word.replace(/\p{L}+/u, (w) => lowerTr(w));
        return;
      }
    }
    const m = WORD_RE.exec(word);
    if (!m) return; // starts with a digit: "2026", "4D"
    const [, lead, first, rest] = m as unknown as [string, string, string, string];
    if (first !== lowerTr(first)) return; // already capitalised: "PDF", "İş", "Gönderim"
    if (/\p{Lu}/u.test(rest)) return; // mixed case: "kWh", "iOS"
    parts[idx] = lead + upperTr(first) + rest;
  });
  return parts.join("");
}

/** The text is already in Title Case (titleCaseTr leaves it unchanged). */
export function isTitleCaseTr(text: string): boolean {
  return titleCaseTr(text) === text;
}
