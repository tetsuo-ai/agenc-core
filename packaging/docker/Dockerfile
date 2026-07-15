# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

# AgenC daemon container.
#
# Build from the repo root. Feed BuildKit the reviewed Git tree rather than the
# working directory: ignored credentials are invisible to `git status` and
# must never become `COPY` inputs.
#
#   test -z "$(git status --porcelain=v1 --untracked-files=all)"
#   commit="$(git rev-parse HEAD)"; epoch="$(git show -s --format=%ct HEAD)"
#   build_time="$(date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%S.000Z)"
#   version="$(node -p 'require("./package.json").version')"
#   git archive --format=tar HEAD | \
#     docker buildx build --load -f packaging/docker/Dockerfile -t agenc:local \
#     --build-arg AGENC_BUILD_COMMIT="$commit" \
#     --build-arg SOURCE_DATE_EPOCH="$epoch" \
#     --build-arg AGENC_BUILD_TIME="$build_time" \
#     --build-arg AGENC_VERSION="$version" -
#
# `npm run check:clean-build` is the acceptance path: it creates the
# digest-pinned BuildKit daemon from release-toolchain.json, exports two
# no-cache OCI layouts with timestamp rewriting, and compares every blob.
#
# Run (state persists in the volume; loopback-only by default — the daemon
# refuses non-loopback WebSocket binds without an explicit override):
#
#   docker run -it -v agenc-data:/data -e XAI_API_KEY agenc:local
#   docker run -it -v agenc-data:/data agenc:local security audit
#
# Uses packages/agenc/scripts/build-runtime-tarball.mjs so the image and public
# installers consume the same lockfile-derived, canonical runtime artifact.
# Native dependencies (better-sqlite3, node-pty) are installed for the image
# platform, then the artifact is extracted at /opt/agenc — the same layout
# every other install path uses.

# BuildKit uses this standard build argument to normalize image and layer
# timestamps. The clean-build gate proves that two no-cache builds have the
# same image identity.
ARG SOURCE_DATE_EPOCH

# --- build stage --------------------------------------------------------------
FROM node:25.9.0-bookworm@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b AS build
ARG AGENC_BUILD_COMMIT
ARG SOURCE_DATE_EPOCH
ARG AGENC_BUILD_TIME
ARG AGENC_VERSION
WORKDIR /opt/agenc-release-source
COPY . .
RUN node --input-type=module -e \
      'const p=JSON.parse(await import("node:fs").then(m=>m.readFileSync("package.json","utf8"))); const c=process.env.AGENC_BUILD_COMMIT; const e=process.env.SOURCE_DATE_EPOCH; const t=process.env.AGENC_BUILD_TIME; if(!/^[0-9a-f]{40,64}$/.test(c??"")||!/^[1-9][0-9]*$/.test(e??"")||t!==new Date(Number(e)*1000).toISOString()||process.env.AGENC_VERSION!==p.version) throw new Error("Docker build metadata must match the reviewed source version/commit/epoch");' \
  && node scripts/fetch-pinned-npm.mjs /tmp/npm-release.tgz \
  && node /usr/local/lib/node_modules/npm/bin/npm-cli.js install --global \
       /tmp/npm-release.tgz --prefix /usr/local --ignore-scripts --no-audit --no-fund \
  && rm -f /tmp/npm-release.tgz \
  && test "$(npm --version)" = "$(node -p 'require("./release-toolchain.json").npmVersion')" \
  && test -f /usr/local/include/node/node.h \
  && printf 'install-strategy=hoisted\nstrict-allow-scripts=true\n' \
       > /opt/agenc-release-source/.npmrc \
  && chmod 0644 /opt/agenc-release-source/.npmrc \
  && AGENC_SKIP_POSTINSTALL=1 CI=true \
     npm_config_build_from_source=true \
     npm_config_nodedir=/usr/local \
     npm_config_strict_allow_scripts=true \
     npm ci --no-audit --no-fund \
  && mkdir -p /tmp/agenc-native-cache /tmp/agenc-release \
       /opt/agenc /opt/agenc-native \
  && node --import tsx --input-type=module -e \
       'import { compileAndLoadAgenCNativePeerCredentialBinding } from "./runtime/src/app-server/transport/peer-credentials.ts"; compileAndLoadAgenCNativePeerCredentialBinding({ cacheDir: "/tmp/agenc-native-cache", nodeIncludeDir: "/usr/local/include/node", platform: "linux" });' \
  && native_addon="$(find /tmp/agenc-native-cache -type f \
       -name agenc-peer-credentials.node -print -quit)" \
  && test -n "$native_addon" \
  && install -m 0555 "$native_addon" \
       /opt/agenc-native/agenc-peer-credentials.node \
  && AGENC_BUILD_COMMIT="${AGENC_BUILD_COMMIT}" \
     AGENC_BUILD_TIME="${AGENC_BUILD_TIME}" \
     SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
     AGENC_ARTIFACT_PROFILE=container-local \
     AGENC_RELEASE_OUT_DIR=/tmp/agenc-release \
     npm_config_nodedir=/usr/local \
     npm --workspace=@tetsuo-ai/agenc run build:runtime-tarball \
  && tar -xzf /tmp/agenc-release/agenc-runtime-*.tar.gz -C /opt/agenc \
  && AGENC_BUILD_COMMIT="${AGENC_BUILD_COMMIT}" \
     AGENC_BUILD_TIME="${AGENC_BUILD_TIME}" \
     AGENC_VERSION="${AGENC_VERSION}" \
     node --input-type=module -e \
       'const p=JSON.parse(await import("node:fs").then(m=>m.readFileSync("/opt/agenc/node_modules/@tetsuo-ai/runtime/dist/VERSION","utf8"))); if(p.commit!==process.env.AGENC_BUILD_COMMIT||p.buildTime!==process.env.AGENC_BUILD_TIME||p.runtimeVersion!==process.env.AGENC_VERSION) throw new Error("embedded runtime VERSION is detached from Docker metadata");'

# --- runtime stage ------------------------------------------------------------
FROM node:25.9.0-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ARG AGENC_BUILD_COMMIT
ARG SOURCE_DATE_EPOCH
ARG AGENC_BUILD_TIME
ARG AGENC_VERSION
LABEL org.opencontainers.image.title="AgenC" \
      org.opencontainers.image.description="Daemon-backed coding-agent CLI" \
      org.opencontainers.image.source="https://github.com/tetsuo-ai/agenc-core" \
      org.opencontainers.image.revision="${AGENC_BUILD_COMMIT}" \
      org.opencontainers.image.version="${AGENC_VERSION}" \
      org.opencontainers.image.created="${AGENC_BUILD_TIME}" \
      org.opencontainers.image.licenses="MIT"
# The Unix-socket peer-credential addon is compiled in the build stage, then
# installed root-owned below. Writable state never becomes native code and the
# daemon fails closed if the configured addon cannot be loaded.
# The slim base intentionally has no CA bundle. Bootstrap HTTPS from the
# digest-pinned full image, then replace it with the exact package selected by
# the signed, timestamped Debian snapshot below.
RUN --mount=type=bind,from=build,source=/etc/ssl/certs/ca-certificates.crt,target=/mnt/bootstrap-ca-certificates.crt,readonly \
    --mount=type=bind,from=build,source=/opt/agenc-native,target=/mnt/agenc-native,readonly \
    --mount=type=bind,from=build,source=/opt/agenc-release-source/release-toolchain.json,target=/mnt/release-toolchain.json,readonly \
    --mount=type=bind,from=build,source=/opt/agenc,target=/mnt/agenc,readonly \
    set -eu \
  && install -D -m 0644 /mnt/bootstrap-ca-certificates.crt /etc/ssl/certs/ca-certificates.crt \
  && sources="$(node -e 'const c=JSON.parse(require("node:fs").readFileSync("/mnt/release-toolchain.json","utf8")); const {timestamp,repositories}=c.docker.debianSnapshot; if (!/^[0-9]{8}T[0-9]{6}Z$/.test(timestamp) || !Array.isArray(repositories) || !repositories.length) throw new Error("invalid Debian snapshot contract"); const token=/^[a-z0-9][a-z0-9-]*$/; if (repositories.some(({archive,suite,components}) => !/^(?:debian|debian-security)$/.test(archive) || !token.test(suite) || !Array.isArray(components) || !components.length || components.some((entry) => !token.test(entry)))) throw new Error("invalid Debian snapshot repository"); process.stdout.write(repositories.map(({archive,suite,components}) => `deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/${archive}/${timestamp}/ ${suite} ${components.join(" ")}`).join("\n"))')" \
  && packages="$(node -e 'const c=JSON.parse(require("node:fs").readFileSync("/mnt/release-toolchain.json","utf8")); const entries=Object.entries(c.docker.runtimePackages); if (!entries.length || entries.some(([name,version]) => !/^[a-z0-9][a-z0-9+.-]*$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/.test(version))) throw new Error("invalid pinned Debian package contract"); process.stdout.write(entries.map(([name,version]) => `${name}=${version}`).join(" "))')" \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' "$sources" > /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/* \
  && DEBIAN_FRONTEND=noninteractive apt-get \
       -o Acquire::Check-Valid-Until=false update --error-on=any \
  && DEBIAN_FRONTEND=noninteractive apt-get \
       -o Dpkg::Use-Pty=0 install -y --no-install-recommends $packages \
  && for package in $packages; do \
       name="${package%%=*}"; expected="${package#*=}"; \
       test "$(dpkg-query -W -f='${Version}' "$name")" = "$expected"; \
     done \
  && install -d -m 0755 /usr/share/agenc \
  && install -D -o root -g root -m 0555 \
       /mnt/agenc-native/agenc-peer-credentials.node \
       /usr/lib/agenc/agenc-peer-credentials.node \
  && printf 'required\n' > /usr/lib/agenc/peer-credentials-required \
  && chown root:root /usr/lib/agenc/peer-credentials-required \
  && chmod 0444 /usr/lib/agenc/peer-credentials-required \
  && dpkg-query -W -f='${binary:Package}=${Version}\n' \
       > /tmp/agenc-debian-packages.unsorted \
  && LC_ALL=C sort /tmp/agenc-debian-packages.unsorted \
       > /usr/share/agenc/debian-packages.txt \
  && rm -f /tmp/agenc-debian-packages.unsorted \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
  && rm -f /var/cache/ldconfig/aux-cache \
       /var/log/alternatives.log /var/log/apt/* /var/log/dpkg.log \
  && groupadd --gid 10001 agenc \
  && useradd --no-log-init --create-home --uid 10001 --gid 10001 \
       --shell /usr/sbin/nologin --password '!' agenc \
  && chage --lastday 0 agenc \
  && install -d -m 0700 -o agenc -g agenc /data \
  && cp -a /mnt/agenc /opt/agenc \
  && printf '#!/bin/sh\nexec node /opt/agenc/node_modules/@tetsuo-ai/runtime/bin/agenc "$@"\n' \
       > /usr/local/bin/agenc \
  && chmod 0755 /usr/local/bin/agenc \
  && find /data /etc /home /opt /root /tmp /usr /var -xdev \
       \( -path /etc/hostname -o -path /etc/hosts -o \
          -path /etc/resolv.conf -o -path /etc/mtab \) -prune -o \
       -newermt "@${SOURCE_DATE_EPOCH}" \
       -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + \
  && touch -d "@${SOURCE_DATE_EPOCH}" / /mnt

USER 10001:10001
ENV AGENC_HOME=/data/.agenc \
    HOME=/home/agenc \
    XDG_CACHE_HOME=/data/.cache \
    NODE_ENV=production
VOLUME ["/data"]
WORKDIR /data

ENTRYPOINT ["/usr/bin/tini", "--", "agenc"]
CMD ["daemon", "start", "--foreground"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["agenc", "daemon", "status"]
