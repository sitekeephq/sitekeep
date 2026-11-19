import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, runState, test } from "../support/project-features";
import { needsModules } from "../support/modules";

needsModules("planning");

test("imports a tiny CSV schedule through the empty schedule page", async ({ page }) => {
  const { project } = await runState();
  const fixture = path.resolve(__dirname, "../fixtures/tiny-schedule.csv");

  await page.goto(`/projects/${project.id}/schedule`);

  await expect(page.getByRole("combobox", { name: "İş programı" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "İçe Aktar", exact: true })).toBeVisible();
  await expect(page.getByText("Bu projede henüz iş programı yok.")).toBeVisible();

  await page.getByRole("button", { name: "İçe Aktar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "İş Programı İçe Aktar" });
  await dialog.locator('input[type="file"]').setInputFiles(fixture);

  await expect(dialog.getByText("2 faaliyet")).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "Site setup", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "İçe Aktar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "İş programı" })).toContainText("tiny-schedule");
  await expect(page.getByText("2 faaliyet", { exact: false })).toBeVisible();
  await expect(page.getByText("Site setup", { exact: true })).toBeVisible();
  await expect(page.getByText("Foundation check", { exact: true })).toBeVisible();
});

test("assigns a chainage in the location wizard and draws it in the time–distance view", async ({ page }) => {
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule?v=td`);
  await expect(page.getByRole("button", { name: "Zaman–Mesafe" })).toBeVisible();
  await expect(page.getByText("Çizilecek faaliyet yok.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: /^Konum Ata/ }).click();
  const dialog = page.getByRole("dialog", { name: "Konum Atama Sihirbazı" });
  await expect(dialog.getByRole("button", { name: "Boş Km Şablonu" })).toBeVisible();
  const row = dialog.getByRole("row").filter({ hasText: "Site setup" });
  await row.getByRole("textbox", { name: "Başlangıç Km" }).fill("1+000");
  await row.getByRole("textbox", { name: "Bitiş Km" }).fill("1+500");
  await dialog.getByRole("button", { name: "Seçilenleri Uygula" }).click();
  await expect(dialog.getByText("1 faaliyetin konumu kaydedildi.")).toBeVisible();
  await expect(dialog.getByRole("row").filter({ hasText: "Site setup" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Kapat", exact: true }).last().click();

  const chart = page.getByTestId("time-distance");
  await expect(chart.locator('.td-item[aria-label*="Site setup"]')).toHaveCount(1);
  // hovering shows the details box (no SVG <title> tooltip)
  await chart.locator('.td-item[aria-label*="Site setup"]').hover();
  await expect(chart.getByTestId("td-tip")).toContainText("Site setup");
  await expect(page.getByText("1 / 2 faaliyetin konumu var")).toBeVisible();

  // Clicking the activity opens its drawer: the chainage section shows the range and sets the drawing style.
  await chart.locator('.td-item[aria-label*="Site setup"]').click();
  const km = page.getByTestId("activity-chainage");
  await expect(km).toContainText("1+000");
  await expect(km).toContainText("1+500");
  await km.getByRole("button", { name: "Düzenle" }).click();
  await km.getByLabel("Çizim").selectOption("line");
  await km.getByRole("button", { name: "Kaydet" }).click();
  await expect(km).toContainText("Eğik çizgi");
  await expect(chart.locator('line.td-item[aria-label*="Site setup"]')).toHaveCount(1);
  await page.locator("aside.drawer").getByRole("button", { name: "Kapat" }).click();

  // Wizard, Assigned tab: remove the chainage; the activity leaves the diagram.
  await page.getByRole("button", { name: /^Konum Ata/ }).click();
  const wizard = page.getByRole("dialog", { name: "Konum Atama Sihirbazı" });
  await wizard.getByRole("tab", { name: "Atanmış" }).click();
  await wizard.getByRole("checkbox", { name: "E2E-100" }).check();
  await wizard.getByRole("button", { name: "Kilometreyi Kaldır" }).click();
  await page.getByRole("dialog", { name: "Kilometreyi Kaldır" }).getByRole("button", { name: "Kilometreyi Kaldır" }).click();
  await expect(wizard.getByText("1 faaliyetin kilometresi kaldırıldı.")).toBeVisible();
  await wizard.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(chart.locator('.td-item[aria-label*="Site setup"]')).toHaveCount(0);
});

test("builds a programme from scratch: two activities, a link, calculation and bars", async ({ page, allowApiFailure }) => {
  allowApiFailure(409, /\/schedules\/[^/]+\/dependencies$/); // the duplicate link below is refused
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "Yeni İş Programı" }).click();
  const create = page.getByRole("dialog", { name: "Yeni İş Programı" });
  await create.getByLabel("Program Adı").fill("Yeni Hat Programı");
  await create.getByLabel("Proje Başlangıcı").fill("2027-01-04");
  await create.getByRole("button", { name: "Oluştur", exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "İş programı" })).toContainText("Yeni Hat Programı");
  await expect(page.getByText("Henüz faaliyet yok.", { exact: false })).toBeVisible();

  const addActivity = async (code: string, name: string, days: string) => {
    await page.getByRole("button", { name: "Faaliyet Ekle", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Faaliyet Ekle" });
    await add.getByLabel("Faaliyet Kodu").fill(code);
    await add.getByLabel("Faaliyet Adı").fill(name);
    await add.getByLabel("Başlangıç", { exact: true }).fill("2027-01-04");
    await add.getByLabel("Süre (iş günü)").fill(days);
    await add.getByRole("button", { name: "Ekle", exact: true }).click();
    await expect(add).toHaveCount(0);
  };
  await addActivity("K10", "Kazı", "5");
  await addActivity("K20", "Beton", "3");
  await expect(page.locator(".g-bar")).toHaveCount(2);
  await expect(page.getByText("Hesaplanması Gerekiyor")).toBeVisible();

  // The drawer is open on the new activity: link it after K10.
  const drawer = page.getByRole("complementary", { name: "Faaliyet" });
  await expect(drawer.getByRole("heading", { name: "Beton" })).toBeVisible();
  await drawer.getByRole("button", { name: "+ Öncül Ekle" }).click();
  await drawer.getByLabel("Faaliyet", { exact: true }).selectOption({ label: "K10 · Kazı" });
  await drawer.getByLabel("Bağ Türü").selectOption("FS");
  await drawer.getByRole("button", { name: "Bağla", exact: true }).click();
  await expect(drawer.getByText("K10", { exact: true })).toBeVisible();

  // Rejected: K10 and K20 are already linked.
  await drawer.getByRole("button", { name: "+ Ardıl Ekle" }).click();
  await drawer.getByLabel("Faaliyet", { exact: true }).selectOption({ label: "K10 · Kazı" });
  await drawer.getByRole("button", { name: "Bağla", exact: true }).click();
  await expect(drawer.getByText("Bu iki faaliyet arasında zaten bağ var.")).toBeVisible();
  await drawer.getByRole("button", { name: "Vazgeç" }).click();

  await page.getByRole("button", { name: "Programı Hesapla" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Program hesaplandı: bitiş 12.01.2027" })).toBeVisible();
  await expect(page.getByText("Hesaplanması Gerekiyor")).toHaveCount(0);
  // Mon–Sat calendar: K10 4–8 Jan, K20 Sat 9 – Tue 12 Jan, both critical.
  await expect(drawer.getByText("09.01.2027 – 12.01.2027")).toBeVisible();
  await expect(page.locator(".g-bar.critical")).toHaveCount(2);
  await expect(page.locator(".g-item title").filter({ hasText: "Beton" })).toHaveCount(1);
});

test("translates an activity name, shows it in the Gantt and exports it with the same code", async ({ page }) => {
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "Yeni İş Programı" }).click();
  const create = page.getByRole("dialog", { name: "Yeni İş Programı" });
  await create.getByLabel("Program Adı").fill("İki Dilli Program");
  await create.getByLabel("Proje Başlangıcı").fill("2027-02-01");
  await create.getByRole("button", { name: "Oluştur", exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "İş programı" })).toContainText("İki Dilli Program");

  await page.getByRole("button", { name: "Faaliyet Ekle", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Faaliyet Ekle" });
  await add.getByLabel("Faaliyet Kodu").fill("TR10");
  await add.getByLabel("Faaliyet Adı").fill("Kazi Islerinin Yapilmasi BR-04");
  await add.getByLabel("Başlangıç", { exact: true }).fill("2027-02-01");
  await add.getByLabel("Süre (iş günü)").fill("5");
  await add.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(add).toHaveCount(0);
  await page.getByRole("complementary", { name: "Faaliyet" }).getByRole("button", { name: "Kapat" }).click();
  // No translation yet: the name selector is hidden.
  await expect(page.getByRole("combobox", { name: "Faaliyet adları" })).toHaveCount(0);

  await page.getByRole("button", { name: "Diğer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Çeviriler" }).click();
  const dialog = page.getByRole("dialog", { name: "Faaliyet Adı Çevirileri" });
  await expect(dialog.getByRole("combobox", { name: "Dil" })).toHaveValue("en");
  await expect(dialog.getByText("0 / 1 çevrildi")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Şablonu İndir" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tablo Yükle" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Yapay Zekâ ile Çevir" })).toBeVisible();
  const row = dialog.getByRole("row").filter({ hasText: "TR10" });
  await expect(row.getByRole("cell", { name: "Kazi Islerinin Yapilmasi BR-04" })).toBeVisible();
  await row.getByRole("textbox", { name: "Çeviri (İngilizce)" }).fill("Excavation Works BR-04");
  await dialog.getByRole("button", { name: "Kaydet (1)" }).click();
  await expect(dialog.getByText("1 çeviri kaydedildi, 0 çeviri silindi.")).toBeVisible();
  await expect(dialog.getByText("1 / 1 çevrildi")).toBeVisible();
  await dialog.getByLabel("Eksik").check();
  await expect(dialog.getByText("Eksik çeviri yok.")).toBeVisible();
  await dialog.getByRole("button", { name: "Kapat", exact: true }).last().click();
  await expect(dialog).toHaveCount(0);

  // Gantt: swap the names client-side.
  const names = page.getByRole("combobox", { name: "Faaliyet adları" });
  await names.selectOption({ label: "Faaliyet Adları: İngilizce" });
  await expect(page.locator(".g-item title").filter({ hasText: "Excavation Works BR-04" })).toHaveCount(1);
  await names.selectOption({ label: "Faaliyet Adları: Orijinal" });
  await expect(page.locator(".g-item title").filter({ hasText: "Kazi Islerinin Yapilmasi BR-04" })).toHaveCount(1);

  // Export: XER with the English names, the code unchanged.
  await page.getByRole("button", { name: "Dışa Aktar", exact: true }).click();
  const exp = page.getByRole("dialog", { name: "Dışa Aktar" });
  await exp.getByRole("combobox", { name: "Faaliyet Adları" }).selectOption({ label: "İngilizce (1 Çeviri)" });
  await expect(exp.getByText("Çevirisi olmayan faaliyetler orijinal adıyla yazılır; kodlar değişmez.")).toBeVisible();
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: "İndir", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-en\.xer$/);
  const text = await readFile(await file.path(), "utf8");
  expect(text).toContain("Excavation Works BR-04");
  expect(text).toContain("\tTR10\t");
  expect(text).not.toContain("Kazi Islerinin Yapilmasi");
});

test("records a duration basis, runs the schedule checks and re-dates the programme to the Commencement Date", async ({ page }) => {
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "Yeni İş Programı" }).click();
  const create = page.getByRole("dialog", { name: "Yeni İş Programı" });
  await create.getByLabel("Program Adı").fill("İhale Programı");
  await create.getByLabel("Proje Başlangıcı").fill("2027-01-04");
  await create.getByRole("button", { name: "Oluştur", exact: true }).click();
  await expect(create).toHaveCount(0);

  await page.getByRole("button", { name: "Faaliyet Ekle", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Faaliyet Ekle" });
  await add.getByLabel("Faaliyet Kodu").fill("E10");
  await add.getByLabel("Faaliyet Adı").fill("Kazı Km 12");
  await add.getByLabel("Başlangıç", { exact: true }).fill("2027-01-04");
  await add.getByLabel("Süre (iş günü)").fill("5");
  await add.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(add).toHaveCount(0);

  // Duration basis in the drawer: 500 m3 / (100 m3 per crew-day × 1 crew) = 5 working days.
  const drawer = page.getByRole("complementary", { name: "Faaliyet" });
  await expect(drawer.getByText("Süre dayanağı girilmemiş.")).toBeVisible();
  await drawer.getByRole("button", { name: "Dayanağı Düzenle" }).click();
  await drawer.getByLabel("Miktar").fill("500");
  await drawer.getByLabel("Birim").fill("m3");
  await drawer.getByLabel("Ekip-Gün Verimi").fill("100");
  await drawer.getByLabel("Ekip Sayısı").fill("1");
  await drawer.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(drawer.getByText("500 m3 ÷ (100 m3/gün × 1 ekip) = 5 gün")).toBeVisible();
  await expect(drawer.getByText("Önerilen süre: 5 iş günü (planlanan 5).")).toBeVisible();
  await drawer.getByRole("button", { name: "Kapat" }).click();

  // Contract dates: Day 0 and the Time for Completion.
  await page.getByRole("button", { name: "CPM Analizi", exact: true }).click();
  const cpm = page.getByRole("dialog", { name: "CPM Analizi" });
  await cpm.getByRole("button", { name: "Takvim ve Ayarlar" }).click();
  await cpm.getByLabel("0. Gün (İşe Başlama Tarihi)").fill("2027-01-04");
  await cpm.getByLabel("Tamamlanma Süresi (Takvim Günü)").fill("3");
  await cpm.getByRole("button", { name: "Kaydet", exact: true }).click();
  await cpm.getByRole("button", { name: "Kapat", exact: true }).last().click();

  // Schedule checks: excavation without design consent, completion after Day 0 + 3 days.
  await page.getByRole("button", { name: "Diğer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Program Kontrolü" }).click();
  const checks = page.getByRole("dialog", { name: "Program Kontrolü" });
  await expect(checks.getByRole("button", { name: /Tasarım Onayından Önce İmalat/ })).toBeVisible();
  await expect(checks.getByRole("button", { name: /Tamamlanma Süresi/ })).toBeVisible();
  await expect(checks.getByRole("button", { name: /Süre Dayanağı Eksik/ })).toHaveCount(0);
  await checks.getByLabel("Önem").selectOption("info");
  await expect(checks.getByRole("button", { name: /Tasarım Onayından Önce İmalat/ })).toHaveCount(0);
  await checks.getByLabel("Önem").selectOption("all");
  await checks.getByRole("button", { name: /Tasarım Onayından Önce İmalat/ }).click();
  await expect(checks.getByText("E10 Kazı Km 12: öncülleri arasında tasarım faaliyeti", { exact: false })).toBeVisible();
  const download = page.waitForEvent("download");
  await checks.getByRole("button", { name: "Excel'e Aktar" }).click();
  expect((await download).suggestedFilename()).toMatch(/-kontrol\.xlsx$/);
  await checks.getByRole("button", { name: "Göster", exact: true }).first().click();
  await expect(checks).toHaveCount(0);
  await expect(drawer.getByRole("heading", { name: "Kazı Km 12" })).toBeVisible();
  await drawer.getByRole("button", { name: "Kapat" }).click();

  // Commencement Date after award: a new version, every date moved by 56 days.
  await page.getByRole("button", { name: "Diğer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Başlangıç Tarihine Kaydır" }).click();
  const shift = page.getByRole("dialog", { name: "Başlangıç Tarihine Kaydır" });
  await expect(shift.getByText("Şu anki 0. gün: 04.01.2027.")).toBeVisible();
  await shift.getByLabel("İşe Başlama Tarihi").fill("2027-03-01");
  await expect(shift.getByText("Yeni bir versiyonda tüm tarihler +56 takvim günü kayar", { exact: false })).toBeVisible();
  await shift.getByRole("button", { name: "Kaydırılmış Versiyon Oluştur" }).click();
  await expect(shift).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "İş programı" })).toContainText("İhale Programı · v2");
  // The summary line under the toolbar (the Gantt bar's SVG title carries the same dates).
  await expect(page.locator("span.muted.small").filter({ hasText: "01.03.2027 –" })).toBeVisible();
});

test("codes an activity, builds the Schedule of Payments from the code type and reads cash flow and traceability", async ({ page }) => {
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "Yeni İş Programı" }).click();
  const create = page.getByRole("dialog", { name: "Yeni İş Programı" });
  await create.getByLabel("Program Adı").fill("Ödeme Programı");
  await create.getByLabel("Proje Başlangıcı").fill("2027-03-01");
  await create.getByRole("button", { name: "Oluştur", exact: true }).click();
  await expect(create).toHaveCount(0);
  for (const [code, name] of [["P10", "Tasarım"], ["P20", "Keşif"]] as const) {
    await page.getByRole("button", { name: "Faaliyet Ekle", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Faaliyet Ekle" });
    await add.getByLabel("Faaliyet Kodu").fill(code);
    await add.getByLabel("Faaliyet Adı").fill(name);
    await add.getByLabel("Başlangıç", { exact: true }).fill("2027-03-01");
    await add.getByLabel("Süre (iş günü)").fill("5");
    await add.getByRole("button", { name: "Ekle", exact: true }).click();
    await expect(add).toHaveCount(0);
  }
  await page.getByRole("complementary", { name: "Faaliyet" }).getByRole("button", { name: "Kapat" }).click();

  // Activity codes: empty, then a SOP code type with one value.
  await page.getByRole("button", { name: "Diğer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Faaliyet Kodları" }).click();
  const codes = page.getByRole("dialog", { name: "Faaliyet Kodları" });
  await expect(codes.getByText("Bu programda faaliyet kodu yok.", { exact: false })).toBeVisible();
  await codes.getByRole("button", { name: "+ Kod Türü" }).click();
  const ask = page.getByRole("dialog", { name: "+ Kod Türü" });
  await ask.getByRole("textbox").fill("SOP");
  await ask.getByRole("textbox").press("Enter");
  await expect(codes.getByRole("combobox", { name: "Kod Türü" })).toContainText("SOP");
  await codes.getByRole("button", { name: "+ Değer" }).click();
  await codes.getByLabel("Değer", { exact: true }).fill("1.1");
  await codes.getByLabel("Açıklama", { exact: true }).fill("Tasarım teslimi");
  await codes.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(codes.getByRole("cell", { name: "Tasarım teslimi" })).toBeVisible();
  await codes.getByRole("button", { name: "Kapat", exact: true }).last().click();

  // Assign the value to P10 in the drawer.
  await page.locator(".gantt-row").filter({ hasText: "P10" }).click();
  const drawer = page.getByRole("complementary", { name: "Faaliyet" });
  await drawer.getByRole("button", { name: "Kodları Düzenle" }).click();
  await drawer.getByLabel("SOP", { exact: true }).selectOption({ label: "1.1 · Tasarım teslimi" });
  await drawer.getByRole("button", { name: "Kodları Kaydet" }).click();
  await expect(drawer.getByText("1.1 · Tasarım teslimi")).toBeVisible();
  await drawer.getByRole("button", { name: "Kapat" }).click();

  // Gantt grouped by the code: a heading row for 1.1.
  await page.getByRole("combobox", { name: "Koda Göre Grupla" }).selectOption({ label: "SOP Koduna Göre" });
  await expect(page.locator(".gantt-row.summary").filter({ hasText: "1.1" })).toHaveCount(1);
  await page.getByRole("combobox", { name: "Koda Göre Grupla" }).selectOption({ label: "İş Kırılımına Göre" });

  // Schedule of Payments from the SOP code type.
  await page.getByRole("button", { name: "Diğer", exact: true }).click();
  await page.getByRole("menuitem", { name: "Ödeme Çizelgesi" }).click();
  const pay = page.getByRole("dialog", { name: "Ödeme Çizelgesi" });
  await expect(pay.getByText("Henüz ödeme kalemi yok.", { exact: false })).toBeVisible();
  await expect(pay.getByRole("button", { name: "Şablonu İndir" })).toBeVisible();
  await pay.getByRole("button", { name: "Kod Türünden Oluştur" }).click();
  await expect(pay.getByText("1 yeni, 0 güncellenen kalem; 1 faaliyet eşlendi.")).toBeVisible();
  const row = pay.getByRole("row").filter({ hasText: "Tasarım teslimi" });
  await expect(row.getByText("Planlandı")).toBeVisible();

  // A wrong amount is rejected and stays on screen; a valid one saves.
  await row.getByRole("button", { name: "Düzenle" }).click();
  await pay.getByLabel("Tutar", { exact: true }).fill("abc");
  await pay.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(pay.getByText("Tutarı sıfır ya da daha büyük bir sayı olarak girin.")).toBeVisible();
  await pay.getByLabel("Tutar", { exact: true }).fill("250000");
  await pay.getByLabel("Para Birimi", { exact: true }).fill("USD");
  await pay.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(pay.getByText("Kaydedildi.")).toBeVisible();

  await pay.getByRole("button", { name: "Nakit Akışı", exact: true }).click();
  await expect(pay.getByText("2027-03", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await pay.getByRole("button", { name: "Nakit Akışını Excel'e Aktar" }).click();
  expect((await download).suggestedFilename()).toMatch(/cashflow-USD\.xlsx$/);

  await pay.getByRole("button", { name: "İzlenebilirlik", exact: true }).click();
  await expect(pay.getByText("1 ödeme kaleminden 1 tanesinin faaliyeti var; 2 faaliyetten 1 tanesi bir ödeme kalemine bağlı.")).toBeVisible();
  await expect(pay.getByRole("button", { name: "P20" })).toBeVisible();

  // Delete the item: the list is empty again.
  await pay.getByRole("button", { name: "Ödeme Kalemleri", exact: true }).click();
  await pay.getByRole("row").filter({ hasText: "Tasarım teslimi" }).getByRole("button", { name: "Sil" }).click();
  await page.getByRole("dialog", { name: "Ödeme Kalemini Sil" }).getByRole("button", { name: "Sil" }).click();
  await expect(pay.getByText("Henüz ödeme kalemi yok.", { exact: false })).toBeVisible();
});

test("shows the KPI dashboard, records a delay notification and issues a monthly report", async ({ page, allowApiFailure }) => {
  allowApiFailure(400, /\/schedules\/[^/]+\/delays$/); // the unknown activity code below is refused
  const { project } = await runState();

  await page.goto(`/projects/${project.id}/schedule`);
  await page.getByRole("button", { name: "Yeni İş Programı" }).click();
  const create = page.getByRole("dialog", { name: "Yeni İş Programı" });
  await create.getByLabel("Program Adı").fill("KPI Programı");
  await create.getByLabel("Proje Başlangıcı").fill("2027-01-04");
  await create.getByRole("button", { name: "Oluştur", exact: true }).click();
  await expect(create).toHaveCount(0);
  await page.getByRole("button", { name: "Faaliyet Ekle", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Faaliyet Ekle" });
  await add.getByLabel("Faaliyet Kodu").fill("K10");
  await add.getByLabel("Faaliyet Adı").fill("Ray döşeme");
  await add.getByLabel("Başlangıç", { exact: true }).fill("2027-01-04");
  await add.getByLabel("Süre (iş günü)").fill("5");
  await add.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(add).toHaveCount(0);

  // KPI view: tiles and the empty lists.
  await page.getByRole("button", { name: "KPI", exact: true }).click();
  await expect(page).toHaveURL(/v=kpi/);
  const view = page.getByTestId("kpi-view");
  await expect(view.getByRole("heading", { name: "KPI Panosu" })).toBeVisible();
  await expect(view.getByTestId("kpi-spi")).toContainText("P1 SPI");
  await expect(view.getByText("Gecikme bildirimi yok.")).toBeVisible();
  await expect(view.getByText("Sözleşme kilometre taşı yok", { exact: false })).toBeVisible();

  // Delay notification (P3): an unknown activity code is rejected, then saved.
  await view.getByRole("button", { name: "Bildirim Ekle" }).click();
  const delay = page.getByRole("dialog", { name: "Yeni Gecikme Bildirimi" });
  await delay.getByLabel("Bildirim Tarihi").fill("2027-01-04");
  await expect(delay.getByRole("button", { name: "Kaydet", exact: true })).toBeDisabled();
  await delay.getByLabel("Açıklama").fill("Sağanak yağış");
  await delay.getByLabel("Faaliyet Kodları (Virgülle)").fill("YOK1");
  await delay.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(delay.getByText("Bu faaliyet kodları programda yok: YOK1.")).toBeVisible();
  await delay.getByLabel("Faaliyet Kodları (Virgülle)").fill("K10");
  await delay.getByLabel("Neden").selectOption("weather");
  await delay.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(delay).toHaveCount(0);
  await expect(view.getByRole("cell", { name: /Sağanak yağış/ })).toBeVisible();
  await expect(view.getByText("Bekleniyor", { exact: true })).toBeVisible();

  // Monthly report: create for the data date's month, edit the narrative, export, issue, delete.
  await view.getByRole("button", { name: "Aylık Rapor" }).click();
  const dlg = page.getByRole("dialog", { name: "Aylık Rapor" });
  await expect(dlg.getByText("Bu program için henüz aylık rapor yok.")).toBeVisible();
  await dlg.getByRole("button", { name: "Rapor Oluştur" }).click();
  await expect(dlg.getByLabel("Rapor Ayı")).toHaveValue("2027-01");
  await dlg.getByRole("button", { name: "Rapor Oluştur" }).click();
  await expect(dlg.getByRole("heading", { name: "Aylık Rapor – 2027-01" })).toBeVisible();
  await expect(dlg.getByText("Karşılaştırılacak versiyon yok.")).toBeVisible();
  await expect(dlg.getByLabel("Anlatı")).toHaveValue(/KPI Programı programı, versiyon 1/);
  await dlg.getByLabel("Anlatı").fill("Program temel plana göre yolunda.");
  await dlg.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(dlg.getByText("Kaydedildi.")).toBeVisible();
  const pdf = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "PDF", exact: true }).click();
  expect((await pdf).suggestedFilename()).toMatch(/2027-01-aylik-rapor\.pdf$/);
  await dlg.getByRole("button", { name: "Yayımla" }).click();
  await expect(dlg.getByRole("button", { name: "Taslağa Al" })).toBeVisible();
  await expect(dlg.getByLabel("Anlatı")).toHaveAttribute("readonly", "");
  await dlg.getByRole("button", { name: "Listeye Dön" }).click();
  await expect(dlg.getByRole("cell", { name: "2027-01" })).toBeVisible();
  await dlg.getByRole("button", { name: "Aç", exact: true }).click();
  await dlg.getByRole("button", { name: "Sil", exact: true }).click();
  await page.getByRole("dialog", { name: "Aylık Raporu Sil" }).getByRole("button", { name: "Sil" }).click();
  await expect(dlg.getByText("Bu program için henüz aylık rapor yok.")).toBeVisible();
});
