#!/usr/bin/env bash
# On-prem bundle smoke test (docs/onprem/installation-bundle.md): an empty Linux "server" (docker:dind)
# gets the bundle and goes through what a customer's IT does.
#
#   deploy/onprem/smoke-test.sh <bundle .tar.gz>
#
# install (answers file) → HTTPS health → sign-in → project + file upload → backup → delete →
# restore (file back) → upgrade → broken upgrade rolls back → uninstall. Exit 0 = all passed.
set -euo pipefail

BUNDLE="${1:?usage: smoke-test.sh <bundle .tar.gz>}"
VM="cde-smoke-$$"
DOMAIN="cde.sirket.test"
EMAIL="bt@sirket.test"
PASSWORD="Smoke-Test-2026"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
vm() { docker exec -i "$VM" bash -c "$1"; }
cleanup() { docker rm -f "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

step "Empty server"
# The server's architecture follows the bundle (an amd64 bundle on an Apple silicon Mac runs emulated).
ARCH="$(basename "$BUNDLE" .tar.gz)"; ARCH="${ARCH##*-}"
docker run -d --privileged --platform "linux/$ARCH" --name "$VM" -e DOCKER_TLS_CERTDIR= docker:25-dind >/dev/null
for _ in $(seq 1 60); do docker exec "$VM" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$VM" apk add --no-cache bash curl coreutils >/dev/null
docker cp "$BUNDLE" "$VM:/root/bundle.tar.gz"
NAME="$(basename "$BUNDLE" .tar.gz)"
vm "cd /root && tar -xzf bundle.tar.gz && cd $NAME && sha256sum -c SHA256SUMS >/dev/null" || fail "bundle checksum"
pass "server ready, bundle verified"

step "Install (answers file)"
vm "cat > /root/cevap.env <<EOF
CDE_DOMAIN=$DOMAIN
CDE_TLS=internal
ADMIN_EMAIL=$EMAIL
ADMIN_PASSWORD=$PASSWORD
CDE_USERS=5
CDE_BACKUP_KEEP=3
EOF
cd /root/$NAME && ./install.sh --answers /root/cevap.env"
pass "installed"

CURL="curl -sk --resolve $DOMAIN:443:127.0.0.1"
API="https://$DOMAIN/api/v1"
[ "$(vm "$CURL -o /dev/null -w '%{http_code}' $API/health")" = 200 ] || fail "HTTPS health"
vm "grep -q '^ADMIN_PASSWORD=$' /opt/sitekeep/config/app.env" || fail "admin password left in app.env"
[ "$(vm "stat -c %a /opt/sitekeep/config/app.env")" = 600 ] || fail "app.env permissions"
vm "test -s /opt/sitekeep/config/sitekeep-kok-sertifika.crt" || fail "internal root certificate exported"
vm "! docker exec sitekeep-app-1 sh -c 'find /app/apps /app/packages -path \"*/node_modules\" -prune -o -name \"*.map\" -print -o -name \"*.ts\" ! -name \"*.d.ts\" -print' | grep -q ." || fail "source files in the image"
pass "HTTPS, secrets, root certificate, no sources in the image"

step "Sign-in, project, upload"
vm "$CURL -c /root/jar -H 'content-type: application/json' -d '{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}' $API/auth/login -o /dev/null -w '%{http_code}'" | grep -q 200 || fail "sign-in"

# The edition of the bundle (EDITION file): Enterprise checks licences (no licence yet: no module on),
# Community has no modules at all.
EDITION="$(vm "cat /root/$NAME/EDITION 2>/dev/null || echo enterprise")"
INFO="$(vm "$CURL $API/app-info")"
case "$INFO" in *'"modules":[]'*) ;; *) fail "modules on without a licence: $INFO" ;; esac
LIC="$(vm "$CURL -b /root/jar $API/admin/license")"
if [ "$EDITION" = enterprise ]; then want=true; else want=false; fi
case "$LIC" in *"\"enforced\":$want"*) ;; *) fail "licence enforcement for $EDITION: $LIC" ;; esac
pass "$EDITION edition: no module on without a licence, licence checks $([ $want = true ] && echo on || echo off)"
PROJECT="$(vm "$CURL -b /root/jar -H 'content-type: application/json' -d '{\"code\":\"SMK\",\"name\":\"Smoke\",\"template\":\"empty\"}' $API/projects")"
PID="$(printf '%s' "$PROJECT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
ROOT="$(printf '%s' "$PROJECT" | sed -n 's/.*"rootFolderId":"\([^"]*\)".*/\1/p')"
[ -n "$PID" ] && [ -n "$ROOT" ] || fail "project create: $PROJECT"
FOLDER="$(vm "$CURL -b /root/jar -H 'content-type: application/json' -d '{\"parentId\":\"$ROOT\",\"name\":\"Dokumanlar\"}' $API/projects/$PID/folders" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
vm "echo 'kurulum testi' > /root/not.txt && $CURL -b /root/jar -F file=@/root/not.txt $API/projects/$PID/folders/$FOLDER/files" | grep -q '"ok":true' || fail "upload"
files() { vm "$CURL -b /root/jar $API/projects/$PID/folders/$FOLDER/contents" | grep -o '"name":"not.txt"' | wc -l | tr -d ' '; }
[ "$(files)" = 1 ] || fail "uploaded file listed"
pass "signed in, project created, file uploaded"

step "Backup, delete, restore"
vm "sitekeep backup" >/dev/null
BACKUP="$(vm "sitekeep backups" | awk 'NR==1 {print $1}')"
[ -n "$BACKUP" ] || fail "backup listed"
FILE_ID="$(vm "$CURL -b /root/jar $API/projects/$PID/folders/$FOLDER/contents" | sed -n 's/.*"files":\[{"id":"\([^"]*\)".*/\1/p')"
vm "$CURL -b /root/jar -X DELETE $API/projects/$PID/files/$FILE_ID -o /dev/null"
[ "$(files)" = 0 ] || fail "file deleted"
vm "sitekeep restore $BACKUP --yes" >/dev/null
vm "$CURL -c /root/jar -H 'content-type: application/json' -d '{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}' $API/auth/login -o /dev/null"
[ "$(files)" = 1 ] || fail "file back after restore"
pass "backup $BACKUP restored the deleted file"

step "Upgrade"
OLD="$(vm "cat /root/$NAME/VERSION")"
make_bundle() { # $1 version, $2 image tag source command
  vm "set -e; rm -rf /root/up-$1 && cp -r /root/$NAME /root/up-$1 && cd /root/up-$1
      echo $1 > VERSION
      sed -i 's|^APP_IMAGE=.*|APP_IMAGE=sitekeep:$1|' images/IMAGES
      . images/IMAGES
      $2
      docker save sitekeep:$1 \$DB_IMAGE \$PROXY_IMAGE | gzip -1 > images/images.tar.gz"
}
make_bundle 9.9.9-next "docker tag sitekeep:$OLD sitekeep:9.9.9-next"
vm "sitekeep upgrade /root/up-9.9.9-next" >/dev/null || fail "upgrade"
vm "grep -q '^CDE_VERSION=9.9.9-next' /opt/sitekeep/.env" || fail "version after upgrade"
running() { vm "docker inspect -f '{{.Config.Image}}' sitekeep-app-1"; }
[ "$(running)" = "sitekeep:9.9.9-next" ] || fail "running image after upgrade: $(running)"
[ "$(files)" = 1 ] || fail "data after upgrade"
pass "$OLD → 9.9.9-next, data intact"

step "Broken upgrade rolls back"
make_bundle 9.9.10-broken "printf 'FROM sitekeep:9.9.9-next\nCMD [\"node\",\"-e\",\"process.exit(1)\"]\n' | docker build -q -t sitekeep:9.9.10-broken - >/dev/null"
if out="$(vm "sitekeep upgrade /root/up-9.9.10-broken" 2>&1)"; then
  printf '%s\n' "$out" | tail -20
  vm "docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'; docker inspect -f '{{json .State.Health}}' sitekeep-app-1 | head -c 600"
  fail "broken upgrade reported success"
fi
vm "grep -q '^CDE_VERSION=9.9.9-next' /opt/sitekeep/.env" || fail "version after rollback"
[ "$(running)" = "sitekeep:9.9.9-next" ] || fail "running image after rollback: $(running)"
[ "$(vm "$CURL -o /dev/null -w '%{http_code}' $API/health")" = 200 ] || fail "health after rollback"
[ "$(files)" = 1 ] || fail "data after rollback"
pass "rolled back to 9.9.9-next"

step "Uninstall (data kept)"
vm "echo kaldır | sitekeep uninstall" >/dev/null
vm "test -d /var/lib/sitekeep/pgdata && test -f /opt/sitekeep/config/app.env && ! test -e /usr/local/bin/sitekeep" || fail "uninstall"
pass "services removed, data and settings kept"

printf '\n\033[32mSmoke test passed.\033[0m\n'
