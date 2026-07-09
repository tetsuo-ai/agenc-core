# AgenC daemon container (TODO task 4).
#
# Build from the repo root (the build context must be the repo so the runtime
# workspace is available):
#
#   docker build -f packaging/docker/Dockerfile -t agenc:local .
#
# Run (state persists in the volume; loopback-only by default — the daemon
# refuses non-loopback WebSocket binds without an explicit override):
#
#   docker run -it -v agenc-data:/data -e XAI_API_KEY agenc:local
#   docker run -it -v agenc-data:/data agenc:local security audit
#
# Mirrors packages/agenc/scripts/build-runtime-tarball.mjs: build the runtime,
# `npm pack` it, prod-install the pack into a clean prefix so native deps
# (better-sqlite3, node-pty) compile for the image platform, then run from
# node_modules/@tetsuo-ai/runtime/bin/agenc — the same layout every other
# install path uses.

# --- build stage --------------------------------------------------------------
FROM node:25-bookworm AS build
WORKDIR /src
COPY . .
RUN npm ci \
  && npm run build --workspace=@tetsuo-ai/runtime \
  && cd runtime && npm pack --pack-destination /tmp \
  && mkdir -p /opt/agenc \
  && cd /opt/agenc \
  && npm install --omit=dev --no-audit --no-fund /tmp/tetsuo-ai-runtime-*.tgz

# --- runtime stage ------------------------------------------------------------
FROM node:25-slim
# gcc/libc6-dev: the daemon compiles its Unix-socket peer-credential
# binding (a small C addon) on first start and caches it under /data —
# without a compiler that socket-auth hardening is silently skipped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ripgrep git ca-certificates tini gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 agenc \
  && mkdir -p /data && chown agenc:agenc /data \
  && ln -sf /usr/bin/gcc /usr/local/bin/cc

COPY --from=build --chown=agenc:agenc /opt/agenc /opt/agenc
RUN printf '#!/bin/sh\nexec node /opt/agenc/node_modules/@tetsuo-ai/runtime/bin/agenc "$@"\n' \
      > /usr/local/bin/agenc \
  && chmod 755 /usr/local/bin/agenc

USER agenc
ENV AGENC_HOME=/data/.agenc \
    NODE_ENV=production
VOLUME ["/data"]
WORKDIR /data

ENTRYPOINT ["/usr/bin/tini", "--", "agenc"]
CMD ["daemon", "start", "--foreground"]
