## SiteKeep {{VERSION}}

commit `{{COMMIT}}`

| Sürüm | Kurulum paketi (Linux, {{ARCH}}) | İmaj |
|---|---|---|
| **SiteKeep Community** (AGPL-3.0, lisans gerekmez) | `sitekeep-community-{{VERSION}}-linux-{{ARCH}}.tar.gz` | `ghcr.io/sitekeephq/sitekeep:{{VERSION}}` |
| **SiteKeep Enterprise** (modüller lisansla açılır) | `sitekeep-enterprise-{{VERSION}}-linux-{{ARCH}}.tar.gz` | `ghcr.io/sitekeephq/sitekeep-enterprise:{{VERSION}}` |

Her paketin yanında `.sha256`; bağımlılık listesi (SBOM, CycloneDX): `sitekeep-{{VERSION}}-sbom.cdx.json`.
Bu sayfa iç dağıtım içindir (özel depo). Enterprise paketi müşteriye Odoo müşteri portalından verilir
(docs/onprem/kurulum-paketi.md, yayın planı C-3); Community paketi ve imajı depo açılınca herkese açıktır.

### Ekip: indirme

```bash
gh release download v{{VERSION}} -R sitekeephq/sitekeep -p 'sitekeep-*-{{VERSION}}-linux-{{ARCH}}.tar.gz*'
shasum -a 256 -c sitekeep-*-{{VERSION}}-linux-{{ARCH}}.tar.gz.sha256
```

### Müşteri BT'si: yeni kurulum (paket)

```bash
tar -xzf sitekeep-<community|enterprise>-{{VERSION}}-linux-{{ARCH}}.tar.gz && cd sitekeep-<…>-{{VERSION}}-linux-{{ARCH}}
sha256sum -c SHA256SUMS
sudo ./install.sh
```

### Müşteri BT'si: güncelleme (paket)

```bash
tar -xzf sitekeep-<…>-{{VERSION}}-linux-{{ARCH}}.tar.gz
sudo sitekeep upgrade ./sitekeep-<…>-{{VERSION}}-linux-{{ARCH}}
```

Güncelleme önce yedek alır; yeni sürüm 3 dakikada sağlıklı açılmazsa eski sürüme ve güncelleme
öncesi veritabanına kendiliğinden döner.

### Docker Compose

`.env`'de `SITEKEEP_VERSION={{VERSION}}`, sonra `docker compose pull && docker compose up -d`
(docs/onprem/docker-compose.md).

Her iki paket CI'da boş bir Linux sunucuda kurulum duman testinden geçti (kurulum, sürüm ve lisans
kontrolü, HTTPS, giriş, yükleme, yedek/geri yükleme, güncelleme, geri dönüş, kaldırma).
