import { describe, expect, it } from "vitest";
import {
  VIEWER_EXTENSIONS,
  browserOffice,
  officePdfAction,
  officeShow,
  viewerFor,
  viewerForExtension,
  viewerPath,
  type PreviewDto,
  type PreviewStatus,
  type VersionPreviewDto,
} from "../src/index.js";

describe("viewer registry", () => {
  it("maps extensions to viewers, case-insensitive", () => {
    expect(viewerFor("Plan.PDF").kind).toBe("pdf");
    expect(viewerFor("model.ifc").kind).toBe("ifc");
    expect(viewerFor("rapor.docx").kind).toBe("document");
    expect(viewerFor("eski.doc").kind).toBe("document");
    expect(viewerFor("şartname.odt").kind).toBe("document");
    expect(viewerFor("not.rtf").kind).toBe("document");
    expect(viewerFor("sunum.PPTX").kind).toBe("slides");
    expect(viewerFor("sunum.odp").kind).toBe("slides");
    expect(viewerFor("metraj.xlsx").kind).toBe("sheet");
    expect(viewerFor("liste.csv").kind).toBe("sheet");
    expect(viewerFor("kat.dwg").kind).toBe("cad");
    expect(viewerFor("kat.dxf").kind).toBe("cad");
    expect(viewerFor("foto.jpeg").kind).toBe("image");
    expect(viewerFor("README.md").kind).toBe("markdown");
    expect(viewerFor("log.txt").kind).toBe("text");
    expect(viewerFor("şantiye.mp4").kind).toBe("video");
    expect(viewerFor("kayıt.mp3").kind).toBe("audio");
    expect(viewerFor("yazı.eml").kind).toBe("email");
    expect(viewerFor("model.rvt").kind).toBe("none");
    expect(viewerFor("adsız").kind).toBe("none");
    expect(viewerForExtension(".XLSX").kind).toBe("sheet");
  });

  it("lists the derivatives each viewer needs", () => {
    // Office files: text (and notes) without any converter; the PDF only with a converter.
    expect(viewerFor("a.docx")).toMatchObject({ previews: ["text"], onDemand: ["pdf"] });
    expect(viewerFor("a.doc")).toMatchObject({ previews: ["text"], onDemand: ["pdf"] });
    expect(viewerFor("a.pptx")).toMatchObject({ previews: ["text"], onDemand: ["pdf"] });
    expect(viewerFor("a.xlsx")).toMatchObject({ previews: ["sheet"], onDemand: ["pdf"] });
    expect(viewerFor("a.csv")).toMatchObject({ previews: ["sheet"], onDemand: [] });
    expect(viewerFor("a.dwg").previews).toEqual(["dxf"]);
    expect(viewerFor("a.pdf").previews).toEqual(["text"]);
    expect(viewerFor("a.png").previews).toEqual([]);
    expect(viewerFor("a.ifc").previews).toEqual([]);
    expect(viewerFor("a.rvt")).toMatchObject({ label: "Önizleme yok", previews: [] });
  });

  it("has no extension in two viewers", () => {
    const all = Object.values(VIEWER_EXTENSIONS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("builds the route that opens a version", () => {
    expect(viewerPath("p1", "a.pdf", "v1")).toBe("/projects/p1/view/v1");
    expect(viewerPath("p1", "a.ifc", "v1")).toBe("/projects/p1/viewer?v=v1");
    expect(viewerPath("p1", "a.docx", "v1")).toBe("/projects/p1/open/v1");
    expect(viewerPath("p1", "a.rvt", "v1")).toBe("/projects/p1/open/v1");
  });

  it("renders docx, odt and pptx in the browser; legacy binaries need a converter", () => {
    expect(["docx", "DOCM", ".dotx"].map(browserOffice)).toEqual(["docx", "docx", "docx"]);
    expect(["odt", "ott"].map(browserOffice)).toEqual(["odt", "odt"]);
    expect(["pptx", "pptm", "ppsx"].map(browserOffice)).toEqual(["pptx", "pptx", "pptx"]);
    expect(["doc", "rtf", "ppt", "pps", "odp", "xlsx", "pdf"].map(browserOffice)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe("office view decision", () => {
  const pdf = (status: PreviewStatus): PreviewDto => ({ kind: "pdf", status, error: null, hint: null, meta: {}, updatedAt: "" });
  const info = (
    viewer: "document" | "slides",
    extension: string,
    o: { pdf?: PreviewStatus; converter?: boolean } = {},
  ): Pick<VersionPreviewDto, "viewer" | "extension" | "previews" | "pdfConverter" | "canRequest"> => ({
    viewer,
    extension,
    previews: o.pdf ? [pdf(o.pdf)] : [],
    pdfConverter: !!o.converter,
    canRequest: !o.pdf || o.pdf === "failed" || o.pdf === "unavailable" ? ["pdf"] : [],
  });

  it("opens Word and ODF text in the browser, with or without a PDF", () => {
    expect(officeShow(info("document", "docx"))).toEqual({ show: "browser", renderer: "docx" });
    expect(officeShow(info("document", "docx", { pdf: "ready", converter: true }))).toEqual({ show: "browser", renderer: "docx" });
    expect(officeShow(info("document", "odt"))).toEqual({ show: "browser", renderer: "odt" });
  });

  it("prefers the converter's PDF for presentations, else the browser", () => {
    expect(officeShow(info("slides", "pptx", { pdf: "ready" }))).toEqual({ show: "pdf" });
    expect(officeShow(info("slides", "pptx", { pdf: "processing", converter: true }))).toEqual({ show: "browser", renderer: "pptx" });
    expect(officeShow(info("slides", "pptx"))).toEqual({ show: "browser", renderer: "pptx" });
  });

  it("legacy formats: PDF when there is one, wait while it is made, else 'converter needed'", () => {
    expect(officeShow(info("document", "doc", { pdf: "ready" }))).toEqual({ show: "pdf" });
    expect(officeShow(info("document", "doc", { pdf: "pending", converter: true }))).toEqual({ show: "wait" });
    expect(officeShow(info("document", "rtf", { converter: true }))).toEqual({ show: "wait" });
    expect(officeShow(info("slides", "ppt", { pdf: "unavailable", converter: true }))).toEqual({ show: "wait" });
    expect(officeShow(info("document", "doc"))).toEqual({ show: "convert" });
    expect(officeShow(info("slides", "odp", { pdf: "unavailable" }))).toEqual({ show: "convert" });
    expect(officeShow(info("document", "doc", { pdf: "failed", converter: true }))).toEqual({ show: "convert" });
  });

  it("offers the page-layout PDF only when it exists or a converter can make it", () => {
    expect(officePdfAction(info("document", "docx"))).toBeNull();
    expect(officePdfAction(info("document", "docx", { pdf: "unavailable" }))).toBeNull();
    expect(officePdfAction(info("document", "docx", { converter: true }))).toBe("request");
    expect(officePdfAction(info("document", "docx", { pdf: "failed", converter: true }))).toBe("request");
    expect(officePdfAction(info("document", "docx", { pdf: "processing", converter: true }))).toBe("busy");
    expect(officePdfAction(info("document", "docx", { pdf: "ready" }))).toBe("open");
  });
});
