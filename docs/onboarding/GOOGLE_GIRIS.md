# Yerel Google ile giriş

Tarih: 22.10.2026. Bu sayfa geliştirme makinesinde **Google ile devam et**
düğmesini açmak içindir. Ürün kuralı (kim girebilir, hatalar, kalan izinli
alan): [Google ile giriş](../features/GOOGLE_GIRIS.md).

Sırlar commit edilmez, bu dosyaya yazılmaz.

## 1. Üç ortam değişkeni

`apps/server/.env.development` (git dışında):

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:5173/api/v1/auth/google/callback
```

Üçü de dolu olmalı. İsimler `.env.development.example` içinde.

Google Cloud → Google Auth Platform → Clients: tür **Web**. Authorized
JavaScript origins: `http://localhost:5173` ve canlı için
`https://sitekeep.ornek.com`. Callback’ler:

- `http://localhost:5173/api/v1/auth/google/callback`
- `https://sitekeep.ornek.com/api/v1/auth/google/callback`

`gcloud auth login` yeterli değildir; Web OAuth istemcisi gerekir.

## 2. Sunucuyu yeniden başlat

`tsx watch` env değişimini her zaman görmez. `npm run dev` çalışan
süreci durdurup yeniden açın. Kontrol:

```bash
curl -sS http://127.0.0.1:8787/api/v1/auth/methods
```

Beklenen: `"google":true`. Sonra `http://localhost:5173/login` sert yenile.

## 3. CDE kullanıcısı veya izinli alan

İki yoldan biri:

- E-posta **Yönetim → Kullanıcılar**’da açık bir kayıttır; veya
- **İzinli Alan Adı** açıktır ve e-posta listedeki alandandır (ör.
  `7dimensions.eu`). Yeni kişi yönetici olmaz.

Yoksa: “Bu Google hesabı için SiteKeep erişimi tanımlı değil.”
`admin@7d-cde.localhost` Google ile girmez.

Consent **Testing** ise aynı e-posta Google → Test users listesinde de
olmalı. Aksi halde red CDE’den değil Google’dan gelir.

## 4. Canlı

Ayrı iş. VM `/opt/7d-cde/.env` ve yeniden başlatma; Canlı ortam.
Yerel `.env.development` canlıye kopyalanmaz.
