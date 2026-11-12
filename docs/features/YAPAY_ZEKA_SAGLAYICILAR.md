# Yapay Zekâ Sağlayıcıları ve "Kendi Yapay Zekânı Bağla"

Tarih: 11.10.2026 · Kaynaklar 11.10.2026'da sağlayıcıların resmî belgelerinden okundu (aşağıda).

SiteKeep tek bir sağlayıcıya bağlı değildir. Yönetim → Yapay Zekâ ekranında üç seçenek vardır; birlikte kullanılabilir.
Uygulamadaki yapay zekâ düğmeleri şu sırayla çalışır: **yerel model → bulut model → "Yapay Zekâya Gönder"** (yedek).

## 1. Hazır ayarlar

Model kimlikleri yalnız varsayılandır; düzenlenebilir. Fiyat saklanmaz, yalnız göreli maliyet gösterilir.

| Hazır ayar | Tür | Adres | Varsayılan / güçlü model | Araç | JSON modu | Veri | Maliyet |
|---|---|---|---|---|---|---|---|
| Ollama | yerel | `http://127.0.0.1:11434/v1` | qwen3:8b / qwen3:14b, deepseek-r1:8b | var | var | Bu sunucu veya ağdaki ekran kartlı sunucu | düşük |
| vLLM | yerel | `http://127.0.0.1:8000/v1` | Qwen/Qwen3-8B | var* | var | Ağ içi | düşük |
| LM Studio | yerel | `http://127.0.0.1:1234/v1` | (yüklü model) | var | yok | Bu bilgisayar | düşük |
| **DeepSeek** | bulut | `https://api.deepseek.com` | deepseek-flash / deepseek-v4-pro | var | var | **Çin Halk Cumhuriyeti** | düşük |
| OpenAI | bulut | `https://api.openai.com/v1` | gpt-5.4-mini / gpt-5.5 | var | var | ABD (veri yerleşimi açık projede AB vb.) | orta |
| Google Gemini | bulut | `https://generativelanguage.googleapis.com/v1beta/openai` | gemini-3.5-flash-lite / gemini-3.8-flash | yok** | var | Google küresel | düşük |
| Anthropic Claude | bulut | `https://api.anthropic.com` | claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5 | var | yok (istemle) | Küresel / isteğe bağlı ABD | yüksek |
| Mistral | bulut | `https://api.eu.mistral.ai/v1` | mistral-small-latest / mistral-medium-latest | var | var | AB/EFTA | orta |
| Groq | bulut | `https://api.groq.com/openai/v1` | openai/gpt-oss-20b / openai/gpt-oss-120b | var | var | ABD | düşük |
| OpenRouter | bulut | `https://openrouter.ai/api/v1` | sağlayıcı/model | var | var | Seçilen modelin sağlayıcısı | orta |
| Azure OpenAI | bulut | `https://KAYNAK.openai.azure.com/openai/v1` | dağıtım adı | var | var | Seçilen Azure bölgesi | orta |

\* vLLM'de araç çağrısı için sunucu `--enable-auto-tool-choice --tool-call-parser …` ile başlatılır.
\*\* Gemini 3 araç çağrılarında `thought_signature` geri gönderilmelidir; bu hazır ayarda "Sor" asistanı araçsız
(yönlendirme) modunda çalışır. Diğer özellikler araç kullanmaz.

### KVKK

- Bulut sağlayıcılar proje içeriğini Türkiye dışındaki sunucularda işler (KVKK m.9: yurt dışına aktarım). Açık rıza veya
  uygun aktarım dayanağı gerekir. Bulut modeller yalnız mod "Dış Sağlayıcılara İzin Ver" iken ve proje izin verdiyse çalışır.
- **DeepSeek bulut API'si**: gizlilik politikasına göre veriler Çin Halk Cumhuriyeti'nde toplanır, işlenir ve saklanır.
  Yalnız demo veya hassas olmayan projelerde kullanın. KVKK açısından güvenli seçenek DeepSeek veya Qwen açık ağırlıklı
  modellerini **Ollama ile yerelde** çalıştırmaktır (ör. `deepseek-r1:8b`, `qwen3:14b`). Dikkat: Ollama'daki `deepseek-v4…:cloud`
  etiketleri yerelde değil, Ollama bulutunda çalışır.
- Gemini'de ücretsiz kotada istemler ürün geliştirmede kullanılabilir; ücretli kota kullanın.

## 2. Uyum katmanı (apps/server/src/ai/provider.ts)

- **Yetenek bayrakları** (araç, JSON modu, görüntü, bağlam) hazır ayardan gelir; özel uçlarda temkinli varsayılan (araç var, JSON modu yok).
- **JSON modu**: JSON bekleyen özellikler (rapor, form şablonu, akış, alan adlandırma, Modele sor, eylem önerisi, bilgi talebi
  taslağı, çeviri) `response_format: json_object` ister. Desteklemeyen sağlayıcıda yalnız istem + ayıklama kullanılır; uç
  `response_format`'ı reddederse istek onsuz bir kez tekrarlanır.
- **Düşünme (reasoning)**: `reasoning_content` / `reasoning` alanları hiç okunmaz; `<think>…</think>` blokları her zaman silinir.
  "Düşünme Modunu Kapat" sağlayıcıya göre gönderilir (DeepSeek ve OpenAI `reasoning_effort: "none"`, Groq `include_reasoning: false`,
  Ollama `reasoning_effort: "none"` + ` /no_think`).
- **Token parametresi**: OpenAI ve Azure `max_completion_tokens`, diğerleri `max_tokens`.
- **429**: `Retry-After` / `retry-after-ms` dikkate alınarak iki kez tekrar; yoksa 1 sn, 2 sn. Sonra açık bir Türkçe hata.
- **Akışta token sayısı**: destekleyenlerde `stream_options.include_usage`.
- **Araçsız sağlayıcı**: "Sor" asistanı yönlendirme moduna geçer; seçilen araçlardan argümansız olanlar önce çalışır, model tek
  çağrıda bu verilerden cevaplar.
- `cde_dev_ai_eval` `providers: ["DeepSeek", "Ollama (yerel)"]` (veya `["all"]`) ile aynı istem setini birden çok sağlayıcıda
  çalıştırır; geçerlilik, süre, token ve (yalnız sizin verdiğiniz `prices` ile) tahmini maliyet karşılaştırması verir.

## 3. Kullanıcının kendi Claude veya Cursor API anahtarı

Her proje üyesi **Proje Ayarları → Yapay Zekâ → Kendi API Anahtarlarım** bölümünde kendi Anthropic Claude veya Cursor
API anahtarını kaydedebilir. Ardından **Sor** ve **Modele Sor** ekranlarındaki sağlayıcı listesinden proje sağlayıcısı,
kişisel Claude veya kişisel Cursor seçilir. Seçim yalnız yeni sohbet/sorgular için geçerlidir; başka kullanıcıların
anahtarları ve kullanım kotası paylaşılmaz.

- Anahtarlar `user_ai_credentials` tablosunda kullanıcı bazında tutulur ve `CDE_SECRET_KEY` ile **AES-256-GCM**
  şifrelenir. API ve arayüz yalnız `hasApiKey` bilgisini döndürür; anahtar hiçbir zaman geri gösterilmez.
- Kaydetmeden önce sağlayıcıya içeriksiz küçük bir doğrulama çağrısı yapılır. Başarısız anahtar kaydedilmez ve varsa
  önceki çalışan anahtar değiştirilmez.
- Anahtarlar hash'lenmez: sağlayıcıya tekrar gönderilmesi gereken bir sır hash değerinden geri üretilemez.
- Kullanıcı yalnız kendi anahtarını ekleyebilir, değiştirebilir, test edebilir veya silebilir; sistem yöneticisi dahi
  başka bir kullanıcının açık anahtarını okuyamaz.
- Kişisel sağlayıcılar yalnız sistem modu `allow_external`, proje AI ayarı açık ve proje dış sağlayıcılara izin vermişse
  çalışır. Gizlilik Merkezi'nin dış bağlantı kapatma anahtarı tüm kişisel çağrıları da durdurur.
- Claude çağrıları Anthropic Messages API üzerinden yapılır. Cursor çağrıları resmî `@cursor/sdk` ile araçsız ve geçici
  çalışma alanında yürütülür; proje aramaları CDE'nin izin kontrollü yönlendirme katmanında hazırlanır.
- İstem, cevap veya API anahtarı denetim kaydına yazılmaz. Sağlayıcı, model, süre ve içerik olmayan bağlantı ölçümleri
  dış bağlantı kaydına eklenir.

## 4. Kendi yapay zekânı bağla (MCP istemcileri)

CDE'nin MCP ucu: `https://cde.sirket.local/mcp` (Streamable HTTP), başlık `Authorization: Bearer <erişim anahtarı>`.
Yerel stdio sunucusu: `node C:\yol\7d-cde\apps\mcp\dist\index.js` (ortam: `CDE_URL`, `CDE_TOKEN`).

| İstemci | Nasıl | localhost | Not |
|---|---|---|---|
| Claude Code | `.mcp.json`: `{"type":"http","url":…,"headers":{"Authorization":"Bearer ${CDE_MCP_TOKEN}"}}` | evet | Ayrıntı: docs/onboarding/GELISTIRICI_MCP.md |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` içinde stdio (`command`/`args`/`env`) | stdio ile | Uzak bağlayıcılar Anthropic bulutundan bağlanır; localhost'a ulaşmaz |
| ChatGPT | Ayarlar → Uygulamalar → Geliştirici modu → özel MCP sunucusu | hayır | Herkese açık HTTPS adres (müşterinin ters vekil sunucusu) veya OpenAI Secure MCP Tunnel gerekir. **Sabit Bearer başlığı gönderemez**: OAuth veya ağ kısıtlamalı kimliksiz bağlantı gerekir |
| Gemini CLI | `~/.gemini/settings.json`: `"mcpServers": {"cde": {"httpUrl": …, "headers": {"Authorization": "Bearer ${CDE_TOKEN}"}}}` | evet | `url` SSE demektir; `httpUrl` kullanın |
| Cursor | `~/.cursor/mcp.json` veya `.cursor/mcp.json`: `{"url": …, "headers": {"Authorization": "Bearer ${env:CDE_TOKEN}"}}` | evet | |
| VS Code (Copilot ajanı) | `.vscode/mcp.json`: `"servers": {"cde": {"type": "http", "url": …, "headers": {"Authorization": "Bearer ${input:cde-token}"}}}` | evet | Başlıkta `${env:…}` güvenilir değil; `${input:…}` kullanın |
| Cline | MCP Sunucuları → Yapılandır: `{"type": "streamableHttp", "url": …, "headers": {…}}` | evet | Model olarak DeepSeek API anahtarı seçilebilir |
| Continue | `config.yaml` → `mcpServers` (`type: streamable-http`, `requestOptions.headers`) | evet | Yalnız ajan modunda; `provider: deepseek` var. Başlık desteğini deneyin |
| Open WebUI | Yönetim → Entegrasyonlar → Dış Araç Sunucuları → "MCP (Streamable HTTP)", kimlik: Bearer | arka uca erişilebiliyorsa | stdio için `mcpo` köprüsü; model olarak DeepSeek (`https://api.deepseek.com/v1`) veya Ollama |
| LibreChat | `librechat.yaml` → `mcpServers.cde: {type: streamable-http, url, headers}` | `mcpSettings.allowedAddresses` ile | DeepSeek/Ollama `endpoints.custom` ile |

### "Yapay Zekâya Gönder" her istemciyle çalışır

Kuyruk istemciden bağımsızdır. Görevi alan erişim anahtarının adı (ör. "Claude Code", "Cursor") ekranda görünür. İstemciye
"bekleyen SiteKeep görevlerini yap" denir; istemci `cde_ai_tasks_list` → `cde_ai_task_claim` → `cde_ai_task_complete` çağırır.
Ayrıntılar ve güvenlik kuralları: docs/onboarding/GELISTIRICI_MCP.md, bölüm 7.

## 5. Yerel üyelik connector'ı

`7d-cde-ai`, şirket OpenRouter anahtarını kullanmadan görev kuyruğunu kullanıcının kendi bilgisayarında işler:

- **Cursor:** Resmî `@cursor/sdk` tarayıcı girişiyle kullanıcının Cursor hesabına bağlanır. Anahtar elle kopyalanmaz;
  SDK kısa ömürlü kullanıcı anahtarını kendi güvenli yerel deposunda saklar.
- **Claude:** Bilgisayardaki resmî Claude Code oturumunu kullanır. Önce `claude auth login` yapılır; CDE hiçbir Claude
  oturum bilgisi veya API anahtarı almaz.

Ön koşullar:

1. Yönetim → Yapay Zekâ → Kendi Yapay Zekânı Bağla altında görev kuyruğu, dış istemciler ve yazma anahtarları açılır.
2. Kullanıcı Hesabım → API Erişim Anahtarları bölümünde, üye olduğu projelerle sınırlı bir **yazma** anahtarı oluşturur.
3. Repo bir kez derlenir: `npm run build -w @sitekeep/mcp`.

Cursor ile:

```bash
npm run connector -w @sitekeep/mcp -- login cursor
CDE_URL=https://cde.example.com \
CDE_TOKEN='<CDE yazma anahtarı>' \
npm run connector -w @sitekeep/mcp -- run --runtime cursor
```

Claude üyeliği ile:

```bash
claude auth login
CDE_URL=https://cde.example.com \
CDE_TOKEN='<CDE yazma anahtarı>' \
npm run connector -w @sitekeep/mcp -- run --runtime claude
```

`--once` yalnız ilk görevi işler; sürekli çalışan connector varsayılan olarak kuyruğu 5 saniyede bir kontrol eder.
Model yalnız salt-okunur CDE MCP araçlarını görür. Görevi alma/tamamlama, sonuç doğrulama, kullanıcı yetkileri ve denetim
kaydı CDE sunucusunda kalır. Cursor/Claude üyelik koşulları ve kotaları ilgili sağlayıcı tarafından uygulanır.

## 6. Modele Sor ve değişiklik özeti

Model görüntüleyicideki **Modele Sor**, Türkçe soruyu doğrulanan bir sorgu JSON'una çevirir; sayı, liste, metraj ve
kat/tip grupları sunucuda model indeksinden hesaplanır. Sonuç elemanları vurgulanabilir, yalıtılabilir, rapor paneli
olarak kaydedilebilir veya en çok 5000 elemanla bir soruna dönüştürülebilir. Versiyon karşılaştırmasındaki
**Değişiklik Özeti** eklenen, silinen ve değişen elemanları kat, sınıf ve özelliğe göre gruplar; “Değişikliklere sor”
yalnız bu elemanlarda arar. Karşılaştırma özeti yazdırılabilir rapor olarak da açılır.

İşleyiş ve güvenlik:

1. Model indeksi sınıf, kat, tip, malzeme, özellik setleri ve temel Qto metrajlarını içerir.
2. Anahtar kelime kuralları önce hızlı bir sonuç verir; sağlayıcı açıksa model aynı soruyu sorgu JSON'una çevirir.
3. Sağlayıcıya eleman listesi değil, yalnız model sözlüğü (alan ve sınıf adları, birkaç örnek değer ve sayılar) gider.
4. Model kod çalıştırmaz ve sonuç sayılarını üretmez. JSON doğrulanır; geçersizse kural tabanlı sonuç korunur.
   Değişiklik anlatımında girdide bulunmayan bir sayı üretilirse ilgili madde atılır.
5. Her istek kullanıcının klasör yetkileri ve yönetici/proje dış sağlayıcı politikasıyla çalışır. Yapay zekâ kapalıysa
   anahtar kelimeler ve filtre oluşturucu kullanılmaya devam eder.
6. Aynı model ve soru için sonuç bellekte önbelleğe alınır; sunucu yeniden başladığında önbellek silinir.

Sorgu alanları `classes`, `storeys`, `filters`, `groupBy`, `aggregate` ve karşılaştırmada `change` değerleridir.
Filtre işleçleri `=`, `!=`, `contains`, `>`, `<`, `>=`, `<=`, `exists`, `missing`; alanlar `class`, `storey`, `type`,
`name`, `material` veya `FireRating` / `Pset_DoorCommon.FireRating` gibi özellik adlarıdır. `IfcWall` filtresi
`IfcWallStandardCase` elemanlarını da kapsar; `!=` özelliği bulunmayan elemanları da döndürür.

API:

- `GET /projects/:pid/versions/:vid/model-vocab`
- `POST /projects/:pid/versions/:vid/model-query` — `{query, compareFrom?}`, yapay zekâsız
- `POST /projects/:pid/versions/:vid/model-ask` — `{question, compareFrom?, mode: "auto" | "rules"}`
- `POST /projects/:pid/versions/:vid/model-query/report-draft`
- `GET /projects/:pid/compare?from&to`
- `POST /projects/:pid/compare/summary` — `{from, to, ai}`
- `GET /projects/:pid/compare/report?from&to`

Salt-okunur API anahtarları sorgu, soru ve özet uçlarını kullanabilir. MCP karşılıkları `cde_model_query`,
`cde_model_compare_summary` ve metraj için `cde_quantity_inventory` ([METRAJ.md](METRAJ.md)); rapor veri kümesi `model_elements` (`fileId` ve `modelQuery` filtreleri) adını kullanır.

Sınırlar: eski indeksler ilk sorguda yeniden hazırlanabilir (409); aks bilgisi ve birim dönüşümü yoktur; özellik
değerleri 200 karakterde kısalır. Liste en çok 2000, vurgulama 20.000 elemandır. Geometri farkı ayrıca ölçülmez;
yerleşim değişikliği ayırt edilir. “2. kat” önce kat adındaki sayıya, bu yoksa zeminden sıraya göre eşlenir. Yerel CPU
modelinde ilk soru 30–60 saniye sürebilir; bu sırada hızlı sonuç ve filtreler kullanılabilir.

## Kaynaklar

- DeepSeek: https://api-docs.deepseek.com/ · /guides/thinking_mode · /guides/json_mode · /updates · gizlilik: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- OpenAI: https://developers.openai.com/api/docs/models · /guides/your-data
- Gemini: https://ai.google.dev/gemini-api/docs/openai · /docs/thinking · /docs/generate-content/thought-signatures · /terms
- Anthropic: https://platform.claude.com/docs/en/api/messages · /build-with-claude/thinking · /manage-claude/data-residency
- Mistral: https://docs.mistral.ai/models · /inference/regional-inference
- Groq: https://console.groq.com/docs/openai · /docs/reasoning · /docs/your-data
- OpenRouter: https://openrouter.ai/docs/quickstart · /docs/guides/best-practices/reasoning-tokens
- Azure OpenAI: https://learn.microsoft.com/azure/foundry/openai/reference · /api-version-lifecycle
- Ollama: https://docs.ollama.com/api/openai-compatibility · vLLM: https://docs.vllm.ai/en/latest/features/tool_calling/ · LM Studio: https://lmstudio.ai/docs/developer/openai-compat
- MCP istemcileri: https://code.claude.com/docs/en/mcp · https://support.claude.com/en/articles/11175166 · https://developers.openai.com/plugins/build/auth ·
  https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md · https://cursor.com/docs/context/mcp ·
  https://code.visualstudio.com/docs/copilot/reference/mcp-configuration · https://docs.cline.bot/mcp/configuring-mcp-servers ·
  https://docs.continue.dev/customize/deep-dives/mcp · https://docs.openwebui.com/features/extensibility/mcp ·
  https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers

Doğrulanamayanlar: Ollama `/v1` uçtaki düşünme alanının adı, LM Studio `json_object` desteği, Azure v1 ucunda `api-key`
başlığı, Mistral Large 4 kimliği. Bunlar sahada denenmeli.
