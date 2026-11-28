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
#   with LibreDWG, LIBREDWG-COPYING; with rvt-rs (not in Community), RVT-RS-LICENSE and RVT-RS-NOTICE.
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
      community) rm -rf node_modules/@sitekeephq/sitekeep-ee-* ;; \
      *) echo "EDITION must be community or enterprise" >&2; exit 1 ;; \
    esac
COPY packages packages
COPY apps apps
COPY tools/harden-dist.mjs tools/third-party-notices.mjs tools/
# Release hardening: compiled server code ships minified, without comments, source maps or type
# declarations; developer seed / load scripts stay out of the image (docs/onprem/installation-bundle.md).
# Modules (docs/modules/README.md) are published packages installed by npm ci: the server loads
# them by package name at run time, the web build bundles them. SITEKEEP_MODULES unset = all of them.
RUN npm run build -w @sitekeephq/bim-viewer \
 && npm run build -w @sitekeep/shared \
 && npm run build -w @sitekeep/cde-tools \
 && npm run build -w @sitekeephq/sitekeep-sdk \
 && npm run build -w @sitekeep/server \
 && npm run build -w @sitekeep/web \
 && npm run build -w @sitekeep/mcp \
 && rm -f apps/server/dist/scripts/seed-* apps/server/dist/scripts/assign-ui-load.* \
 && node tools/harden-dist.mjs apps/server/dist apps/mcp/dist packages/shared/dist packages/cde-tools/dist \
 && npm prune --omit=dev \
 && rm -rf node_modules/@tesseract.js-data/*/4.0.0 \
 && find node_modules/tesseract.js-core -maxdepth 1 -type f -name '*.wasm.js' -delete \
 && test -s node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz \
 && test -s node_modules/@tesseract.js-data/tur/4.0.0_best_int/tur.traineddata.gz \
 && if [ "$EDITION" = community ]; then \
      rm -rf node_modules/@sitekeephq/sitekeep-ee-* \
      && node tools/third-party-notices.mjs --ee-only | xargs -r rm -rf \
      && find node_modules -mindepth 1 -maxdepth 1 -name '@*' -type d -empty -delete; \
    else \
      node -e 'const fs=require("fs");const d=Object.keys(require("./apps/server/package.json").optionalDependencies).filter(n=>n.startsWith("@sitekeephq/sitekeep-ee-"));const m=d.filter(n=>!fs.existsSync("node_modules/"+n+"/package.json"));if(m.length){console.error("Enterprise modules missing from node_modules (nested in a workspace? check package-lock.json):",m.join(", "));process.exit(1)}'; \
    fi
# (again after prune: npm restores missing optional packages from its cache; the packages only the Enterprise
# modules need, such as @cursor/sdk, go too). Enterprise: every module the server depends on must be in the root
# node_modules, the only one copied into the image; a module npm nested under apps/* would silently be missing.
# OCR of scanned sheets (docs/features/SHEETS.md): tesseract.js runs a WebAssembly build of Tesseract in Node
# with the English and Turkish "best_int" models, all installed by npm ci (nothing is downloaded at run time).
# The legacy models and the browser builds (WebAssembly inlined in JavaScript) are removed, about 45 MB; the
# build stops if a model is missing.

# LibreDWG (GPL-3.0) dwg2dxf for DWG previews, built from the GNU release (0.14+: 0.13 writes MTEXT
# values broken over lines; the server repairs them, see docs/features/VIEWERS.md). The server runs it
# as a separate process (never linked). Skip with --build-arg WITH_LIBREDWG=0.
FROM debian:bookworm-slim AS libredwg
ARG WITH_LIBREDWG=1
ARG LIBREDWG_VERSION=0.14
# SHA-256 of libredwg-0.14.tar.xz; the GNU .sig was also checked against the GNU keyring (signed by
# Reini Urban, key 38A4167B0DB69E49C5F7216CB8C28866AB27A7A2). Change it together with LIBREDWG_VERSION.
ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
RUN mkdir -p /opt/libredwg/bin \
 && if [ "$WITH_LIBREDWG" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config xz-utils \
      && curl -fsSL "https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz" -o /tmp/libredwg.tar.xz \
      && echo "${LIBREDWG_SHA256}  /tmp/libredwg.tar.xz" | sha256sum -c - \
      && tar -xJf /tmp/libredwg.tar.xz -C /tmp \
      && cd "/tmp/libredwg-${LIBREDWG_VERSION}" \
      && ./configure --prefix=/opt/libredwg --disable-bindings --disable-python --disable-shared \
      && make -j"$(nproc)" \
      && make install-strip \
      && mkdir -p /opt/libredwg/legal \
      && cp COPYING /opt/libredwg/legal/LIBREDWG-COPYING; \
    fi \
 && mkdir -p /opt/libredwg/legal

# rvt-rs (Apache-2.0) rvt-ifc: Revit .rvt → IFC for SiteKeep Connect (docs/features/MODEL_FORMATS.md). The
# release's static Linux program, pinned and checked by SHA-256; the server runs it as a separate process.
# Community images leave it out (no Connect). Skip with --build-arg WITH_RVT_RS=0.
FROM debian:bookworm-slim AS rvtrs
ARG EDITION=
ARG WITH_RVT_RS=1
ARG TARGETARCH
ARG RVT_RS_VERSION=0.25.0
ARG RVT_RS_SHA256_AMD64=bfde9804b20a8006fe071584b793d3965735cf852e4828ce101fc96d9e48a8b7
ARG RVT_RS_SHA256_ARM64=a05eaead139586b49b87a314e50ad33e07305254581c13caffbce3e019ad6770
RUN mkdir -p /opt/rvt-rs/bin /opt/rvt-rs/legal \
 && if [ "$WITH_RVT_RS" = 1 ] && [ "$EDITION" != community ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
      && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
      && case "$arch" in \
           amd64) triple=x86_64-unknown-linux-musl; sum="$RVT_RS_SHA256_AMD64" ;; \
           arm64) triple=aarch64-unknown-linux-musl; sum="$RVT_RS_SHA256_ARM64" ;; \
           *) echo "rvt-rs: no release for $arch" >&2; exit 1 ;; \
         esac \
      && name="rvt-rs-v${RVT_RS_VERSION}-${triple}" \
      && curl -fsSL "https://github.com/DrunkOnJava/rvt-rs/releases/download/v${RVT_RS_VERSION}/${name}.tar.gz" -o /tmp/rvt-rs.tar.gz \
      && echo "${sum}  /tmp/rvt-rs.tar.gz" | sha256sum -c - \
      && tar -xzf /tmp/rvt-rs.tar.gz -C /tmp "${name}/rvt-ifc" "${name}/LICENSE" "${name}/NOTICE" \
      && install -m 755 "/tmp/${name}/rvt-ifc" /opt/rvt-rs/bin/rvt-ifc \
      && cp "/tmp/${name}/LICENSE" /opt/rvt-rs/legal/RVT-RS-LICENSE \
      && cp "/tmp/${name}/NOTICE" /opt/rvt-rs/legal/RVT-RS-NOTICE \
      && /opt/rvt-rs/bin/rvt-ifc --version \
      && rm -rf /tmp/rvt-rs.tar.gz "/tmp/${name}" /var/lib/apt/lists/*; \
    fi

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
COPY --from=rvtrs /opt/rvt-rs/bin/ /usr/local/bin/
COPY --from=rvtrs /opt/rvt-rs/legal/ /usr/share/sitekeep/
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
