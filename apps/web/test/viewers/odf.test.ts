import { describe, expect, it } from "vitest";
import { odfPlainText, parseOdt, parseXml, safeHref, type OdfBlock } from "../../src/viewers/office/odf";

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';

const content = (styles: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}><!-- yorum --><office:automatic-styles>${styles}</office:automatic-styles>` +
  `<office:body><office:text>\n<text:sequence-decls><text:sequence-decl text:name="Tablo"/></text:sequence-decls>\n${body}\n</office:text></office:body></office:document-content>`;

describe("xml", () => {
  it("parses elements, attributes, entities and CDATA", () => {
    const root = parseXml(`<?xml version="1.0"?><a x="1 &amp; 2" y='&#x130;'><b/>metin &lt;3<![CDATA[<ham>]]></a>`);
    const a = root.children[0] as ReturnType<typeof parseXml>;
    expect(a.name).toBe("a");
    expect(a.attrs).toEqual({ x: "1 & 2", y: "İ" });
    expect(a.children).toEqual([{ name: "b", attrs: {}, children: [] }, "metin <3", "<ham>"]);
  });
});

describe("odt", () => {
  const styles = `
    <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic" fo:color="#c00000" style:text-underline-style="solid"/></style:style>
    <style:style style:name="T3" style:family="text"><style:text-properties fo:color="red;background:url(x)"/></style:style>
    <style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
    <style:style style:name="P2" style:family="paragraph" style:parent-style-name="P1"><style:paragraph-properties fo:break-before="page"/></style:style>
    <text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style>
    <text:list-style style:name="L2"><text:list-level-style-bullet text:level="1"/></text:list-style>`;

  it("reads headings, formatting, spaces, lists, tables, images and page breaks", () => {
    const body = `
      <text:h text:outline-level="2">Teklif – Çatı İzolasyonu</text:h>
      <text:p>Sayın <text:span text:style-name="T1">Yetkili</text:span>,<text:s text:c="2"/>süre <text:span text:style-name="T2">30 gün</text:span>.<text:tab/>Son<text:line-break/>satır</text:p>
      <text:list text:style-name="L1"><text:list-item><text:p>Birinci</text:p></text:list-item><text:list-item><text:p>İkinci</text:p>
        <text:list><text:list-item><text:p>Alt</text:p></text:list-item></text:list></text:list-item></text:list>
      <text:list text:style-name="L2"><text:list-item><text:p>Madde</text:p></text:list-item></text:list>
      <table:table><table:table-columns><table:table-column table:number-columns-repeated="3"/></table:table-columns>
        <table:table-header-rows><table:table-row><table:table-cell><text:p>Kalem</text:p></table:table-cell><table:table-cell><text:p>Miktar</text:p></table:table-cell><table:table-cell><text:p>Tutar</text:p></table:table-cell></table:table-row></table:table-header-rows>
        <table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Toplam</text:p></table:table-cell><table:covered-table-cell/><table:table-cell><text:p>1.152.000,00</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"/></table:table-row>
        <table:table-row table:number-rows-repeated="5000"><table:table-cell table:number-columns-repeated="3"/></table:table-row>
      </table:table>
      <text:p text:style-name="P2"><draw:frame svg:width="8cm" svg:height="5cm"><draw:image xlink:href="Pictures/foto.png"/></draw:frame></text:p>
      <text:p>   </text:p>`;
    const doc = parseOdt(content(styles, body));
    const [h, p, ol, ul, table, brk, img, empty] = doc.blocks as OdfBlock[];
    expect(h).toEqual({ t: "h", level: 2, runs: [{ t: "text", text: "Teklif – Çatı İzolasyonu" }] });
    expect(p).toEqual({
      t: "p",
      runs: [
        { t: "text", text: "Sayın " },
        { t: "text", text: "Yetkili", b: true },
        { t: "text", text: "," },
        { t: "text", text: "  " },
        { t: "text", text: "süre " },
        { t: "text", text: "30 gün", i: true, u: true, color: "#c00000" },
        { t: "text", text: "." },
        { t: "text", text: "\t" },
        { t: "text", text: "Son" },
        { t: "br" },
        { t: "text", text: "satır" },
      ],
    });
    expect(ol).toMatchObject({ t: "list", ordered: true });
    expect(odfPlainText([ol!])).toBe("Birinci\nİkinci\nAlt");
    expect(ul).toMatchObject({ t: "list", ordered: false });
    expect(table?.t).toBe("table");
    const rows = (table as Extract<OdfBlock, { t: "table" }>).rows;
    // Header row + data row; empty repeated rows and cells are padding and dropped.
    expect(rows).toHaveLength(2);
    expect(rows[1]!.map((c) => [c.colSpan, odfPlainText(c.blocks)])).toEqual([
      [2, "Toplam"],
      [1, "1.152.000,00"],
    ]);
    expect(brk).toEqual({ t: "pagebreak" });
    expect(img).toEqual({ t: "p", align: "center", runs: [{ t: "img", src: "Pictures/foto.png", width: "8cm", height: "5cm" }] });
    expect(empty).toEqual({ t: "p", runs: [] });
    expect(doc.images).toEqual(["Pictures/foto.png"]);
  });

  it("keeps file content as data: no script links, no remote images, no CSS injection", () => {
    const body = `
      <text:p>&lt;script&gt;alert(1)&lt;/script&gt; <text:a xlink:href="javascript:alert(2)">bağlantı</text:a> <text:a xlink:href="https://example.com/a?b=1">site</text:a></text:p>
      <text:p><text:span text:style-name="T3">renk</text:span><draw:frame><draw:image xlink:href="https://izleyici.example/p.png"/></draw:frame><draw:frame><draw:image xlink:href="../../etc/passwd"/></draw:frame></text:p>`;
    const [p1, p2] = parseOdt(content(styles, body)).blocks as Extract<OdfBlock, { t: "p" }>[];
    expect(p1!.runs).toEqual([
      { t: "text", text: "<script>alert(1)</script> " },
      { t: "text", text: "bağlantı" },
      { t: "text", text: " " },
      { t: "text", text: "site", href: "https://example.com/a?b=1" },
    ]);
    expect(p2!.runs).toEqual([{ t: "text", text: "renk" }]);
    expect(safeHref(" mailto:a@b.c ")).toBe("mailto:a@b.c");
    expect(safeHref("data:text/html,x")).toBeUndefined();
  });

  it("uses named styles from styles.xml and skips notes and annotations", () => {
    const stylesXml = `<office:document-styles ${NS}><office:styles><style:style style:name="Kalin" style:family="text"><style:text-properties fo:font-weight="700"/></style:style></office:styles></office:document-styles>`;
    const body = `<text:p><text:span text:style-name="Kalin">Önemli</text:span><text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>dipnot</text:p></text:note-body></text:note><office:annotation><text:p>yorum</text:p></office:annotation></text:p>`;
    const doc = parseOdt(content("", body), stylesXml);
    expect(doc.blocks).toEqual([{ t: "p", runs: [{ t: "text", text: "Önemli", b: true }] }]);
  });

  it("returns no blocks for a file without a text body", () => {
    expect(parseOdt(`<office:document-content ${NS}><office:body><office:spreadsheet/></office:body></office:document-content>`).blocks).toEqual([]);
  });
});
