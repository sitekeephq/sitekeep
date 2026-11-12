#!/usr/bin/env bash
# Builds the on-prem installation bundle (docs/onprem/installation-bundle.md):
#
#   deploy/onprem/build-bundle.sh [--edition enterprise|community] [--version 1.0.0] [--platform linux/amd64] [--out dist-bundle]
#
# Output: <out>/sitekeep-<edition>-<version>-linux-<arch>.tar.gz with the application image (minified server,
# no sources), PostgreSQL and Caddy images, install.sh, the sitekeep command and the README. The
# customer server needs Docker only; nothing is pulled there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION=""
EDITION="enterprise"
PLATFORM="linux/amd64"
OUT="$ROOT/dist-bundle"
DB_IMAGE="postgres:17"
PROXY_IMAGE="caddy:2"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --edition) EDITION="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$VERSION" ] || VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || date +%Y%m%d)"
case "$EDITION" in community|enterprise) ;; *) echo "--edition must be community or enterprise" >&2; exit 2 ;; esac
ARCH="${PLATFORM#linux/}"
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
NAME="sitekeep-$EDITION-$VERSION-linux-$ARCH"
STAGE="$OUT/$NAME"
APP_IMAGE="sitekeep:$VERSION"

echo "==> $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/images"

echo "==> application image $APP_IMAGE ($EDITION, $PLATFORM)"
DOCKER_BUILDKIT=1 docker build --platform "$PLATFORM" \
  --build-arg EDITION="$EDITION" --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "$APP_IMAGE" "$ROOT"

echo "==> base images"
for img in "$DB_IMAGE" "$PROXY_IMAGE"; do docker pull --platform "$PLATFORM" "$img"; done

# The bundle carries no source: check the image before it goes out.
leaks="$(docker run --rm --platform "$PLATFORM" --entrypoint sh "$APP_IMAGE" -c \
  'find /app/apps /app/packages -path "*/node_modules" -prune -o \( -name "*.ts" ! -name "*.d.ts" -o -name "*.map" -o -name "*.tsx" \) -print | head -5')"
[ -z "$leaks" ] || { echo "source files found in the image:"; echo "$leaks"; exit 1; }
# SiteKeep Community carries no closed module code.
if [ "$EDITION" = community ]; then
  ee="$(docker run --rm --platform "$PLATFORM" --entrypoint sh "$APP_IMAGE" -c 'ls -d /app/node_modules/@7dimensions-project/sitekeep-ee-* 2>/dev/null | head -3')"
  [ -z "$ee" ] || { echo "Enterprise modules found in the Community image:"; echo "$ee"; exit 1; }
fi

echo "==> saving images"
docker save "$APP_IMAGE" "$DB_IMAGE" "$PROXY_IMAGE" | gzip -6 > "$STAGE/images/images.tar.gz"
cat > "$STAGE/images/IMAGES" <<EOF
APP_IMAGE=$APP_IMAGE
DB_IMAGE=$DB_IMAGE
PROXY_IMAGE=$PROXY_IMAGE
EOF

cp "$ROOT/deploy/onprem/payload/install.sh" "$ROOT/deploy/onprem/payload/sitekeep" \
   "$ROOT/deploy/onprem/payload/compose.yml" "$ROOT/deploy/onprem/payload/README.md" \
   "$ROOT/deploy/onprem/payload/cevap.env.example" "$STAGE/"
chmod 755 "$STAGE/install.sh" "$STAGE/sitekeep"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
printf '%s\n' "$EDITION" > "$STAGE/EDITION"
printf '%s\n' "$ARCH" > "$STAGE/ARCH"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 "${SHA256[@]}" > SHA256SUMS)

tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && "${SHA256[@]}" "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "==> $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
