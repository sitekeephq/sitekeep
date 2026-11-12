#!/usr/bin/env bash
# Manual release (docs/onprem/releasing.md): builds the SiteKeep Community and SiteKeep Enterprise
# bundles of one version and puts everything to upload (Odoo site, customer portal) in one folder.
#
#   deploy/release.sh --version 1.0.0 [--out ~/SiteKeep-surumler] [--platform linux/amd64]
#                     [--skip-tests] [--smoke] [--push-images] [--tag]
#
#   --skip-tests   do not run typecheck and unit tests first
#   --smoke        install each bundle on an empty Linux server (Docker in Docker) before accepting it
#   --push-images  also push both images to ghcr.io (docker login ghcr.io first)
#   --tag          create the annotated git tag v<version> (not pushed)
#
# Needs: Node 22, Docker, a GitHub token with read:packages (NODE_AUTH_TOKEN, or `gh auth token`).
# Build on a Linux amd64 machine when you can: on Apple silicon the amd64 image is emulated and slow.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=""
OUT="$HOME/SiteKeep-surumler"
PLATFORM="linux/amd64"
TESTS=1
SMOKE=0
PUSH=0
TAG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --skip-tests) TESTS=0; shift ;;
    --smoke) SMOKE=1; shift ;;
    --push-images) PUSH=1; shift ;;
    --tag) TAG=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "--version 1.2.3 or 1.2.3-rc1 is required" >&2; exit 2; }
ARCH="${PLATFORM#linux/}"
step() { printf '\n==> %s\n' "$*"; }
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi

cd "$ROOT"
step "checks"
[ -z "$(git status --porcelain)" ] || { echo "the working tree has changes; commit or stash them first" >&2; exit 1; }
COMMIT="$(git rev-parse --short=7 HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = main ] || echo "warning: building from $BRANCH, not main"
if [ -z "${NODE_AUTH_TOKEN:-}" ]; then NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null || true)"; fi
[ -n "$NODE_AUTH_TOKEN" ] || { echo "NODE_AUTH_TOKEN (read:packages) is required" >&2; exit 1; }
export NODE_AUTH_TOKEN
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
DEST="$OUT/sitekeep-$VERSION"
[ ! -e "$DEST" ] || { echo "$DEST exists; remove it or choose another version" >&2; exit 1; }

if [ "$TESTS" = 1 ]; then
  step "typecheck and unit tests"
  npm ci
  npm run build
  npm run typecheck
  npm test
fi

mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for EDITION in community enterprise; do
  step "$EDITION bundle ($PLATFORM)"
  deploy/onprem/build-bundle.sh --edition "$EDITION" --version "$VERSION" --platform "$PLATFORM" --out "$WORK"
  NAME="sitekeep-$EDITION-$VERSION-linux-$ARCH"
  if [ "$SMOKE" = 1 ]; then
    step "$EDITION install smoke test"
    deploy/onprem/smoke-test.sh "$WORK/$NAME.tar.gz"
  fi
  mv "$WORK/$NAME.tar.gz" "$WORK/$NAME.tar.gz.sha256" "$DEST/"
  if [ "$PUSH" = 1 ]; then
    step "$EDITION image to ghcr.io"
    image="ghcr.io/sitekeephq/sitekeep"; [ "$EDITION" = enterprise ] && image="$image-enterprise"
    docker tag "sitekeep:$VERSION" "$image:$VERSION"
    docker push "$image:$VERSION"
    if [[ "$VERSION" != *-* ]]; then docker tag "sitekeep:$VERSION" "$image:latest" && docker push "$image:latest"; fi
  fi
done

step "SBOM and release notes"
npm sbom --sbom-format cyclonedx --omit dev > "$DEST/sitekeep-$VERSION-sbom.cdx.json"
sed -e "s/{{VERSION}}/$VERSION/g" -e "s/{{COMMIT}}/$COMMIT/g" -e "s/{{ARCH}}/$ARCH/g" deploy/onprem/release-notes.md > "$DEST/SURUM-NOTLARI.md"
(cd "$DEST" && "${SHA256[@]}" ./*.tar.gz ./*.json > SHA256SUMS)

if [ "$TAG" = 1 ]; then
  step "git tag v$VERSION"
  git tag -a "v$VERSION" -m "SiteKeep $VERSION"
  echo "push it when the release is out: git push origin v$VERSION"
fi

step "done: $DEST"
ls -lh "$DEST"
cat <<EOF

Upload to the Odoo site:
  SiteKeep Community  → sitekeep-community-$VERSION-linux-$ARCH.tar.gz (+ .sha256)  public download
  SiteKeep Enterprise → sitekeep-enterprise-$VERSION-linux-$ARCH.tar.gz (+ .sha256) customer portal only
Release notes: SURUM-NOTLARI.md · dependency list: sitekeep-$VERSION-sbom.cdx.json
Licences per sale: node tools/license/issue.mjs … (docs/onprem/lisanslama.md, top)
EOF
