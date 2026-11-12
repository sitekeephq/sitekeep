# Google ile giriş

Tarih: 22.10.2026. Bu belge **CDE oturumu** içindir: `/login` üzerindeki
**Google ile devam et**. OpenCDE / Yönetim → OAuth Uygulamaları başka bir
yüzeydir: [OpenCDE](OPENCDE.md). Giden çağrı: [Gizlilik](GIZLILIK.md)
(`giris:google`). Mimari sözleşme: [Depo yapısı](../architecture/structure.md) §7.1.
Yerel üç satır: [Yerel Google ile giriş](../onboarding/GOOGLE_GIRIS.md).

Sırlar (istemci kimliği, gizli anahtar) bu belgeye yazılmaz.

---

## Bugün (22.10.2026)

Google, e-postayı doğrular. Varsayılan: CDE hesabı **açmaz**. Yönetim →
Kullanıcılar → **İzinli Alan Adı** açıksa listedeki alandan gelen yeni
kişi normal kullanıcı olarak açılır.

| Duruyor | Ne | Gerçek mi |
|---|---|---|
| `/login` düğmesi | Üç `GOOGLE_*` doluysa görünür | evet |
| `GET /api/v1/auth/methods` | `{ password, google }` | evet |
| Kayıtlı + açık kullanıcı | e-posta birebir (küçük harf) | evet |
| `email_verified` | Google doğrulamamışsa red | evet |
| `state` çerezi | CSRF; uyuşmazsa `invalid_state` | evet |
| İzinli alan adı | Yönetim anahtarı + alan listesi; yeni kullanıcı yönetici değil | evet |
| Canlı VM `app.env` | `sitekeep.ornek.com` üzerinde `GOOGLE_*` | evet (22.10.2026) |

Google Cloud tarafında istemci **Testing** ise yalnız Consent Screen →
**Test users** listesi geçer. CDE kullanıcısı olmak yetmez; Google da
reddedebilir.

---

## Kim girebilir

| Durum | Sonuç |
|---|---|
| CDE’de aynı e-posta var, açık | Oturum; `auth.login` (`provider: google`) |
| CDE’de yok, izinli alan kapalı veya eşleşmez | `account_not_allowed` — “Bu Google hesabı için SiteKeep erişimi tanımlı değil.” |
| CDE’de yok, izinli alan açık ve eşleşir | Kullanıcı açılır (`isAdmin: false`); oturum |
| CDE’de var, kapalı (`disabled`) | Aynı mesaj |
| Google e-posta doğrulamamış | `email_not_verified` |
| Üç env eksik | Düğme yok; `/auth/google` 404 |

`admin@7d-cde.localhost` bir Google hesabı değildir. İzinli alan kapalıysa
kişi önce **Yönetim → Kullanıcılar**’da eklenir.

Ayar `system_settings` anahtarı `auth.google`. Varsayılan kapalı, liste
boş. Alt alan (`mail.7dimensions.eu`) üst alanı eşler; `not7dimensions.eu`
eşlemez. SSO / Entra aynı modelin uzun vadesidir.

---

## Akış

```text
/login
  → GET /api/v1/auth/methods          google: üç env doluysa true
  → GET /api/v1/auth/google           state çerezi; Google'a yönlendir
  → accounts.google.com               openid email profile; select_account
  → GET /api/v1/auth/google/callback  code + state
  → oauth2.googleapis.com/token       outbound giris:google
  → userinfo                          e-posta (+ ad)
  → users.email                       yoksa izinli alan → yeni kullanıcı
  → kapalı / alan uyuşmaz             login?authError=account_not_allowed
  → oturum çerezi                     /
```

Kod: `apps/server/src/auth/routes.ts`, `auth/google-settings.ts`,
`googleAuthFromEnv()` (`index.ts`). Web: `Login.tsx`, Yönetim kartı
`Admin.tsx`. Test: `apps/server/test/auth/google-auth.test.ts`,
`packages/shared/test/google-auth.test.ts`.

Callback, Vite’ın `/api` vekili yüzünden tarayıcı adresidir; sunucu
`:8787` değil:

- yerel: `http://localhost:5173/api/v1/auth/google/callback`
- canlı: `https://sitekeep.ornek.com/api/v1/auth/google/callback`

Aynı Web istemcisine her iki origin + her iki callback yazılır.
`gcloud auth login` bir OAuth Web istemcisi değildir.

---

## Ortam

Üçü birden gerekir. Biri boşsa Google kapalıdır.

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
```

İsimler `.env.example` ve `apps/server/.env.development.example` içindedir.
Değer git’e girmez. `npm run dev` env değişince her zaman yeniden okumaz;
sunucuyu yeniden başlatın.

---

## Giriş hataları

| `authError` | Kullanıcıya |
|---|---|
| `account_not_allowed` | Bu Google hesabı için SiteKeep erişimi tanımlı değil. |
| `google_cancelled` | Google ile giriş işlemi iptal edildi. |
| diğer (`email_not_verified`, `invalid_state`, `google_failed`) | Google ile giriş tamamlanamadı. Lütfen tekrar deneyin. |

---

## Gerçeğe geçmek

1. **Canlı.** VM `/opt/7d-cde/app.env` üç `GOOGLE_*` + canlı callback
   (22.10.2026). İzinli alan `7dimensions.eu` açık. Consent hâlâ Testing.
2. **Consent Production.** Test listesi kalkar; marka doğrulaması Google’ın
   eşiğine bağlıdır.
3. **OIDC / Entra.** Aynı “sağlayıcı + kayıtlı e-posta / izinli alan”
   modeli; Google bir sağlayıcı olarak kalır.

Sır sohbette veya ekran görüntüsünde durduysa Google Cloud’da yenilenir.
