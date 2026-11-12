import { describe, expect, it } from "vitest";
import {
  LETTER_LABELS,
  LETTER_LANGS,
  combinedDate,
  combinedLabel,
  emptyLetter,
  formatLetterDate,
  letterLanguages,
  letterMailSubject,
  letterMailText,
  letterSendProblems,
  letterSubject,
  letterSummary,
  letterValues,
  parseLetterText,
  readLetter,
  referenceLine,
  referenceMark,
  type LetterData,
} from "../src/index.js";

function letter(p: Partial<LetterData> = {}): LetterData {
  return { ...emptyLetter(), ...p };
}

describe("letter labels and languages", () => {
  it("has the same label keys for all six languages", () => {
    const keys = Object.keys(LETTER_LABELS.tr).sort();
    for (const lang of LETTER_LANGS) {
      expect(Object.keys(LETTER_LABELS[lang]).sort()).toEqual(keys);
      expect(LETTER_LABELS[lang].reference_line).toMatch(/\{date\}.*|\{whose\}/);
    }
  });

  it("prints the main language first and drops a repeated second language", () => {
    expect(letterLanguages(letter())).toEqual(["tr"]);
    expect(letterLanguages(letter({ language: "tr", secondaryLanguage: "en" }))).toEqual(["tr", "en"]);
    expect(letterLanguages(letter({ language: "de", secondaryLanguage: "de" }))).toEqual(["de"]);
    expect(combinedLabel(letter({ secondaryLanguage: "en" }), "ref")).toBe("Sayı / Ref");
    expect(combinedLabel(letter({ language: "en", secondaryLanguage: "fr" }), "date")).toBe("Date");
    expect(combinedLabel(letter({ language: "de" }), "subject")).toBe("Betreff");
  });
});

describe("letter dates", () => {
  it("uses dd.MM.yyyy in Turkish and the long local form elsewhere", () => {
    expect(formatLetterDate("2026-03-05", "tr")).toBe("05.03.2026");
    expect(formatLetterDate("2026-03-05", "en")).toBe("5 March 2026");
    expect(formatLetterDate("2026-03-05", "de")).toBe("5. März 2026");
    expect(formatLetterDate("2026-03-05", "fr")).toBe("5 mars 2026");
    expect(formatLetterDate("2026-03-05", "it")).toBe("5 marzo 2026");
    expect(formatLetterDate("2026-03-05", "es")).toBe("5 de marzo de 2026");
    expect(formatLetterDate(null, "tr")).toBe("");
    expect(formatLetterDate("dün", "tr")).toBe("");
    expect(combinedDate(letter({ secondaryLanguage: "en" }), "2026-03-05")).toBe("05.03.2026 / 5 March 2026");
  });
});

describe("letter texts", () => {
  const l = letter({
    language: "tr",
    secondaryLanguage: "en",
    body: "Türkçe metin",
    signer: { name: "Ali Veli", title: "Proje Müdürü" },
    translations: { en: { subject: "Tender", body: "English text" }, de: { subject: "Ausschreibung" } },
  });

  it("falls back to the Turkish text when a translation is empty", () => {
    expect(letterValues(l, "İhale", "tr")).toMatchObject({ subject: "İhale", body: "Türkçe metin", signerTitle: "Proje Müdürü" });
    expect(letterValues(l, "İhale", "en")).toMatchObject({ subject: "Tender", body: "English text", signerTitle: "Proje Müdürü" });
    expect(letterValues(l, "İhale", "de")).toMatchObject({ subject: "Ausschreibung", body: "Türkçe metin" });
    expect(letterValues(l, "İhale", "fr").subject).toBe("İhale");
    expect(letterSubject(l, "İhale")).toBe("İhale / Tender");
    expect(letterSubject(letter(), "Konu")).toBe("Konu");
  });

  it("builds reference lines with yazınız / yazımız in every language", () => {
    const theirs = { date: "2026-03-05", number: "E-12345", incoming: true };
    const ours = { date: "2026-03-05", number: "GID-2026-00001", incoming: false };
    expect(referenceLine("tr", theirs)).toBe("05.03.2026 tarihli ve E-12345 sayılı yazınız.");
    expect(referenceLine("tr", ours)).toBe("05.03.2026 tarihli ve GID-2026-00001 sayılı yazımız.");
    expect(referenceLine("en", theirs)).toBe("Your letter No. E-12345 dated 5 March 2026.");
    expect(referenceLine("en", ours)).toBe("Our letter No. GID-2026-00001 dated 5 March 2026.");
    expect(referenceLine("de", theirs)).toBe("Ihr Schreiben Nr. E-12345 vom 5. März 2026.");
    expect(referenceLine("fr", ours)).toBe("Notre lettre n° GID-2026-00001 du 5 mars 2026.");
    expect(referenceLine("it", theirs)).toBe("Vostra lettera n. E-12345 del 5 marzo 2026.");
    expect(referenceLine("es", theirs)).toBe("Su carta n.º E-12345 de fecha 5 de marzo de 2026.");
    expect([0, 1, 25, 26].map(referenceMark)).toEqual(["a)", "b)", "z)", "aa)"]);
  });

  it("requires translated subject (and body when the Turkish body is set) before sending", () => {
    const fr = letter({ language: "fr", body: "Metin" });
    expect(letterSendProblems(fr, "GID-1")).toEqual([
      "GID-1: Yazı Français dilinde basılacak; Çeviriler bölümünde bu dil için konu ve içerik girin.",
    ]);
    expect(letterSendProblems({ ...fr, translations: { fr: { subject: "Objet" } } }, "GID-1")).toHaveLength(1);
    expect(letterSendProblems({ ...fr, translations: { fr: { subject: "Objet", body: "Texte" } } }, "GID-1")).toEqual([]);
    // Without a Turkish body only the subject is needed; Turkish-only letters need nothing.
    expect(letterSendProblems(letter({ secondaryLanguage: "en", translations: { en: { subject: "S" } } }), "x")).toEqual([]);
    expect(letterSendProblems(letter({ body: "x" }), "x")).toEqual([]);
  });

  it("parses light markup: paragraphs, bullets and bold", () => {
    expect(parseLetterText("İlk satır\nikinci satır\n\n- madde **bir**\n- madde iki\n\nSon **kalın** söz.")).toEqual([
      { kind: "p", runs: [{ text: "İlk satır\nikinci satır", bold: false }] },
      { kind: "li", runs: [{ text: "madde ", bold: false }, { text: "bir", bold: true }] },
      { kind: "li", runs: [{ text: "madde iki", bold: false }] },
      { kind: "p", runs: [{ text: "Son ", bold: false }, { text: "kalın", bold: true }, { text: " söz.", bold: false }] },
    ]);
    expect(parseLetterText("**Başlık** devam")[0]!.kind).toBe("p");
    expect(parseLetterText("  \n\n")).toEqual([]);
  });

  it("reads stored letter data defensively", () => {
    expect(readLetter(null)).toEqual(emptyLetter());
    const r = readLetter({
      language: "xx",
      secondaryLanguage: "tr",
      layout: "weird",
      recipient: { name: "KGM", email: 5 },
      ccEmails: ["a@b.c", 3, ""],
      translations: { en: { subject: "S", body: 1 }, tr: { subject: "x" }, zz: {} },
      mailSentAt: "2026-10-10T10:00:00.000Z",
    });
    expect(r).toMatchObject({
      language: "tr",
      secondaryLanguage: null,
      layout: "columns",
      recipient: { name: "KGM", address: "", email: "" },
      ccEmails: ["a@b.c"],
      translations: { en: { subject: "S" } },
    });
    expect(letterSummary(r)).toEqual({ languages: ["tr"], recipient: "KGM", recipientEmail: null, mailSent: true, mailSentAt: "2026-10-10T10:00:00.000Z" });
  });

  it("builds the e-mail subject and one text block per language", () => {
    const m = letter({ secondaryLanguage: "en", recipient: { name: "KGM", address: "", email: "evrak@kgm.example.com" }, translations: { en: { subject: "Delivery" } } });
    expect(letterMailSubject(m, "GID-2026-00001", "Teslim")).toBe("GID-2026-00001 - Teslim / Delivery");
    const text = letterMailText(m, { number: "GID-2026-00001", title: "Teslim", senderName: "Ali Veli", company: "PAS" });
    expect(text).toContain('Sayın KGM,\n\n"Teslim" konulu GID-2026-00001 sayılı yazımız ekte bilgilerinize sunulmuştur.');
    expect(text).toContain('Dear KGM,\n\nPlease find attached our letter No. GID-2026-00001 regarding "Delivery".');
    expect(text.indexOf("Sayın")).toBeLessThan(text.indexOf("----------"));
    expect(text.trimEnd().endsWith("Ali Veli\nPAS")).toBe(true);
  });
});
