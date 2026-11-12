#!/usr/bin/env bash
# SiteKeep kurulum sihirbazı (Linux, Docker).
#
#   sudo ./install.sh                     soru sorarak kurar
#   sudo ./install.sh --answers cevap.env  cevap dosyasıyla, sorusuz (otomatik kurulum, test)
#
# Ne yapar: ön kontrol (Docker, işlemci, bellek, disk, port) → sorular → paketteki imajları
# yükler (internet gerekmez) → şifreleri ve anahtarları üretir → PostgreSQL + SiteKeep + HTTPS
# vekilini başlatır → sağlığı bekler → gece yedeğini zamanlar → yönetim komutunu kurar (sitekeep).
# Ayrıntı: README.md, docs/onprem/installation-bundle.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$HERE/VERSION")"
ANSWERS=""
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --answers) ANSWERS="$2"; ASSUME_YES=1; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Bilinmeyen seçenek: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$ANSWERS" ]; then
  [ -f "$ANSWERS" ] || { echo "Cevap dosyası yok: $ANSWERS" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  . "$ANSWERS"
  set +a
fi

CDE_HOME="${CDE_HOME:-/opt/sitekeep}"
CDE_DATA="${CDE_DATA:-/var/lib/sitekeep}"
CDE_HTTP_PORT="${CDE_HTTP_PORT:-80}"
CDE_HTTPS_PORT="${CDE_HTTPS_PORT:-443}"
CDE_LANGUAGE="${CDE_LANGUAGE:-tr}"
CDE_BACKUP_KEEP="${CDE_BACKUP_KEEP:-14}"
CDE_BACKUP_TIME="${CDE_BACKUP_TIME:-02:30}"
CDE_USERS="${CDE_USERS:-50}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }

# ask VAR "Soru" [varsayılan]: cevap dosyasında / ortamda varsa sorulmaz.
ask() {
  local var="$1" question="$2" def="${3:-}" cur="${!1:-}"
  if [ -n "$cur" ] || [ "$ASSUME_YES" = 1 ]; then printf -v "$var" '%s' "${cur:-$def}"; return; fi
  local reply
  read -r -p "  $question${def:+ [$def]}: " reply
  printf -v "$var" '%s' "${reply:-$def}"
}

ask_secret() {
  local var="$1" question="$2"
  if [ -n "${!1:-}" ] || [ "$ASSUME_YES" = 1 ]; then return; fi
  local reply
  read -r -s -p "  $question: " reply; echo
  printf -v "$var" '%s' "$reply"
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply
  read -r -p "  $1 [e/H]: " reply
  [[ "$reply" =~ ^[eEyY] ]]
}

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

bold "SiteKeep $VERSION kurulumu"
echo

# ---- 1. Ön kontrol ------------------------------------------------------------------------------
bold "1/6 Ön kontrol"
[ "$(id -u)" = 0 ] || die "Kurulum yönetici (root) olarak çalışmalı: sudo ./install.sh"
[ "$(uname -s)" = Linux ] || die "Bu paket Linux içindir."
if [ -f "$CDE_HOME/.env" ]; then
  die "$CDE_HOME içinde bir kurulum zaten var. Yeni sürüm için: sudo sitekeep upgrade $HERE"
fi

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker kurulu değil."
  info "Docker Engine + Compose eklentisi gerekir: https://docs.docker.com/engine/install/"
  info "İnternetli sunucuda tek komut: curl -fsSL https://get.docker.com | sh"
  if [ "${CDE_INSTALL_DOCKER:-0}" = 1 ] || { [ "$ASSUME_YES" = 0 ] && confirm "Docker şimdi internetten kurulsun mu?"; }; then
    curl -fsSL https://get.docker.com | sh || die "Docker kurulamadı."
  else
    die "Docker kurup kurulumu yeniden başlatın."
  fi
fi
docker info >/dev/null 2>&1 || die "Docker servisi çalışmıyor: systemctl start docker"
docker compose version >/dev/null 2>&1 || die "Docker Compose eklentisi yok (docker compose). Docker'ı resmi depodan kurun."
ok "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short)"

ARCH="$(uname -m)"
BUNDLE_ARCH="$(cat "$HERE/ARCH" 2>/dev/null || echo amd64)"
case "$ARCH" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; esac
[ "$ARCH" = "$BUNDLE_ARCH" ] || die "Bu paket $BUNDLE_ARCH içindir; sunucu $ARCH."

ask CDE_USERS "Tahmini kullanıcı sayısı" "$CDE_USERS"
# Kapasite kademeleri (docs/onprem/capacity.md §4): kullanıcı → vCPU, RAM (GB), veri diski (GB).
need_cpu=2; need_ram=8; need_disk=100; tier="Deneme"
if [ "$CDE_USERS" -gt 200 ]; then need_cpu=16; need_ram=64; need_disk=2000; tier="Büyük"
elif [ "$CDE_USERS" -gt 50 ]; then need_cpu=8; need_ram=32; need_disk=1000; tier="Orta"
elif [ "$CDE_USERS" -gt 10 ]; then need_cpu=4; need_ram=16; need_disk=500; tier="Küçük"; fi
cpus="$(nproc)"
ram_gb="$(awk '/MemTotal/ {printf "%d", ($2/1024/1024)+0.5}' /proc/meminfo)"
mkdir -p "$CDE_DATA"
disk_gb="$(df -Pk "$CDE_DATA" | awk 'NR==2 {printf "%d", $4/1024/1024}')"
info "Sunucu: $cpus vCPU, $ram_gb GB RAM, veri diskinde $disk_gb GB boş ($CDE_DATA)"
info "$tier kademesi ($CDE_USERS kullanıcı): en az $need_cpu vCPU, $need_ram GB RAM, $need_disk GB disk"
short=""
[ "$cpus" -ge "$need_cpu" ] || short="$short işlemci"
[ "$ram_gb" -ge "$need_ram" ] || short="$short bellek"
[ "$disk_gb" -ge "$need_disk" ] || short="$short disk"
if [ -n "$short" ]; then
  warn "Önerilenin altında:$short. Kurulum yapılabilir ama yük altında yavaşlar."
  confirm "Yine de kurulsun mu?" || die "Kurulum durduruldu."
else
  ok "Donanım kademeyi karşılıyor"
fi

port_busy() { command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
for p in "$CDE_HTTP_PORT" "$CDE_HTTPS_PORT"; do
  if port_busy "$p"; then die "Port $p kullanımda. Başka bir servis dinliyor; CDE_HTTP_PORT / CDE_HTTPS_PORT ile değiştirin."; fi
done
ok "Portlar boş ($CDE_HTTP_PORT, $CDE_HTTPS_PORT)"
echo

# ---- 2. Sorular ---------------------------------------------------------------------------------
bold "2/6 Ayarlar"
default_host="$(hostname -f 2>/dev/null || hostname)"
ask CDE_DOMAIN "Sunucunun adresi (alan adı veya IP; kullanıcılar tarayıcıya bunu yazar)" "$default_host"
info "HTTPS: auto = herkese açık alan adı + internet (Let's Encrypt)"
info "       internal = iç ağ, sertifikayı kurulum üretir (kök sertifika istemcilere dağıtılır)"
info "       files = kurumun kendi sertifikası (PEM)   off = yalnız HTTP (önerilmez)"
ask CDE_TLS "HTTPS türü (auto / internal / files / off)" "internal"
case "$CDE_TLS" in auto|internal|files|off) ;; *) die "HTTPS türü auto, internal, files veya off olmalı." ;; esac
if [ "$CDE_TLS" = files ]; then
  ask CDE_TLS_CERT "Sertifika dosyası (PEM, zincir dahil)" ""
  ask CDE_TLS_KEY "Özel anahtar dosyası (PEM)" ""
  [ -r "$CDE_TLS_CERT" ] && [ -r "$CDE_TLS_KEY" ] || die "Sertifika veya anahtar dosyası okunamadı."
fi
ask ADMIN_EMAIL "İlk yöneticinin e-postası" ""
[[ "$ADMIN_EMAIL" == *@*.* ]] || die "Geçerli bir e-posta girin."
ask_secret ADMIN_PASSWORD "İlk yöneticinin şifresi (boş bırakılırsa üretilir, en az 10 karakter)"
GENERATED_PASSWORD=0
if [ -z "${ADMIN_PASSWORD:-}" ]; then ADMIN_PASSWORD="7D-$(rand_hex 8)"; GENERATED_PASSWORD=1; fi
[ "${#ADMIN_PASSWORD}" -ge 10 ] || die "Şifre en az 10 karakter olmalı."
ask CDE_LANGUAGE "Kurulum dili (tr / en)" "$CDE_LANGUAGE"
ask CDE_BACKUP_TIME "Gece yedeğinin saati (SS:DD)" "$CDE_BACKUP_TIME"
ask CDE_BACKUP_KEEP "Saklanacak yedek sayısı" "$CDE_BACKUP_KEEP"

scheme=https; [ "$CDE_TLS" = off ] && scheme=http
port_part=""
if [ "$scheme" = https ] && [ "$CDE_HTTPS_PORT" != 443 ]; then port_part=":$CDE_HTTPS_PORT"; fi
if [ "$scheme" = http ] && [ "$CDE_HTTP_PORT" != 80 ]; then port_part=":$CDE_HTTP_PORT"; fi
PUBLIC_URL="$scheme://$CDE_DOMAIN$port_part"

echo
info "Uygulama:  $CDE_HOME"
info "Veri:      $CDE_DATA (veritabanı, dosyalar, yedekler)"
info "Adres:     $PUBLIC_URL"
info "Yönetici:  $ADMIN_EMAIL"
confirm "Bu ayarlarla kurulsun mu?" || die "Kurulum durduruldu."
echo

# ---- 3. İmajlar ---------------------------------------------------------------------------------
bold "3/6 İmajlar yükleniyor (internet gerekmez)"
# shellcheck disable=SC1091
. "$HERE/images/IMAGES"   # APP_IMAGE, DB_IMAGE, PROXY_IMAGE
docker load -i "$HERE/images/images.tar.gz" | sed 's/^/  /'
for img in "$APP_IMAGE" "$DB_IMAGE" "$PROXY_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "Pakette imaj eksik: $img"
done
ok "İmajlar hazır"
echo

# ---- 4. Dosyalar ve sırlar ----------------------------------------------------------------------
bold "4/6 Yapılandırma"
umask 077
mkdir -p "$CDE_HOME/bin" "$CDE_HOME/config/certs" "$CDE_DATA"/{pgdata,app,caddy,backups}
# Uygulama konteynerde "node" kullanıcısıyla (uid 1000) yazar.
app_uid="$(docker run --rm --entrypoint id "$APP_IMAGE" -u)"
chown "$app_uid:$app_uid" "$CDE_DATA/app"
chmod 755 "$CDE_HOME" "$CDE_HOME/bin"
cp "$HERE/compose.yml" "$HERE/README.md" "$HERE/VERSION" "$CDE_HOME/"
cp "$HERE/sitekeep" "$CDE_HOME/bin/sitekeep"
chmod 755 "$CDE_HOME/bin/sitekeep"
chmod 644 "$CDE_HOME/compose.yml" "$CDE_HOME/README.md" "$CDE_HOME/VERSION"
ln -sf "$CDE_HOME/bin/sitekeep" /usr/local/bin/sitekeep

POSTGRES_PASSWORD="$(rand_hex 24)"
CDE_SECRET_KEY="$(rand_hex 32)"
INSTALLATION_ID="inst_$(rand_hex 12)"
secure=1; [ "$CDE_TLS" = off ] && secure=0

cat > "$CDE_HOME/.env" <<EOF
# Docker Compose değerleri (sitekeep komutu da okur). Elle değiştirdikten sonra: sitekeep restart
CDE_VERSION=$VERSION
CDE_HOME=$CDE_HOME
CDE_DATA=$CDE_DATA
CDE_DB_IMAGE=$DB_IMAGE
CDE_PROXY_IMAGE=$PROXY_IMAGE
CDE_HTTP_PORT=$CDE_HTTP_PORT
CDE_HTTPS_PORT=$CDE_HTTPS_PORT
CDE_PUBLIC_URL=$PUBLIC_URL
CDE_BACKUP_KEEP=$CDE_BACKUP_KEEP
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF

cat > "$CDE_HOME/config/app.env" <<EOF
# SiteKeep uygulama ayarları. Sırlar içerir: yalnız root okur. Değişiklikten sonra: sitekeep restart
DATABASE_URL=postgres://cde:$POSTGRES_PASSWORD@db:5432/cde
CDE_SECRET_KEY=$CDE_SECRET_KEY
CDE_PUBLIC_URL=$PUBLIC_URL
CDE_TRUST_PROXY=1
SECURE_COOKIES=$secure
CDE_DEFAULT_LANGUAGE=$CDE_LANGUAGE
TZ=${TZ:-$(cat /etc/timezone 2>/dev/null || echo Europe/Istanbul)}
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
# İsteğe bağlı entegrasyonlar (docs/features/FORMA_SYNC.md, docs/features/GOOGLE_SIGN_IN.md):
# AUTODESK_CLIENT_ID=
# AUTODESK_CLIENT_SECRET=
# AUTODESK_CALLBACK_URL=$PUBLIC_URL/api/v1/integrations/autodesk/callback
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_CALLBACK_URL=$PUBLIC_URL/api/v1/auth/google/callback
EOF
printf '%s\n' "$INSTALLATION_ID" > "$CDE_HOME/config/installation.id"

site="$CDE_DOMAIN"
case "$CDE_TLS" in
  auto) tls_line="" ;;
  internal) tls_line="	tls internal" ;;
  files)
    cp "$CDE_TLS_CERT" "$CDE_HOME/config/certs/cert.pem"
    cp "$CDE_TLS_KEY" "$CDE_HOME/config/certs/key.pem"
    chmod 644 "$CDE_HOME/config/certs/cert.pem"
    # Caddy konteynerde root değil; anahtarı okuyabilmeli (dizin yalnız root'a açık değil).
    chmod 644 "$CDE_HOME/config/certs/key.pem"
    tls_line="	tls /certs/cert.pem /certs/key.pem" ;;
  off) site=":80"; tls_line="" ;;
esac
cat > "$CDE_HOME/config/Caddyfile" <<EOF
# SiteKeep önündeki HTTPS vekili (Caddy). install.sh yazdı; HTTPS türü: $CDE_TLS
{
	admin off
}

$site {
$tls_line
	encode gzip
	reverse_proxy app:8080
}
EOF
chmod 755 "$CDE_HOME/config" "$CDE_HOME/config/certs"
chmod 644 "$CDE_HOME/config/Caddyfile"
ok "Şifreler, şifreleme anahtarı ve kurulum kimliği üretildi ($INSTALLATION_ID)"
echo

# ---- 5. Başlatma --------------------------------------------------------------------------------
bold "5/6 Servisler başlatılıyor"
cd "$CDE_HOME"
docker compose --env-file .env up -d 2>&1 | sed 's/^/  /'

app_id="$(docker compose --env-file .env ps -q app)"
healthy=0
for _ in $(seq 1 90); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id" 2>/dev/null || echo yok)"
  if [ "$status" = healthy ]; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" != 1 ]; then
  docker compose --env-file .env logs --tail 40 app >&2 || true
  die "Uygulama 3 dakikada sağlıklı olmadı (durum: $status). Günlük yukarıda; sitekeep logs ile izleyin."
fi
ok "SiteKeep çalışıyor"

# İlk yönetici oluştu; şifre artık dosyada durmasın.
sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' "$CDE_HOME/config/app.env"

if command -v curl >/dev/null 2>&1; then
  if [ "$scheme" = https ]; then
    probe="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$CDE_DOMAIN:$CDE_HTTPS_PORT:127.0.0.1" "https://$CDE_DOMAIN:$CDE_HTTPS_PORT/api/v1/health" || true)"
  else
    probe="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CDE_HTTP_PORT/api/v1/health" || true)"
  fi
  if [ "$probe" = 200 ]; then ok "Vekil üzerinden erişim tamam ($PUBLIC_URL)"
  else warn "Vekil üzerinden sağlık kontrolü $probe döndü. auto türünde sertifika birkaç dakika sürebilir: sitekeep logs proxy"; fi
fi

CA_FILE=""
if [ "$CDE_TLS" = internal ]; then
  for _ in $(seq 1 15); do
    if [ -f "$CDE_DATA/caddy/caddy/pki/authorities/local/root.crt" ]; then
      CA_FILE="$CDE_HOME/config/sitekeep-kok-sertifika.crt"
      cp "$CDE_DATA/caddy/caddy/pki/authorities/local/root.crt" "$CA_FILE"
      chmod 644 "$CA_FILE"
      break
    fi
    sleep 1
  done
fi
echo

# ---- 6. Yedek ve kayıt --------------------------------------------------------------------------
bold "6/6 Gece yedeği"
hh="${CDE_BACKUP_TIME%:*}"; mm="${CDE_BACKUP_TIME#*:}"
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/sitekeep-backup.service <<EOF
[Unit]
Description=SiteKeep gece yedeği
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sitekeep backup --scheduled
EOF
  cat > /etc/systemd/system/sitekeep-backup.timer <<EOF
[Unit]
Description=SiteKeep gece yedeği ($CDE_BACKUP_TIME)

[Timer]
OnCalendar=*-*-* $hh:$mm:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now sitekeep-backup.timer >/dev/null
  ok "Her gece $CDE_BACKUP_TIME (systemd: sitekeep-backup.timer), son $CDE_BACKUP_KEEP yedek saklanır"
elif [ -d /etc/cron.d ]; then
  printf '%s %s * * * root /usr/local/bin/sitekeep backup --scheduled >> /var/log/sitekeep-backup.log 2>&1\n' "$((10#$mm))" "$((10#$hh))" > /etc/cron.d/sitekeep-backup
  ok "Her gece $CDE_BACKUP_TIME (cron), son $CDE_BACKUP_KEEP yedek saklanır"
else
  warn "Zamanlayıcı bulunamadı (systemd / cron). Yedeği elle alın: sitekeep backup"
fi

cat > "$CDE_HOME/install.json" <<EOF
{ "version": "$VERSION", "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "installation": "$INSTALLATION_ID", "tls": "$CDE_TLS", "url": "$PUBLIC_URL" }
EOF
chmod 644 "$CDE_HOME/install.json"
echo

bold "Kurulum tamamlandı"
info "Adres:      $PUBLIC_URL"
info "Yönetici:   $ADMIN_EMAIL"
if [ "$GENERATED_PASSWORD" = 1 ]; then
  info "Şifre:      $ADMIN_PASSWORD   (bir kez gösterilir; ilk girişte değiştirin)"
fi
[ -n "$CA_FILE" ] && info "Kök sertifika: $CA_FILE (tarayıcı uyarısı çıkmasın diye istemcilere dağıtın)"
info "Yönetim:    sitekeep status | logs | backup | restore | upgrade | stop | start"
info "Ayarlar:    $CDE_HOME/config/app.env     Veri: $CDE_DATA"
