# syntax=docker/dockerfile:1.7
# SiteKeep — single image: API server + web app.
#
# --build-arg EDITION (release plan B-3, docs/product/YAYIN_PLANI.md):
#   community   the core only: the Enterprise module packages are removed before the build, so no closed
#               code is in the image (SiteKeep Community, AGPL-3.0)
#   enterprise  the core and every Enterprise module; licences decide which modules are on
#               (SITEKEEP_LICENSE_ENFORCE follows, src/license/state.ts)
#   (empty)     our own installations: every installed module on, no licence check (today's live server)
# --build-arg BUILD_DATE (ISO date): builds after a licence's support end are not covered by it.
# --build-arg SITEKEEP_VERSION (release version, e.g. 1.0.0) and SOURCE_COMMIT (git commit): the About page
#   shows the version and links to its source (AGPL-3.0 §13): tag v<version> for a release, else the repository.
# Licence texts go to /usr/share/sitekeep: LICENSE, THIRD_PARTY_NOTICES.md (tools/third-party-notices.mjs) and,
#   with LibreDWG, LIBREDWG-COPYING.
FROM node:22-bookworm-slim AS build
ARG EDITION=

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cde-tools/package.json packages/cde-tools/
COPY packages/sdk/package.json packages/sdk/
COPY packages/bim-viewer/package.json packages/bim-viewer/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/
# SheetJS CE is fetched from cdn.sheetjs.com (see package-lock.json), the rest from npm.
# The private viewer package token is mounted only for this install step and never copied into an image layer.
RUN npm ci
RUN case "$EDITION" in \
      ""|enterprise) ;; \
      community) rm -rf node_modules/@7dimensions-project/sitekeep-ee-* ;; \
      *) echo "EDITION must be community or enterprise" >&2; exit 1 ;; \
    esac
COPY packages packages
COPY apps apps
COPY tools/harden-dist.mjs tools/third-party-notices.mjs tools/
# Release hardening: compiled server code ships minified, without comments, source maps or type
# declarations; developer seed / load scripts stay out of the image (docs/onprem/installation-bundle.md).
# Modules (docs/modules/README.md) are published packages installed by npm ci: the server loads
# them by package name at run time, the web build bundles them. SITEKEEP_MODULES unset = all of them.
RUN npm run build -w @7dimensions-project/bim-viewer \
 && npm run build -w @sitekeep/shared \
 && npm run build -w @sitekeep/cde-tools \
 && npm run build -w @7dimensions-project/sitekeep-sdk \
 && npm run build -w @sitekeep/server \
 && npm run build -w @sitekeep/web \
 && npm run build -w @sitekeep/mcp \
 && rm -f apps/server/dist/scripts/seed-* apps/server/dist/scripts/assign-ui-load.* \
 && node tools/harden-dist.mjs apps/server/dist apps/mcp/dist packages/shared/dist packages/cde-tools/dist \
 && npm prune --omit=dev \
 && if [ "$EDITION" = community ]; then \
      rm -rf node_modules/@7dimensions-project/sitekeep-ee-* \
      && node tools/third-party-notices.mjs --ee-only | xargs -r rm -rf \
      && find node_modules -mindepth 1 -maxdepth 1 -name '@*' -type d -empty -delete; \
    fi
# (again after prune: npm restores missing optional packages from its cache; the packages only the Enterprise
# modules need, such as @cursor/sdk, go too)

# LibreDWG (GPL-3.0) dwg2dxf for DWG previews, built from the GNU release (0.14+: 0.13 writes MTEXT
# values broken over lines; the server repairs them, see docs/features/VIEWERS.md). The server runs it
# as a separate process (never linked). Skip with --build-arg WITH_LIBREDWG=0.
FROM debian:bookworm-slim AS libredwg
ARG WITH_LIBREDWG=1
ARG LIBREDWG_VERSION=0.14
RUN mkdir -p /opt/libredwg/bin \
 && if [ "$WITH_LIBREDWG" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config xz-utils \
      && curl -fsSL "https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz" -o /tmp/libredwg.tar.xz \
      && tar -xJf /tmp/libredwg.tar.xz -C /tmp \
      && cd "/tmp/libredwg-${LIBREDWG_VERSION}" \
      && ./configure --prefix=/opt/libredwg --disable-bindings --disable-python --disable-shared \
      && make -j"$(nproc)" \
      && make install-strip \
      && mkdir -p /opt/libredwg/legal \
      && cp COPYING /opt/libredwg/legal/LIBREDWG-COPYING; \
    fi \
 && mkdir -p /opt/libredwg/legal

FROM node:22-bookworm-slim
ARG EDITION=
ARG BUILD_DATE=
ARG SITEKEEP_VERSION=
ARG SOURCE_COMMIT=
LABEL org.opencontainers.image.title="SiteKeep" \
      org.opencontainers.image.vendor="7Dimensions OÜ" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/sitekeephq/sitekeep" \
      org.opencontainers.image.version="${SITEKEEP_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      eu.7dimensions.sitekeep.edition="${EDITION}" \
      org.opencontainers.image.created="${BUILD_DATE}"
WORKDIR /app
# No LibreOffice here: office files open in the browser viewers; editing (WOPI) and office → PDF
# conversion come from optional services (ONLYOFFICE Docs, Collabora Online or Gotenberg, see
# docker-compose.yml profiles and docs/features/OFFICE_INTEGRATION.md).
COPY --from=libredwg /opt/libredwg/bin/ /usr/local/bin/
COPY --from=libredwg /opt/libredwg/legal/ /usr/share/sitekeep/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/sitekeep/
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist \
    SITEKEEP_EDITION=${EDITION} \
    SITEKEEP_BUILD_DATE=${BUILD_DATE} \
    SITEKEEP_VERSION=${SITEKEEP_VERSION} \
    SITEKEEP_SOURCE_COMMIT=${SOURCE_COMMIT}
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/cde-tools/package.json packages/cde-tools/
COPY --from=build /app/packages/cde-tools/dist packages/cde-tools/dist
# The SDK the modules import (node_modules links here); the modules themselves are in node_modules.
COPY --from=build /app/packages/sdk/package.json /app/packages/sdk/server.js /app/packages/sdk/shared.js packages/sdk/
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/server/templates apps/server/templates
COPY --from=build /app/apps/server/assets apps/server/assets
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/apps/mcp/package.json apps/mcp/
COPY --from=build /app/apps/mcp/dist apps/mcp/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
