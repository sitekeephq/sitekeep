import { describe, expect, it } from "vitest";
import {
  NEW_RECORD_KINDS,
  NEW_RECORD_KIND_LABELS_TR,
  guessNewRecord,
  isTitleCaseTr,
  matchByName,
  moduleOfNewRecordKind,
  type IntentCompany,
} from "../src/index.js";

const companies: IntentCompany[] = [
  { id: "prota", name: "Prota Mühendislik" },
  { id: "cns", name: "Çınar Tasarım ve Mühendislik", code: "CNS" },
  { id: "hill", name: "Hilal Müşavirlik", code: "HLL" },
  { id: "poyraz", name: "Poyraz İnşaat", code: "PAS" },
];

describe("guessNewRecord: keyword rules of '+ Yeni'", () => {
  it("bilgi talebi with the recipient company and a clean title", () => {
    const g = guessNewRecord("Prota'ya B3 kazısı için bilgi talebi aç", companies);
    expect(g.kind).toBe("rfi");
    expect(g.companyId).toBe("prota");
    expect(g.companyRole).toBe("to");
    expect(g.title).toBe("B3 kazısı");
    expect(g.matched).toEqual(["bilgi", "talebi"]);
  });

  it("incoming letter: the company is the sender", () => {
    const g = guessNewRecord("CNS'den gelen yazıyı kaydet", companies);
    expect(g.kind).toBe("gelen-yazi");
    expect(g.companyId).toBe("cns");
    expect(g.companyRole).toBe("from");
    expect(g.title).toBe("");
    expect(guessNewRecord("Hilal'den yazı geldi: kablo tavası onayı", companies)).toMatchObject({
      kind: "gelen-yazi",
      companyId: "hill",
      companyRole: "from",
      title: "Kablo tavası onayı",
    });
  });

  it("a plain 'yazı' is an outgoing letter", () => {
    const g = guessNewRecord("Hilal'e kablo tavası güzergâhı onayı hakkında yazı yaz", companies);
    expect(g).toMatchObject({ kind: "giden-yazi", companyId: "hill", companyRole: "to", title: "Kablo tavası güzergâhı onayı" });
  });

  it("recognises every record type", () => {
    const cases: [string, string][] = [
      ["Teknik onay: yangın kapısı numunesi", "submittal"],
      ["Haftalık koordinasyon toplantısı", "meeting"],
      ["Jeneratör odası için eylem", "action"],
      ["Statik paftalar için gönderim formu hazırla", "transmittal"],
      ["B2 kat kolon C4 pas payı sorunu", "issue"],
      ["Rampa korkuluğunda çatlak var", "issue"],
      ["Beton döküm formu doldur", "form"],
      ["Statik paftaları incelemeye gönder", "review"],
      ["Elektrik paftalarını yükle", "upload"],
    ];
    for (const [text, kind] of cases) expect(guessNewRecord(text).kind, text).toBe(kind);
  });

  it("'yüklenici' (contractor) is not an upload", () => {
    expect(guessNewRecord("Yükleniciye resmi yazı gönder")).toMatchObject({ kind: "giden-yazi", title: "Yükleniciye" });
    expect(guessNewRecord("Yüklenicinin teknik onay talebi").kind).toBe("submittal");
  });

  it("keeps words that describe an issue or a form in the title", () => {
    expect(guessNewRecord("B3 perde duvarda çatlak sorunu aç")).toMatchObject({ kind: "issue", title: "B3 perde duvarda çatlak" });
    expect(guessNewRecord("Rampa korkuluğunda hasar")).toMatchObject({ kind: "issue", title: "Rampa korkuluğunda hasar" });
    expect(guessNewRecord("İSG saha denetimi formu doldur")).toMatchObject({ kind: "form", title: "İSG saha denetimi" });
  });

  it("works without Turkish letters", () => {
    expect(guessNewRecord("prota'ya bilgi talebi ac", companies)).toMatchObject({ kind: "rfi", companyId: "prota" });
    expect(guessNewRecord("haftalik koordinasyon toplantisi").kind).toBe("meeting");
    expect(guessNewRecord("CNS'DEN GELEN YAZI").kind).toBe("gelen-yazi");
  });

  it("'gönderim formu' is a transmittal, not a form; 'gelen yazı' is not an outgoing letter", () => {
    expect(guessNewRecord("gönderim formu").kind).toBe("transmittal");
    expect(guessNewRecord("gelen yazı").kind).toBe("gelen-yazi");
  });

  it("matches companies by code or a distinctive name word, not by generic words", () => {
    expect(guessNewRecord("PAS'a teknik onay", companies)).toMatchObject({ companyId: "poyraz", companyRole: "to" });
    expect(guessNewRecord("protaya bilgi talebi", companies).companyId).toBe("prota");
    // "İnşaat" and "Mühendislik" are in many company names: no match.
    expect(guessNewRecord("İnşaat mühendisliği için bilgi talebi", companies).companyId).toBeNull();
    // A longer word that only starts like a company name is not that company.
    expect(guessNewRecord("Pasifikasyon bilgi talebi", companies).companyId).toBeNull();
  });

  it("no rule: no type, the sentence becomes the title", () => {
    const g = guessNewRecord("asansör kuyusu ölçüleri");
    expect(g).toMatchObject({ kind: null, title: "Asansör kuyusu ölçüleri", companyId: null, companyRole: null, matched: [] });
    expect(guessNewRecord("   ").title).toBe("");
  });

  it("tile labels are Title Case and every kind maps to a module (upload: none)", () => {
    for (const k of NEW_RECORD_KINDS) expect(isTitleCaseTr(NEW_RECORD_KIND_LABELS_TR[k])).toBe(true);
    expect(moduleOfNewRecordKind("upload")).toBeNull();
    expect(moduleOfNewRecordKind("gelen-yazi")).toBe("correspondence");
    expect(moduleOfNewRecordKind("action")).toBe("meetings");
    expect(moduleOfNewRecordKind("review")).toBe("reviews");
  });
});

describe("matchByName: a form template named in the sentence", () => {
  const templates = [
    { id: "bdo", name: "Beton Döküm Onay Formu", code: "BDO" },
    { id: "gsr", name: "Günlük Şantiye Raporu", code: "GSR" },
    { id: "isg", name: "İSG Saha Denetimi", code: "ISG" },
  ];
  it("finds the template by its distinctive words, with Turkish suffixes", () => {
    expect(matchByName("beton döküm formu doldur", templates)?.id).toBe("bdo");
    expect(matchByName("bugünkü şantiye raporunu doldur", templates)?.id).toBe("gsr");
    expect(matchByName("isg denetimi formu", templates)?.id).toBe("isg");
    expect(matchByName("GSR formu", templates)?.id).toBe("gsr");
  });
  it("returns null when nothing or several match equally", () => {
    expect(matchByName("form doldur", templates)).toBeNull();
    expect(matchByName("", templates)).toBeNull();
    expect(matchByName("rapor formu", [{ id: "a", name: "A Raporu" }, { id: "b", name: "B Raporu" }])).toBeNull();
  });
});
