#!/usr/bin/env bash
# SiteKeep installation wizard (Linux, Docker).
#
#   sudo ./install.sh                        interactive: asks questions
#   sudo ./install.sh --answers answers.env  unattended, from an answers file (automation, tests)
#
# Steps: pre-checks (Docker, CPU, memory, disk, ports) -> questions -> loads the images from the
# bundle (no internet needed) -> generates passwords and keys -> starts PostgreSQL + SiteKeep + the
# HTTPS proxy -> waits for health -> schedules the nightly backup -> installs the sitekeep command.
# Details: README.md, docs/onprem/installation-bundle.md.
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
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$ANSWERS" ]; then
  # Backward compatibility: the answers file used to be called cevap.env. If answers.env is missing
  # but an old cevap.env sits next to it (or in the bundle directory), use that.
  if [ ! -f "$ANSWERS" ] && [ "$(basename "$ANSWERS")" = answers.env ]; then
    for old in "$(dirname "$ANSWERS")/cevap.env" "$HERE/cevap.env"; do
      if [ -f "$old" ]; then
        echo "Note: $ANSWERS not found; using the old answers file $old (rename it to answers.env)." >&2
        ANSWERS="$old"
        break
      fi
    done
  fi
  [ -f "$ANSWERS" ] || { echo "Answers file not found: $ANSWERS" >&2; exit 2; }
  set -a
  # shellcheck disable=SC1090
  . "$ANSWERS"
  set +a
fi

CDE_HOME="${CDE_HOME:-/opt/sitekeep}"
CDE_DATA="${CDE_DATA:-/var/lib/sitekeep}"
CDE_HTTP_PORT="${CDE_HTTP_PORT:-80}"
CDE_HTTPS_PORT="${CDE_HTTPS_PORT:-443}"
CDE_LANGUAGE="${CDE_LANGUAGE:-en}"
CDE_BACKUP_KEEP="${CDE_BACKUP_KEEP:-14}"
CDE_BACKUP_TIME="${CDE_BACKUP_TIME:-02:30}"
CDE_USERS="${CDE_USERS:-50}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }

# ask VAR "Question" [default]: not asked if already set in the answers file / environment.
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
  read -r -p "  $1 [y/N]: " reply
  [[ "$reply" =~ ^[eEyY] ]]
}

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

bold "SiteKeep $VERSION installation"
echo

# ---- 1. Pre-checks -------------------------------------------------------------------------------
bold "1/6 Pre-checks"
[ "$(id -u)" = 0 ] || die "The installer must run as root: sudo ./install.sh"
[ "$(uname -s)" = Linux ] || die "This bundle is for Linux."
if [ -f "$CDE_HOME/.env" ]; then
  die "SiteKeep is already installed in $CDE_HOME. To install a new version: sudo sitekeep upgrade $HERE"
fi

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  info "Docker Engine and the Compose plugin are required: https://docs.docker.com/engine/install/"
  info "On a server with internet access, one command: curl -fsSL https://get.docker.com | sh"
  if [ "${CDE_INSTALL_DOCKER:-0}" = 1 ] || { [ "$ASSUME_YES" = 0 ] && confirm "Install Docker from the internet now?"; }; then
    curl -fsSL https://get.docker.com | sh || die "Docker installation failed."
  else
    die "Install Docker, then run the installer again."
  fi
fi
docker info >/dev/null 2>&1 || die "The Docker service is not running: systemctl start docker"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin (docker compose) is missing. Install Docker from the official repository."
ok "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short)"

ARCH="$(uname -m)"
BUNDLE_ARCH="$(cat "$HERE/ARCH" 2>/dev/null || echo amd64)"
case "$ARCH" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; esac
[ "$ARCH" = "$BUNDLE_ARCH" ] || die "This bundle is for $BUNDLE_ARCH; this server is $ARCH."

ask CDE_USERS "Estimated number of users" "$CDE_USERS"
# Capacity tiers (docs/onprem/capacity.md §4): users -> vCPU, RAM (GB), data disk (GB).
need_cpu=2; need_ram=8; need_disk=100; tier="Trial"
if [ "$CDE_USERS" -gt 200 ]; then need_cpu=16; need_ram=64; need_disk=2000; tier="Large"
elif [ "$CDE_USERS" -gt 50 ]; then need_cpu=8; need_ram=32; need_disk=1000; tier="Medium"
elif [ "$CDE_USERS" -gt 10 ]; then need_cpu=4; need_ram=16; need_disk=500; tier="Small"; fi
cpus="$(nproc)"
ram_gb="$(awk '/MemTotal/ {printf "%d", ($2/1024/1024)+0.5}' /proc/meminfo)"
mkdir -p "$CDE_DATA"
disk_gb="$(df -Pk "$CDE_DATA" | awk 'NR==2 {printf "%d", $4/1024/1024}')"
info "Server: $cpus vCPU, $ram_gb GB RAM, $disk_gb GB free on the data disk ($CDE_DATA)"
info "$tier tier ($CDE_USERS users): at least $need_cpu vCPU, $need_ram GB RAM, $need_disk GB disk"
short=""
[ "$cpus" -ge "$need_cpu" ] || short="$short CPU"
[ "$ram_gb" -ge "$need_ram" ] || short="$short memory"
[ "$disk_gb" -ge "$need_disk" ] || short="$short disk"
if [ -n "$short" ]; then
  warn "Below the recommendation:$short. Installation can continue, but SiteKeep will be slow under load."
  confirm "Install anyway?" || die "Installation cancelled."
else
  ok "Hardware meets the tier"
fi

port_busy() { command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
for p in "$CDE_HTTP_PORT" "$CDE_HTTPS_PORT"; do
  if port_busy "$p"; then die "Port $p is in use by another service. Choose another port with CDE_HTTP_PORT / CDE_HTTPS_PORT."; fi
done
ok "Ports free ($CDE_HTTP_PORT, $CDE_HTTPS_PORT)"
echo

# ---- 2. Questions -------------------------------------------------------------------------------
bold "2/6 Settings"
default_host="$(hostname -f 2>/dev/null || hostname)"
ask CDE_DOMAIN "Server address (domain name or IP; users type this into the browser)" "$default_host"
info "HTTPS: auto = public domain name + internet (Let's Encrypt)"
info "       internal = internal network; the installer creates the certificate (distribute the root certificate to clients)"
info "       files = your organisation's own certificate (PEM)   off = HTTP only (not recommended)"
ask CDE_TLS "HTTPS type (auto / internal / files / off)" "internal"
case "$CDE_TLS" in auto|internal|files|off) ;; *) die "HTTPS type must be auto, internal, files or off." ;; esac
if [ "$CDE_TLS" = files ]; then
  ask CDE_TLS_CERT "Certificate file (PEM, including the chain)" ""
  ask CDE_TLS_KEY "Private key file (PEM)" ""
  [ -r "$CDE_TLS_CERT" ] && [ -r "$CDE_TLS_KEY" ] || die "Cannot read the certificate or key file."
fi
ask ADMIN_EMAIL "First administrator's email" ""
[[ "$ADMIN_EMAIL" == *@*.* ]] || die "Enter a valid email address."
ask_secret ADMIN_PASSWORD "First administrator's password (at least 10 characters; leave empty to generate one)"
GENERATED_PASSWORD=0
if [ -z "${ADMIN_PASSWORD:-}" ]; then ADMIN_PASSWORD="SK-$(rand_hex 8)"; GENERATED_PASSWORD=1; fi
[ "${#ADMIN_PASSWORD}" -ge 10 ] || die "The password must be at least 10 characters."
ask CDE_LANGUAGE "Default language (en / tr)" "$CDE_LANGUAGE"
ask CDE_BACKUP_TIME "Nightly backup time (HH:MM)" "$CDE_BACKUP_TIME"
ask CDE_BACKUP_KEEP "Number of backups to keep" "$CDE_BACKUP_KEEP"

scheme=https; [ "$CDE_TLS" = off ] && scheme=http
port_part=""
if [ "$scheme" = https ] && [ "$CDE_HTTPS_PORT" != 443 ]; then port_part=":$CDE_HTTPS_PORT"; fi
if [ "$scheme" = http ] && [ "$CDE_HTTP_PORT" != 80 ]; then port_part=":$CDE_HTTP_PORT"; fi
PUBLIC_URL="$scheme://$CDE_DOMAIN$port_part"

echo
info "Application: $CDE_HOME"
info "Data:        $CDE_DATA (database, files, backups)"
info "Address:     $PUBLIC_URL"
info "Admin:       $ADMIN_EMAIL"
confirm "Install with these settings?" || die "Installation cancelled."
echo

# ---- 3. Images ---------------------------------------------------------------------------------
bold "3/6 Loading images (no internet needed)"
# shellcheck disable=SC1091
. "$HERE/images/IMAGES"   # APP_IMAGE, DB_IMAGE, PROXY_IMAGE
docker load -i "$HERE/images/images.tar.gz" | sed 's/^/  /'
for img in "$APP_IMAGE" "$DB_IMAGE" "$PROXY_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "Image missing from the bundle: $img"
done
ok "Images ready"
echo

# ---- 4. Files and secrets -----------------------------------------------------------------------
bold "4/6 Configuration"
umask 077
mkdir -p "$CDE_HOME/bin" "$CDE_HOME/config/certs" "$CDE_DATA"/{pgdata,app,caddy,backups}
# The application writes as the "node" user (uid 1000) inside the container.
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
# Docker Compose values (also read by the sitekeep command). After editing by hand: sitekeep restart
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
# SiteKeep application settings. Contains secrets: readable by root only. After changes: sitekeep restart
DATABASE_URL=postgres://cde:$POSTGRES_PASSWORD@db:5432/cde
CDE_SECRET_KEY=$CDE_SECRET_KEY
CDE_PUBLIC_URL=$PUBLIC_URL
CDE_TRUST_PROXY=1
SECURE_COOKIES=$secure
CDE_DEFAULT_LANGUAGE=$CDE_LANGUAGE
TZ=${TZ:-$(cat /etc/timezone 2>/dev/null || echo UTC)}
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
# Optional integrations (docs/features/FORMA_SYNC.md, docs/features/GOOGLE_SIGN_IN.md):
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
    # Caddy does not run as root in its container and must be able to read the key (the directory is not root-only).
    chmod 644 "$CDE_HOME/config/certs/key.pem"
    tls_line="	tls /certs/cert.pem /certs/key.pem" ;;
  off) site=":80"; tls_line="" ;;
esac
cat > "$CDE_HOME/config/Caddyfile" <<EOF
# HTTPS proxy (Caddy) in front of SiteKeep. Written by install.sh; HTTPS type: $CDE_TLS
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
ok "Passwords, encryption key and installation ID generated ($INSTALLATION_ID)"
echo

# ---- 5. Start -----------------------------------------------------------------------------------
bold "5/6 Starting services"
cd "$CDE_HOME"
docker compose --env-file .env up -d 2>&1 | sed 's/^/  /'

app_id="$(docker compose --env-file .env ps -q app)"
healthy=0
for _ in $(seq 1 90); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id" 2>/dev/null || echo missing)"
  if [ "$status" = healthy ]; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" != 1 ]; then
  docker compose --env-file .env logs --tail 40 app >&2 || true
  die "The application did not become healthy within 3 minutes (status: $status). Logs above; follow them with: sitekeep logs"
fi
ok "SiteKeep is running"

# The first administrator now exists; remove the password from the file.
sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' "$CDE_HOME/config/app.env"

if command -v curl >/dev/null 2>&1; then
  if [ "$scheme" = https ]; then
    probe="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$CDE_DOMAIN:$CDE_HTTPS_PORT:127.0.0.1" "https://$CDE_DOMAIN:$CDE_HTTPS_PORT/api/v1/health" || true)"
  else
    probe="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CDE_HTTP_PORT/api/v1/health" || true)"
  fi
  if [ "$probe" = 200 ]; then ok "Reachable through the proxy ($PUBLIC_URL)"
  else warn "Health check through the proxy returned $probe. With the auto type the certificate can take a few minutes: sitekeep logs proxy"; fi
fi

CA_FILE=""
if [ "$CDE_TLS" = internal ]; then
  for _ in $(seq 1 15); do
    if [ -f "$CDE_DATA/caddy/caddy/pki/authorities/local/root.crt" ]; then
      CA_FILE="$CDE_HOME/config/sitekeep-root-ca.crt"
      cp "$CDE_DATA/caddy/caddy/pki/authorities/local/root.crt" "$CA_FILE"
      chmod 644 "$CA_FILE"
      break
    fi
    sleep 1
  done
fi
echo

# ---- 6. Backup and record -----------------------------------------------------------------------
bold "6/6 Nightly backup"
hh="${CDE_BACKUP_TIME%:*}"; mm="${CDE_BACKUP_TIME#*:}"
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/sitekeep-backup.service <<EOF
[Unit]
Description=SiteKeep nightly backup
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sitekeep backup --scheduled
EOF
  cat > /etc/systemd/system/sitekeep-backup.timer <<EOF
[Unit]
Description=SiteKeep nightly backup ($CDE_BACKUP_TIME)

[Timer]
OnCalendar=*-*-* $hh:$mm:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now sitekeep-backup.timer >/dev/null
  ok "Every night at $CDE_BACKUP_TIME (systemd: sitekeep-backup.timer), keeping the last $CDE_BACKUP_KEEP backups"
elif [ -d /etc/cron.d ]; then
  printf '%s %s * * * root /usr/local/bin/sitekeep backup --scheduled >> /var/log/sitekeep-backup.log 2>&1\n' "$((10#$mm))" "$((10#$hh))" > /etc/cron.d/sitekeep-backup
  ok "Every night at $CDE_BACKUP_TIME (cron), keeping the last $CDE_BACKUP_KEEP backups"
else
  warn "No scheduler found (systemd / cron). Take backups by hand: sitekeep backup"
fi

cat > "$CDE_HOME/install.json" <<EOF
{ "version": "$VERSION", "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "installation": "$INSTALLATION_ID", "tls": "$CDE_TLS", "url": "$PUBLIC_URL" }
EOF
chmod 644 "$CDE_HOME/install.json"
echo

bold "Installation complete"
info "Address:    $PUBLIC_URL"
info "Admin:      $ADMIN_EMAIL"
if [ "$GENERATED_PASSWORD" = 1 ]; then
  info "Password:   $ADMIN_PASSWORD   (shown once; change it at first sign-in)"
fi
[ -n "$CA_FILE" ] && info "Root certificate: $CA_FILE (distribute it to clients to avoid browser warnings)"
info "Manage:     sitekeep status | logs | backup | restore | upgrade | stop | start"
info "Settings:   $CDE_HOME/config/app.env     Data: $CDE_DATA"
