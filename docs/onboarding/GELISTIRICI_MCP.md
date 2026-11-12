# Geliştirici MCP'si: Claude Code ve Claude Desktop ile SiteKeep

Tarih: 11.10.2026 · Dal: `feat/dev-mcp`

Ekran kartlı sunucu gelene kadar yerel model yavaş. Bu yüzden Claude Code veya Claude Desktop, kullanıcının kendi
aboneliğiyle, yerel SiteKeep'e MCP ile bağlanır. Claude hem geliştirici/test eden hem de raporları, akışları ve şablonları
taslaklayan "yapay zekâ" olur. Claude Desktop ile API anahtarı gerekmez; abonelik yeter.

Üç parça var:

1. **Geliştirici araçları** (`cde_dev_*`): sağlık kontrolü, örnek veri, test projesi, örnek dosya, senaryolar, yapay zekâ
   değerlendirmesi, tarih kaydırma. Yalnız geliştirme sunucusunda açılır.
2. **Yapay zekâ olarak Claude** (`cde_report_save`, `cde_form_template_save`, `cde_form_flow_save`, `cde_work_draft`,
   `cde_workflow_template_save`, `cde_ai_schemas`): uygulamanın kendi yapay zekâsının taslakladığı şeyleri kaydeder. Üretimde
   de çalışır (Claude, DeepSeek… MCP ile bağlanan müşteriler için).
3. **"Yapay Zekâya Gönder" kuyruğu** (`cde_ai_tasks_list`, `cde_ai_task_claim`, `cde_ai_task_complete`, `cde_ai_task_fail`):
   uygulamadaki yapay zekâ düğmeleri işi bağlı bir istemciye bırakır.

## 1. Sunucuyu geliştirici araçlarıyla başlatın

`apps/server/.env.development` dosyasına şu satırı ekleyin (dosya git'e girmez):

```
CDE_DEV_TOOLS=1
```

- `NODE_ENV=production` iken bu ayar yok sayılır. Üretim kurulumlarında geliştirici araçları hiç kaydedilmez.
- Sunucuyu yeniden başlatın: `npm run dev -w @sitekeep/server` (port 8787).
- İsteğe bağlı: `CDE_WEB_URL=http://localhost:5173`. Araç cevaplarındaki bağlantılar bu adresle başlar (varsayılan da budur).

## 2. Yazma yetkili erişim anahtarı

1. Yönetim → Yapay Zekâ → **Kendi Yapay Zekânı Bağla** kartında "Okuma + Yazma Erişim Anahtarlarına İzin Ver" kutusunu işaretleyin.
2. Hesabım → **API Erişim Anahtarları** → Yeni Erişim Anahtarı. Kapsam: **Okuma + Yazma**. Ad: ör. "Claude Code (geliştirme)".
3. Anahtar bir kez gösterilir. Kopyalayın; repoya veya sohbete yapıştırmayın.

Geliştirici araçları yalnız **sistem yöneticisinin** yazma anahtarıyla çalışır. Diğer araçlar anahtar sahibinin kendi
yetkisiyle çalışır.

## 3. Claude Code

Repo kökünde `.mcp.json` hazır:

```json
{
  "mcpServers": {
    "sitekeep": {
      "type": "http",
      "url": "${CDE_MCP_URL:-http://localhost:8787/mcp}",
      "headers": { "Authorization": "Bearer ${CDE_MCP_TOKEN}" }
    }
  }
}
```

Anahtarı Windows'ta kalıcı ortam değişkeni yapın (PowerShell):

```powershell
setx CDE_MCP_TOKEN "7dcde_api_..."
# anahtar bir dosyadaysa:
setx CDE_MCP_TOKEN (Get-Content "$env:USERPROFILE\.sitekeep\mcp-token.txt" -Raw).Trim()
```

- `setx` yeni açılan pencerelerde geçerlidir. Yeni bir terminal açın.
- `C:\Users\hasan\sitekeep` klasöründe yeni bir Claude Code oturumu açın. Claude Code proje sunucusunu ilk seferde onaylatır.
- `/mcp` komutu bağlantıyı gösterir. Değişken tanımlı değilse uyarı çıkar ve istekler 401 alır.
- Başka bir adres için: `setx CDE_MCP_URL "https://cde.sirket.local/mcp"`.

## 4. Claude Desktop

Claude Desktop'ın uzak bağlayıcıları (custom connectors) Anthropic bulutundan bağlanır; `localhost` adresine ulaşamaz. Bu
yüzden CDE'nin kendi stdio sunucusu `apps/mcp` kullanılır. Aynı araç setini (`packages/cde-tools`) sunar ve yerel dosya
yükleme/indirme araçlarını da içerir.

1. Bir kez derleyin: `npm run build` (repo kökünde).
2. Ayarlar → Geliştirici → Yapılandırmayı Düzenle. Dosya: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "sitekeep": {
      "command": "node",
      "args": ["C:\\Users\\hasan\\sitekeep\\apps\\mcp\\dist\\index.js"],
      "env": {
        "CDE_URL": "http://127.0.0.1:8787",
        "CDE_TOKEN": "7dcde_api_...",
        "CDE_DEV_TOOLS": "1"
      }
    }
  }
}
```

- `CDE_DEV_TOOLS=1` stdio sunucusuna geliştirici araçlarını ekler. Sunucu tarafı yine kendi kontrolünü yapar.
- Claude Desktop'ı tamamen kapatıp açın. Günlük: `%APPDATA%\Claude\logs\mcp-server-sitekeep.log`.
- Salt okuma için `CDE_READ_ONLY=1`.

## 5. Araçlar

### Geliştirici araçları (yalnız `CDE_DEV_TOOLS=1`, sistem yöneticisinin yazma anahtarı)

| Araç | Ne yapar |
|---|---|
| `cde_dev_health` | Sürüm, git commit, migration durumu, veritabanı türü, dönüştürücüler (ofis/DWG), yapay zekâ sağlayıcısı ve modu, MCP ayarları, iş kuyruğu, son sunucu hataları (anahtarlar gizlenir), tablo başına satır sayısı. |
| `cde_dev_seed` | Test projesine gerçekçi örnek veri: gelen/giden yazılar (ilgi zinciri, cevaplar), bilgi talepleri (sıradaki taraf), teknik onay kalemleri ve paketleri (revizyonlar, sonuçlar), toplantılar (gündem, katılımcı, eylem), gönderim formları, sorunlar, incelemeler (gecikenler dahil), başarısız maddeli formlar, temel planlı iş programı, model varsa çakışmalar. Tarihler geçmişe yayılır. Aynı etiket bir kez üretilir; `action: "remove"` siler. |
| `cde_dev_project` | Şablondan test projesi (kısa kodlu demo firmalar ve üyeler), üye ekleme, projeyi sıfırlama ve arşivleme (onaylı). |
| `cde_dev_upload` | Üretilmiş örnek dosya (antetli PDF pafta, PDF form, DOCX, XLSX, PPTX, DXF, küçük IFC), test dosyası ya da açıkça verilen bir yol; `newVersionOf` ile yeni versiyon. |
| `cde_dev_scenario` | Uçtan uca senaryolar, adım adım geçti/kaldı, süre ve bağlantı. |
| `cde_dev_ai_eval` | Uygulamanın kendi yapay zekâ özellikleri sabit Türkçe istemlerle: geçerli JSON, şema hataları, süre, token. `mode: "dry"` yalnız istemleri verir. |
| `cde_dev_ai_check` | Aday bir cevabı uygulamanın aynı doğrulamasından geçirir. |
| `cde_dev_time` | Örnek kayıtların tarihlerini kaydırır: "%30'u gecikmiş olsun" (`overdueRatio`) veya `shiftDays`. Onaylı. |

Senaryolar: `yazisma-dongusu`, `bilgi-talebi`, `teknik-onay`, `toplanti`, `inceleme`, `form-pdf`, `rapor`,
`karsilastirma`, `gorunum` (docs/product/SADELESTIRME.md'deki 15 kişi görevi).

### Yapay zekâ olarak Claude (yazma anahtarı; yetki kontrolleri uygulamanın kendisi)

| Araç | Ne yapar |
|---|---|
| `cde_ai_schemas` | Uygulamanın kendi yapay zekâ istemlerinin JSON şemaları ve kısa talimatları (rapor, form alanları, akış, model sorgusu, çeviri…). |
| `cde_report_save` | `{name, description, queries, html}` ile rapor paneli. Sorgular veri kümelerine göre denetlenir; varsayılan özel paneldir. |
| `cde_form_template_save` | Alan JSON'undan form şablonu; isteğe bağlı PDF kaynağı ve alan kutuları. Proje yöneticisi. |
| `cde_form_flow_save` | Akış: yerel modelin cevap biçiminde taslak (adlar projeyle eşleştirilir; bilinmeyen roller önerilerle döner) veya tam akış. |
| `cde_work_draft` | Açık tiplerden taslak iş: yazı verisi ve bağlantılarla. Hiçbir şey göndermez. |
| `cde_workflow_template_save` | İş akışı şablonu. |

## 6. Örnek istemler

- "PKF-DEMO'ya 50 yazışma ve 20 bilgi talebi üret, %30'u gecikmiş olsun."
  (`cde_dev_seed`: `incomingLetters: 25, outgoingLetters: 25, rfis: 20, overdueRatio: 0.3`)
- "Tüm senaryoları çalıştır ve kalanları göster."
- "Sağlık kontrolü yap; son sunucu hatalarını özetle."
- "Yazışma raporu taslağı hazırla ve kaydet." (`cde_report_datasets` → `cde_report_save`)
- "Şu akış tarifinden form akışı kaydet: Formu şantiye şefi doldurur, kalite kontrol mühendisi kontrol eder; ret olursa geri döner."
- "Yerel modelle yapay zekâ değerlendirmesini çalıştır, qwen3-8b-16k ile karşılaştır."
- "Değerlendirme istemlerini dry modda ver, sen cevapla ve cde_dev_ai_check ile denetle."
- "Bekleyen SiteKeep görevlerini yap."

## 7. "Yapay Zekâya Gönder" kuyruğu

Uygulamadaki yapay zekâ düğmeleri işi bağlı bir istemciye (Claude Desktop, Claude Code, ChatGPT, Gemini CLI, Cursor…)
bırakabilir. Kuyruk istemciden bağımsızdır; işi alan erişim anahtarının adı (ör. "Claude Code") görevde görünür.
İstemci tarifleri ve sağlayıcılar (DeepSeek, OpenAI, Gemini…): [docs/features/YAPAY_ZEKA_SAGLAYICILAR.md](../features/YAPAY_ZEKA_SAGLAYICILAR.md).

Akış:

1. Kullanıcı "Yapay Zekâyla Oluştur" yerine (veya yanında) **Yapay Zekâya Gönder** der. Ekranda "bekliyor" yazar.
2. İstemciye "bekleyen SiteKeep görevlerini yap" denir. İstemci `cde_ai_tasks_list` → `cde_ai_task_claim` çağırır.
   Talep, uygulamanın kendi modeline gidecek **tam istemi**, cevabın JSON şemasını ve yardımcı okuma araçlarını döndürür.
3. İstemci cevabı `cde_ai_task_complete` ile gönderir. Cevap, uygulamanın kendi yapay zekâ yolundan **isteyen kullanıcı
   olarak** geçer: aynı şema, aynı onarım kontrolü, aynı işlem. Hatalar istemciye döner; istemci düzeltip tekrar gönderir.
4. Geçerli sonuç isteyenin yetkisiyle uygulanır. Rapor, isteyenin **özel paneli** olarak kaydedilir. Akış, çeviri, şablon,
   adlandırma ve eylem önerileri ekranda taslak olarak açılır; kullanıcı onaylar.
5. Ekran 5 saniyede bir kontrol eder ve sonucu açar. Kullanıcı istediği an iptal eder. Proje içindeki "Sor" panelinde
   **Bekleyen Yapay Zekâ Görevleri** listesi vardır.

Kurallar:

- Görevi alan kişi projenin **üyesi** olmalı ve yazma yetkili API anahtarı kullanmalı.
- Görevler sır içermez (yalnız istek ve kayıt kimlikleri). 24 saatte (ayarlanabilir) süresi dolar.
- Talep, tamamlama ve ret denetim kaydına yazılır (`ai_task.*`).
- Bağlı istemci **dış yapay zekâdır**. Kuyruk için yapay zekâ modu kapalı olmamalı ve şunlardan biri gerekir: mod "Dış
  Sağlayıcılara İzin Ver" ve proje izni, ya da yöneticinin **Dış Yapay Zekâ İstemcilerine İzin Ver** anahtarı.
- Ayarlar: Yönetim → Yapay Zekâ → **Kendi Yapay Zekânı Bağla** → "Görev Kuyruğu Açık" ve "Dış Yapay Zekâ İstemcilerine İzin Ver".

Claude Code ile sürekli çalıştırmak için `/loop` kullanın:

```
/loop 5m bekleyen SiteKeep görevlerini yap
```

## 8. Senaryolar MCP'siz

```
npm run scenarios                     # bellekte yeni veritabanı, tüm senaryolar
npm run scenarios -- rapor inceleme   # yalnız bunlar
```

Çalışan geliştirme sunucusuna karşı: `CDE_URL=http://127.0.0.1:8787` ve `CDE_MCP_TOKEN` tanımlıyken aynı komut.
Bir senaryo kalırsa çıkış kodu 1 olur (CI için).

## 9. Güvenlik

- Geliştirici araçları `NODE_ENV=production` iken veya `CDE_DEV_TOOLS` yokken çalışmaz; araç listesinde de görünmez.
- Yalnız sistem yöneticisinin yazma anahtarı kullanabilir. Okuma anahtarları ve tarayıcı oturumu reddedilir.
- Yıkıcı araçlar (sıfırlama, arşiv, örnek veri silme, tarih kaydırma) yalnız **test/demo projelerinde** ve `confirm: true` ile
  çalışır. Test projesi: kodu `-DEMO` veya `-TEST` ile biten ya da geliştirici araçlarının oluşturduğu proje.
- Örnek veri yalnız test/demo projelerine yazılır. Kayıtlar `system_settings` içindeki `dev.registry` kaydında tutulur; işler
  ayrıca `data.devSeed` etiketini taşır.
- Her geliştirici aracı çağrısı `dev.tool`, her MCP çağrısı `mcp.tool` olarak denetim kaydına yazılır.
- Hiçbir araç e-posta veya KEP göndermez, dış adrese bağlanmaz. Örnek yazılar "elden" veya "CDE içi" kanalla kaydedilir.
- Sunucu günlüklerinde erişim anahtarları gizlenir.

## 10. Sınırlar

- `cde_dev_project action: "set_modules"` proje modül anahtarlarını açıp kapatır. Yazma araçları REST üzerinden
  çalıştığı için kapalı modüle yazma sunucu politikasına uyar.
- Geriye tarihleme yalnız zaman damgalarını kaydırır; numaralardaki yıl (`{YYYY}`) oluşturma anındaki yıldır.
- İnceleme ve form adımlarının gecikmesi, adım termini (`step_due_at`) geriye alınarak üretilir.
- `cde_dev_upload` ile verilen yol sunucu makinesinde okunur (yerel geliştirme için).
- Kuyruktaki "Sor" görevlerinde cevap, istemcinin MCP araçlarıyla bulduğu bilgilerden yazılır; uygulamanın kaynak etiketleri olmaz.
