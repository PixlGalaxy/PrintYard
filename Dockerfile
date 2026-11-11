# SliceDock — single container: Node backend serves the API and the built frontend.
# Base is Debian trixie (glibc >= 2.39) because the Creality Print engine (Phase 3)
# is an x86_64 glibc build; Alpine/musl cannot run it.

# ---------- Stage 1: frontend build ----------
FROM node:26-trixie-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# UI translations are imported from the shared locales/ folder
COPY locales/ /app/locales/
RUN npm run build

# ---------- Stage 2: backend build ----------
FROM node:26-trixie-slim AS backend-build
WORKDIR /app/backend
# Toolchain for native modules (better-sqlite3, argon2) when no prebuilt binary matches
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:26-trixie-slim

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="SliceDock" \
      org.opencontainers.image.description="Self-hosted web panel and slicer for Creality printers" \
      org.opencontainers.image.source="https://github.com/PixlGalaxy/SliceDock" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    PORT=3000 \
    APPDATA_ROOT=/appdata \
    DATA_ROOT=/data \
    PUID=99 \
    PGID=100 \
    UMASK=002 \
    APP_VERSION=${APP_VERSION}

# tini: PID 1 / signal handling · gosu: drop to PUID:PGID · wget: healthcheck
# util-linux: taskset (pins the slicer to all cores but one)
# The rest are the shared libraries the Creality Print engine links against.
# It runs headless (no X/xvfb) but the binary still needs them to load.
# The engine itself is downloaded at runtime into /appdata/engine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini gosu wget ca-certificates util-linux \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libegl1 libgl1 libglx0 libsm6 libice6 libatomic1 libdeflate0 libnss3 libnspr4 \
      libsoup-3.0-0 libtiff6 libwayland-client0 libwayland-cursor0 libwayland-egl1 \
      libwayland-server0 libxkbcommon0 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY --from=backend-build /app/backend/package*.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/resources ./resources
COPY locales/ /app/locales/
COPY --from=frontend-build /app/frontend/dist ./public
COPY LICENSE /app/LICENSE
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /appdata /data

VOLUME ["/appdata", "/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "/app/backend/dist/server.js"]
