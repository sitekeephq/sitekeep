import { describe, expect, it } from "vitest";
import { isTitleCaseTr, titleCaseTr } from "../src/index.js";

describe("titleCaseTr", () => {
  it("capitalises every word with Turkish casing", () => {
    expect(titleCaseTr("işler")).toBe("İşler");
    expect(titleCaseTr("iş programı")).toBe("İş Programı");
    expect(titleCaseTr("ılık su")).toBe("Ilık Su");
    expect(titleCaseTr("tüm işler")).toBe("Tüm İşler");
    expect(titleCaseTr("notlu onaylandı")).toBe("Notlu Onaylandı");
    expect(titleCaseTr("çakışma özeti")).toBe("Çakışma Özeti");
    // Dotted/dotless i inside a word is left alone.
    expect(titleCaseTr("bilgi talepleri")).toBe("Bilgi Talepleri");
  });

  it("keeps conjunctions lower case unless they come first", () => {
    expect(titleCaseTr("formlar ve konumlar")).toBe("Formlar ve Konumlar");
    expect(titleCaseTr("Formlar Ve Konumlar")).toBe("Formlar ve Konumlar");
    expect(titleCaseTr("dosya ile klasör")).toBe("Dosya ile Klasör");
    expect(titleCaseTr("PDF veya DWG")).toBe("PDF veya DWG");
    expect(titleCaseTr("taslak ya da gönderildi")).toBe("Taslak ya da Gönderildi");
    expect(titleCaseTr("onay için")).toBe("Onay için");
    expect(titleCaseTr("model de var")).toBe("Model de Var");
    expect(titleCaseTr("klasör da")).toBe("Klasör da");
    expect(titleCaseTr("şunu ki")).toBe("Şunu ki");
    expect(titleCaseTr("açık mı")).toBe("Açık mı");
    expect(titleCaseTr("güncel versiyon mu")).toBe("Güncel Versiyon mu");
    expect(titleCaseTr("Termini Geçti Mi")).toBe("Termini Geçti mi");
    expect(titleCaseTr("ve sonra")).toBe("Ve Sonra");
    expect(titleCaseTr("için not")).toBe("İçin Not");
    expect(titleCaseTr("ile birlikte")).toBe("İle Birlikte");
    // "ya" alone is an ordinary word.
    expect(titleCaseTr("ya")).toBe("Ya");
    expect(titleCaseTr("sola ya")).toBe("Sola Ya");
  });

  it("keeps abbreviations, parenthesised abbreviations and numbers as they are", () => {
    expect(titleCaseTr("pdf olarak kaydet")).toBe("Pdf Olarak Kaydet");
    expect(titleCaseTr("PDF olarak kaydet")).toBe("PDF Olarak Kaydet");
    expect(titleCaseTr("sayfa düzeninde aç (PDF)")).toBe("Sayfa Düzeninde Aç (PDF)");
    expect(titleCaseTr("IFC model")).toBe("IFC Model");
    expect(titleCaseTr("BIM ve ISO 19650")).toBe("BIM ve ISO 19650");
    expect(titleCaseTr("KEP gönderim no")).toBe("KEP Gönderim No");
    expect(titleCaseTr("MCP sunucusu")).toBe("MCP Sunucusu");
    expect(titleCaseTr("BT ve GF numaraları")).toBe("BT ve GF Numaraları");
    expect(titleCaseTr("son 30 gün")).toBe("Son 30 Gün");
    expect(titleCaseTr("4D planı")).toBe("4D Planı");
    expect(titleCaseTr("2026 yılı")).toBe("2026 Yılı");
    // An all-caps conjunction in an all-caps heading stays.
    expect(titleCaseTr("TEKNİK ONAY VE GÖNDERİM")).toBe("TEKNİK ONAY VE GÖNDERİM");
    // Mixed case is someone's name: left alone.
    expect(titleCaseTr("kWh tüketimi")).toBe("kWh Tüketimi");
  });

  it("leaves notes in parentheses as they are", () => {
    expect(titleCaseTr("yeni şifre (en az 10 karakter)")).toBe("Yeni Şifre (en az 10 karakter)");
    expect(titleCaseTr("not (isteğe bağlı)")).toBe("Not (isteğe bağlı)");
    expect(titleCaseTr("onaylandı (çakışma değil) ve kapandı")).toBe("Onaylandı (çakışma değil) ve Kapandı");
    expect(titleCaseTr("(ve) sonra")).toBe("(ve) Sonra");
    expect(titleCaseTr("01-WIP (çalışmada)")).toBe("01-WIP (çalışmada)");
    expect(titleCaseTr("revizyon tablosu (")).toBe("Revizyon Tablosu (");
  });

  it("handles punctuation, separators and spacing", () => {
    expect(titleCaseTr("+ yeni yazı")).toBe("+ Yeni Yazı");
    expect(titleCaseTr("evet / hayır")).toBe("Evet / Hayır");
    expect(titleCaseTr("yükle/indir")).toBe("Yükle/İndir");
    expect(titleCaseTr("özet / not")).toBe("Özet / Not");
    expect(titleCaseTr("e-posta adresi")).toBe("E-posta Adresi");
    expect(titleCaseTr("sor…")).toBe("Sor…");
    expect(titleCaseTr("  çift  boşluk ")).toBe("  Çift  Boşluk ");
    expect(titleCaseTr("“tırnaklı” ad")).toBe("“Tırnaklı” Ad");
    expect(titleCaseTr("revize et, tekrar gönder")).toBe("Revize Et, Tekrar Gönder");
    expect(titleCaseTr("")).toBe("");
    expect(titleCaseTr("—")).toBe("—");
  });

  it("is idempotent and recognises Title Case", () => {
    for (const s of ["revize et ve tekrar gönder", "iş programı", "sayfa düzeninde aç (PDF)", "taslak ya da gönderildi"]) {
      const once = titleCaseTr(s);
      expect(titleCaseTr(once)).toBe(once);
      expect(isTitleCaseTr(once)).toBe(true);
    }
    expect(titleCaseTr("revize et ve tekrar gönder")).toBe("Revize Et ve Tekrar Gönder");
    expect(isTitleCaseTr("Tüm işler")).toBe(false);
    expect(isTitleCaseTr("Model Görüntüleyici")).toBe(true);
  });
});
