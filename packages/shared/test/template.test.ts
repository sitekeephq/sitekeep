import { describe, expect, it } from "vitest";
import {
  checkProjectTemplate,
  countTemplate,
  expandProjectTemplate,
  resolveTemplateTokens,
  type ProjectTemplate,
} from "../src/index.js";

const t: ProjectTemplate = {
  name: "Deneme",
  slots: [{ key: "tas", label: "Tasarımcı", code: "PRT" }],
  dimensions: {
    Grup: [{ name: "000-Genel", insert: ["Konu"], stop: true }, { name: "002-İstasyonlar", insert: ["İstasyon"] }],
    Konu: ["BEP", "Toplantı"],
    İstasyon: ["S00", "S01"],
    Disiplin: ["Mimari", "Yapısal"],
    Tip: ["Model", "Çizim"],
  },
  folders: [{ name: "99-Tasarımcı", grants: [{ slot: "tas", level: "manage" }], skeleton: { order: ["Grup", "Disiplin", "Tip"] } }],
};

describe("project templates", () => {
  it("expands skeletons with insert/stop and marks leaves as on demand", () => {
    const { folders, errors } = expandProjectTemplate(t);
    expect(errors).toEqual([]);
    const [area] = folders;
    expect(area!.children.map((c) => c.name)).toEqual(["000-Genel", "002-İstasyonlar"]);
    const genel = area!.children[0]!;
    expect(genel.virtual).toBe(false);
    expect(genel.children.map((c) => [c.name, c.virtual])).toEqual([["BEP", true], ["Toplantı", true]]);
    const s01 = area!.children[1]!.children[1]!;
    expect(s01.name).toBe("S01");
    expect(s01.children[0]!.children.map((c) => [c.name, c.virtual])).toEqual([["Model", true], ["Çizim", true]]);
    // root + area + 2 groups + 2 stations + 4 disciplines = 10 real; 2 + 8 leaves on demand.
    expect(countTemplate(t, folders)).toMatchObject({ folders: 10, virtualFolders: 10, grants: 1 });
  });

  it("supports full generation, dimension overrides and onDemand by dimension", () => {
    const full = { ...t, folders: [{ name: "A", skeleton: { order: ["Disiplin", "Tip"], onDemand: "none" } }] };
    expect(countTemplate(full, expandProjectTemplate(full).folders)).toMatchObject({ folders: 8, virtualFolders: 0 });
    const byDim = { ...t, folders: [{ name: "A", skeleton: { order: ["Disiplin", "Tip"], onDemand: "Disiplin" } }] };
    expect(countTemplate(byDim, expandProjectTemplate(byDim).folders)).toMatchObject({ folders: 2, virtualFolders: 6 });
    const o = expandProjectTemplate(t, { İstasyon: ["S10"] });
    expect(o.folders[0]!.children[1]!.children.map((c) => c.name)).toEqual(["S10"]);
    expect(expandProjectTemplate(t, { Yok: ["x"] }).errors[0]).toContain("Yok");
  });

  it("checks references and resolves tokens", () => {
    const bad: ProjectTemplate = { ...t, folders: [{ name: "A", skeleton: { order: ["Eksik"] }, grants: [{ slot: "x", level: "view" }] }] };
    const errors = checkProjectTemplate(bad).join("\n");
    expect(errors).toContain('"Eksik"');
    expect(errors).toContain('"x" rolü');
    const ctx = { projectCode: "PKF", slotCodes: { tas: "PRT" }, slotNames: { tas: "Prota" } };
    expect(resolveTemplateTokens("{PROJE}-{slot:tas} {firma:tas}", ctx)).toBe("PKF-PRT Prota");
    expect(resolveTemplateTokens("{slot:yok}", ctx)).toBeNull();
  });
});
