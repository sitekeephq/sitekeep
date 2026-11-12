# Gizlilik

SiteKeep gizlilik öncelikli bir CDE'dir. Bu belge sunucudan neyin, ne zaman, nereye çıktığını anlatır.

## İlke

- Veri müşterinin sunucusunda kalır.
- Sunucu dışarıya kendiliğinden veri göndermez. Telemetri, kullanım istatistiği, güncelleme denetimi yoktur.
- Her dış bağlantıyı yönetici açar. Hepsi **Yönetim → Gizlilik Merkezi**'nde görünür.
- Her dış çağrı kayda geçer. Kayıtta içerik asla tutulmaz.
- Tek düğme bütün dış bağlantıları keser.

## Veri akışları

Varsayılan kurulumda sunucu ağ dışına hiçbir bağlantı kurmaz. Aşağıdakiler yalnız yönetici ayarlarsa çalışır.

| Bağlantı | Ne zaman | Ne gider | Kayıttaki amaç |
|---|---|---|---|
| Yapay zekâ sağlayıcısı (Ollama, vLLM, DeepSeek, Claude…) | Bir yapay zekâ özelliği kullanılınca | İstem: soru, ilgili kayıt özetleri. Ağ dışına giden istemde kişisel veriler maskelenir. | `yapay_zeka:<sağlayıcı>` |
| Rapor modeli (`AI_BASE_URL`) | Rapor oluşturucu kullanılınca | Veri kümesi şeması ve istek | `yapay_zeka:rapor` |
| E-posta sunucusu (SMTP) | Resmî yazı "Gönder" ile gönderilince | Yazı metni ve PDF eki, alıcılar | `eposta` |
| Ofis editörü (ONLYOFFICE / Collabora) | Editör ayarı ve dosya açılışı | Sunucu: yalnız discovery isteği. Dosyayı editör WOPI ile CDE'den kendisi çeker. | `ofis:onlyoffice`, `ofis:collabora` |
| Ofis → PDF dönüştürücü (ONLYOFFICE, Collabora, Gotenberg) | Ofis dosyası önizlemesi | Dönüştürülecek dosya | `ofis:<dönüştürücü>` |
| Google ile giriş | Kullanıcı Google girişini seçince | OAuth kodu; ardından doğrulanmış e-posta bilgisi alınır | `giris:google` — [Google ile giriş](GOOGLE_GIRIS.md) |
| Autodesk APS / ACC | Proje yöneticisi bağlantı kurunca ve eşitleme çalışınca | OAuth kodu ve salt okunur proje API istekleri; ACC kayıtları CDE'ye alınır | `entegrasyon:autodesk` |

Gelen bağlantılar (sunucu dışarıya bağlanmaz, istemci CDE'ye bağlanır):

- **MCP sunucusu:** Claude, ChatGPT gibi istemciler erişim anahtarıyla bağlanır. Anahtarın yetkisi kadar veri okur.
- **Yapay zekâ görev kuyruğu:** bağlı istemci, bekleyen görevin istemini alır. İstemci dış yapay zekâdır.
- **OAuth uygulamaları (OpenCDE):** kullanıcı onay verdiği uygulama, onaylanan kapsam kadar veri alır.

Tarayıcı tarafı: sayfalar sıkı bir içerik güvenlik politikasıyla (CSP) sunulur. Tarayıcı başka siteden betik, yazı tipi, resim yüklemez. Tek istisna ayarlı ofis editörünün adresidir.

## Giden bağlantı kaydı

Sunucudaki her dış çağrı tek bir yardımcıdan geçer (`apps/server/src/privacy/outbound.ts`). Bir test, bu yardımcının dışında yeni bir `fetch(` çağrısı yazılırsa başarısız olur.

Her çağrı için tutulanlar:

- zaman, amaç, sunucu adı, yöntem;
- giden ve gelen bayt, HTTP durumu, süre;
- isteyen kullanıcı ve proje (biliniyorsa);
- yapay zekâ çağrılarında: özellik, sağlayıcı, model, gönderilen karakter sayısı, maskelenen veri sayıları.

İçerik, istem, cevap, dosya adı tutulmaz. Kayıtlar varsayılan 90 gün saklanır. Süre Gizlilik Merkezi'nden değişir. Süresi dolan kayıtlar her gün silinir. Kayıt CSV olarak indirilebilir.

## Yapay zekâda veri en aza indirme

Ağ dışındaki bir modele giden her istemde şu veriler yer tutucuyla değişir:

- e-posta adresleri → `[E-POSTA_1]`
- Türkiye telefon numaraları (+90, 0, alan kodu, boşluklu ya da bitişik) → `[TELEFON_1]`
- TC kimlik numaraları (sağlama hanesi doğru olanlar) → `[TCKN_1]`
- TR IBAN'lar → `[IBAN_1]`
- proje üyelerinin ad soyadları → rol ve firma, ör. `[Proje Müdürü (Poyraz)]` (ayar ile kapatılabilir)

Eşleme yalnız o çağrı boyunca bellekte durur. Modelin cevabındaki yer tutucular, cevap aynı kullanıcıya gösterilmeden önce asıllarıyla değiştirilir. Eşleme hiçbir yere yazılmaz.

Yerel modellerde maskeleme varsayılan olarak kapalıdır. **Yerel Modelde de Maskele** ayarı açılırsa yerel modele de maskeli istem gider.

## Tüm dış bağlantıları kapat

Gizlilik Merkezi'ndeki **Tüm Dış Bağlantıları Kapat** düğmesi açıldığında:

- Sunucu ağ dışındaki hiçbir adrese bağlanmaz. Çağrı açık bir Türkçe hatayla durur ve kayda "engellendi" olarak düşer.
- Yapay zekâ modu tam yerel (`local_only`) olur. Seçilen mod saklanır, düğme kapanınca geri gelir.
- Dış yapay zekâ istemcileri için görev kuyruğu durur.
- Autodesk zamanlanmış eşitlemesi durur; yeni OAuth ve API çağrıları engellenir.
- Yöneticiler her sayfanın üstünde bir uyarı şeridi görür.

Yerel ağ şöyle belirlenir:

- özel IP aralıkları (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, IPv6 fc00::/7 ve fe80::/10);
- `localhost`, `.local`, `.lan`, `.internal`, `.home.arpa` ile biten adlar ve tek parçalı adlar (ör. Docker'daki `ollama`);
- yöneticinin **İç Ağ Sunucuları** listesi: tam ad, `*.firma.com.tr` ya da `100.64.0.0/10` gibi IPv4 aralığı.

Her bağlantı ayrıca **Dış Bağlantılar** listesinden tek tek kapatılabilir.

## Autodesk verisinin saklanması ve silinmesi

ACC'den alınan kullanıcı adı, e-posta, firma, sorun, form, inceleme, RFI ve submittal kayıtları proje
veritabanında saklanır. OAuth erişim ve yenileme belirteçleri `CDE_SECRET_KEY` ile AES-GCM şifreli
tutulur; arayüze veya dış bağlantı kaydına yazılmaz.

- Kaynak kayıt ile CDE kaydı arasındaki eşleme korunur; aynı kayıt yeniden eşitlendiğinde kopya oluşmaz.
- Varsayılan saklama süresi projenin saklama süresidir. Bağlantıyı kapatmak yeni eşitlemeyi durdurur,
  daha önce alınmış proje kayıtlarını kendiliğinden silmez.
- Proje yöneticisi bağlantıyı proje ayarlarından kapatabilir; içeri aktarılan yerel kayıtlar kendi
  modüllerindeki normal silme/arşivleme kurallarıyla yönetilir. Proje silindiğinde bağlantı, şifreli
  belirteçler, ham eşitleme kayıtları ve eşlemeler ilişkisel olarak silinir.
- ACC'deki kişisel verilerin CDE'ye aktarılması ve saklama süresinin belirlenmesi veri sorumlusu kurumun
  yükümlülüğündedir.

## KVKK notları

- Veri sorumlusu kurumdur. SiteKeep veriyi kurumun sunucusunda işler.
- Bulut yapay zekâ sağlayıcısı kullanmak yurt dışına veri aktarımı sayılabilir. Bu yüzden:
  - dış sağlayıcıyı sistem yöneticisi açar, her proje ayrıca izin verir;
  - kişisel veriler maskelenir;
  - her çağrı kayda geçer.
- Sağlayıcının veri işleme sözleşmesini ve aktarım dayanağını kurum değerlendirmelidir.
- Giden bağlantı kaydı, aktarım envanteri ve denetim için kanıt olarak kullanılabilir.
- Maskeleme bir güvenlik katmanıdır, tam anonimleştirme değildir. Serbest metindeki dolaylı kimlik bilgileri (ör. adres, unvan) maskelenmez.

## Güvenlik başlıkları

Her cevapta: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` (kamera yalnız bu site için; form fotoğrafları), `Cross-Origin-Opener-Policy: same-origin-allow-popups`. HTTPS üzerinden sunulunca `Strict-Transport-Security`.

Sayfalarda `Content-Security-Policy`: yalnız kendi dosyaları, wasm (pdf.js, web-ifc), `blob:` çalışanları, `data:`/`blob:` resimleri. Rapor çerçevesinin satır içi betikleri sayfa başına üretilen bir nonce ile çalışır. `frame-ancestors 'self'`.

OAuth yolları (`/oauth2/*`, onay sayfası) açılır pencere kullanan istemciler için COOP almaz. Kendi CSP'sini koyan yollar (önizleme, işaretleme, karşılaştırma raporu) kendi politikasını korur.

## Yol haritası (faz 2)

- Saklanan dosyalar için diskte şifreleme.
- KVKK kullanıcı verisi dışa aktarımı ve anonimleştirme (ilgili kişi başvuruları).
- Saklama politikaları: proje, klasör ve kayıt türüne göre süre ve otomatik silme.
- Tam proje dışa aktarımı (OpenCDE BCF ve Documents API biçiminde): müşteri verisini istediği an başka bir CDE'ye taşır.
- İki aşamalı doğrulama (2FA) ve kurumsal oturum açma (SSO).
- Görev kuyruğu istemlerinin de maskelenmesi.
