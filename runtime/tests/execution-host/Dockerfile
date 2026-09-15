# Disposable Docker daemon host. Never mount the outer Docker socket or host
# cgroup filesystem here; the runner supplies a private cgroup namespace.
FROM docker:29.1.3-dind@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5
RUN apk add --no-cache python3 gcc musl-dev linux-headers
ENV DOCKER_TLS_CERTDIR=""
RUN mkdir -p /opt/agenc-execution/bin /etc/agenc-execution /var/lib/agenc-execution /run/agenc-execution \
    && wget -q https://github.com/opencontainers/runc/releases/download/v1.5.1/runc.amd64 -O /opt/agenc-execution/bin/runc-1.5.1 \
    && echo '177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f  /opt/agenc-execution/bin/runc-1.5.1' | sha256sum -c - \
    && chmod 755 /opt/agenc-execution/bin/runc-1.5.1
COPY native/execution-host/ /opt/agenc-execution/host/
COPY native/agenc-filesystem-worker.c /opt/agenc-execution/source/agenc-filesystem-worker.c
RUN cc -std=c11 -O2 -static -Wall -Wextra -Werror /opt/agenc-execution/source/agenc-filesystem-worker.c -o /opt/agenc-execution/bin/agenc-filesystem-worker
COPY native/agenc-task-launcher.c /opt/agenc-execution/source/agenc-task-launcher.c
RUN cc -std=c11 -O2 -static -Wall -Wextra -Werror /opt/agenc-execution/source/agenc-task-launcher.c -o /opt/agenc-execution/bin/agenc-task-launcher
COPY tests/execution-host/fixture-entry.py /opt/agenc-execution/bin/agenc-runc
RUN chmod 755 /opt/agenc-execution/bin/agenc-runc
