import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isTitleCaseTr, type FileDto, type FolderDto } from "@sitekeep/shared";
import { DocsCards } from "../../src/features/documents/components/DocsCards";
import { MoreMenu } from "../../src/shared/ui/MoreMenu";
import { docsMoreItems, fileDay, type DocsMoreOptions } from "../../src/features/documents/docs-phone";

const base: DocsMoreOptions = {
  spec: false,
  report: false,
  searching: false,
  canManage: false,
  filtersOn: false,
  inFolder: false,
  selecting: false,
};

describe("Dokümanlar phone toolbar: Diğer menu (docs-phone.ts)", () => {
  it("gives a reader only Seç, Filtre and the search scope; no folder-admin items", () => {
    expect(docsMoreItems(base)).toEqual([
      { key: "select", label: "Seç", checked: false },
      { key: "filter", label: "Filtre", checked: false },
      { key: "inFolder", label: "Yalnız Bu Klasörde Ara", checked: false },
    ]);
  });

  it("adds Rapor and Şartname with their modules, and folder-admin items only with manage rights", () => {
    const keys = (o: Partial<DocsMoreOptions>) => docsMoreItems({ ...base, ...o }).map((i) => i.key);
    expect(keys({ report: true, spec: true })).toEqual(["select", "filter", "inFolder", "report", "spec"]);
    expect(keys({ canManage: true })).toEqual(["select", "filter", "inFolder", "newFolder", "permissions", "settings"]);
    const all = docsMoreItems({ ...base, report: true, spec: true, canManage: true });
    expect(all.map((i) => i.label)).toEqual([
      "Seç",
      "Filtre",
      "Yalnız Bu Klasörde Ara",
      "Rapor",
      "Şartnameden Teknik Onay Listesi",
      "Yeni Klasör",
      "Yetkiler",
      "Klasör Ayarları",
    ]);
    expect(all.filter((i) => !isTitleCaseTr(i.label))).toEqual([]);
  });

  it("hides Filtre during a search and shows the on/off state of the toggles", () => {
    const items = docsMoreItems({ ...base, searching: true, selecting: true, inFolder: true });
    expect(items.map((i) => i.key)).not.toContain("filter");
    expect(items.find((i) => i.key === "select")?.checked).toBe(true);
    expect(items.find((i) => i.key === "inFolder")?.checked).toBe(true);
    expect(docsMoreItems({ ...base, filtersOn: true }).find((i) => i.key === "filter")?.checked).toBe(true);
  });

  it("on desktop drops Seç, puts folder-admin items first and adds Autodesk", () => {
    const keys = docsMoreItems({ ...base, desktop: true, autodesk: true, canManage: true, report: true }).map((i) => i.key);
    expect(keys).toEqual(["newFolder", "permissions", "settings", "filter", "inFolder", "autodesk", "report"]);
  });

  it("shows the local day of an upload time", () => {
    expect(fileDay("2026-10-01T12:00:00.000Z")).toBe("01.10.2026");
  });
});

describe("MoreMenu component", () => {
  const items = [
    { key: "select", label: "Seç", checked: true },
    { key: "settings", label: "Klasör Ayarları" },
  ];
  const render = (props: Partial<Parameters<typeof MoreMenu>[0]> = {}) =>
    renderToStaticMarkup(createElement(MoreMenu, { items, onSelect: () => undefined, ...props }));

  it("is a closed ⋯ Diğer button until tapped", () => {
    const html = render();
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(html).toContain("⋯</span> Diğer");
    expect(html).not.toContain('role="menu"');
  });

  it("lists the items when open; toggles carry a check mark", () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain('class="more-menu-list" role="menu" aria-label="Diğer"');
    expect(html).toContain(
      'role="menuitemcheckbox" aria-checked="true"><span class="more-menu-check" aria-hidden="true">✓</span><span class="more-menu-label">Seç</span>',
    );
    expect(html).toContain(
      'role="menuitem"><span class="more-menu-check" aria-hidden="true"></span><span class="more-menu-label">Klasör Ayarları</span>',
    );
  });

  it("shows disabled items with their note and does not make them clickable", () => {
    const html = render({ defaultOpen: true, items: [{ key: "autodesk", label: "Autodesk Dokümanları", disabled: true, note: "Çevrimdışı" }] });
    expect(html).toContain('disabled="" title="Çevrimdışı"');
    expect(html).toContain('<span class="more-menu-note">Çevrimdışı</span>');
  });

  it("renders nothing without items", () => {
    expect(render({ items: [] })).toBe("");
  });
});

describe("DocsCards component (Dokümanlar on phones)", () => {
  const folder = { id: "fo1", projectId: "p1", parentId: "root", name: "01 Mimari", state: "shared", stateLabel: null, namingStandardId: null } as FolderDto;
  const file = {
    id: "f1",
    folderId: "fo1",
    name: "PRJ-ZZ-XX-DR-A-0001 Zemin Kat Planı.pdf",
    extension: "pdf",
    currentVersion: 3,
    attributes: {},
    createdAt: "2026-09-01T12:00:00.000Z",
    createdBy: "u1",
    latest: { id: "v3", uploadedAt: "2026-10-01T12:00:00.000Z", derivativeStatus: "none" },
  } as unknown as FileDto;
  const render = (props: Partial<Parameters<typeof DocsCards>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(DocsCards, {
        files: [file],
        folders: [folder],
        selecting: false,
        checked: new Set<string>(),
        iconFor: (ext: string) => (ext === "pdf" ? "📕" : "📄"),
        onOpenFolder: () => undefined,
        onOpenFile: () => undefined,
        onToggle: () => undefined,
        ...props,
      }),
    );

  it("shows folders as rows and files as cards with icon, name, version, day and badges", () => {
    const html = render({ selectedId: "f1", badges: () => createElement("span", { className: "badge ok" }, "Onaylandı") });
    expect(html).toContain('<ul class="doc-cards" aria-label="Klasör içeriği">');
    // data-tour-folder: the product tour points at the folder by name.
    expect(html).toContain('<li class="doc-folder"><button type="button" class="doc-folder-main" data-tour-folder="01 Mimari"><span aria-hidden="true">📁</span><span class="doc-card-name">01 Mimari</span>');
    expect(html).toContain('<span class="badge info">Paylaşılan</span>');
    expect(html).toContain('<li class="doc-card selected">');
    expect(html).toContain('<span class="doc-card-icon" aria-hidden="true">📕</span>');
    expect(html).toContain('<span class="doc-card-name">PRJ-ZZ-XX-DR-A-0001 Zemin Kat Planı.pdf</span>');
    expect(html).toContain("V3 · 01.10.2026");
    expect(html).toContain('<span class="doc-card-badges"><span class="badge ok">Onaylandı</span></span>');
    expect(html).not.toContain('type="checkbox"');
  });

  it("shows checkboxes only in Seç mode, ticked rows marked", () => {
    const html = render({ selecting: true, checked: new Set(["file:f1"]) });
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="PRJ-ZZ-XX-DR-A-0001 Zemin Kat Planı.pdf seç" checked=""');
    expect(html).toContain('<li class="doc-card checked">');
  });

  it("marks not-yet-created template folders, search hits show their folder, empty folders their text", () => {
    const virt = render({ files: [], folders: [], virtualFolders: [{ name: "02 Statik", state: null, stateLabel: null, descendantCount: 0 }] });
    expect(virt).toContain('<li class="doc-folder virtual"><button type="button" class="doc-folder-main" disabled="">');
    expect(virt).toContain("ilk dosyada oluşur");
    const hit = render({ folders: [], files: [{ ...file, folderPath: "Proje / 01 Mimari", snippet: "zemin kat" }] });
    expect(hit).toContain("V3 · 01.10.2026 · Proje / 01 Mimari");
    expect(hit).toContain('<span class="muted">İçerikte: </span>zemin kat');
    expect(render({ files: [], folders: [], emptyText: "Bu klasör boş." })).toContain("Bu klasör boş.");
    expect(render({ files: [], folders: [], emptyText: null })).toBe("");
  });
});
