# syntax=docker/dockerfile:1

# =============================================================================
# tcrs-derive — Node + a JVM, for Coolify.
#
# Two things in here are load-bearing and easy to lose in a refactor:
#   1. tini as ENTRYPOINT. Every KoLmafia JVM is spawned detached (setsid), so one
#      that outlives its parent is reparented to PID 1 — and Node as PID 1 does not
#      reap children. They would become zombies accumulating across runs until the
#      container hit its task limit. tini reaps them and forwards signals. Baking
#      it in here means it holds regardless of whether the platform passes --init.
#   2. The KoLmafia jar is fetched at BUILD time, so the image is self-contained and
#      never downloads at boot. It tracks the latest release by default; the build
#      records which one, and each run records it again in its manifest.
# =============================================================================

# --- deps --------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    yarn install --immutable

# --- build -------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN yarn react-router build

# --- the KoLmafia jar ---------------------------------------------------------
# Tracks the LATEST release by default. Set MAFIA_TAG to pin a specific one, e.g.
#   docker build --build-arg MAFIA_TAG=r29183 .
#
# Resolved through the GitHub API rather than a guessed filename: the tag is
# `r29183` but the asset is `KoLmafia-29183.jar`, so a constructed URL 404s.
#
# If you ever do pin, do not pin at or below r29131: it has a race in
# TCRSDatabase.save, which iterates the TCRS map while the derive's own worker
# threads are still mutating it, throwing ConcurrentModificationException. Observed
# effect was every one of the 54 permutations failing after 900-9200 items on all
# three attempts. Fixed by r29183.
FROM debian:bookworm-slim AS jar
ARG MAFIA_TAG=
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    if [ -n "${MAFIA_TAG}" ]; then \
      api="https://api.github.com/repos/kolmafia/kolmafia/releases/tags/${MAFIA_TAG}"; \
    else \
      api="https://api.github.com/repos/kolmafia/kolmafia/releases/latest"; \
    fi; \
    url="$(curl -fsSL "$api" \
      | jq -r '.assets[] | select(.name | endswith(".jar")) | .browser_download_url' | head -n1)"; \
    test -n "$url"; \
    echo "Fetching $url"; \
    curl -fsSL "$url" -o /tmp/KoLmafia.jar; \
    test -s /tmp/KoLmafia.jar

# --- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Debian bookworm's default openjdk-*-jre-headless is 17, and 21 only via
# backports; copying Temurin is deterministic and adds ~180MB.
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    PATH="/opt/java/openjdk/bin:${PATH}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build        ./build
COPY --from=build /app/src          ./src
COPY --from=build /app/app          ./app
COPY --from=build /app/server.ts    ./server.ts
COPY --from=build /app/package.json ./package.json
COPY --from=jar   /tmp/KoLmafia.jar ./KoLmafia.jar

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    JAR=/app/KoLmafia.jar \
    # 3 rather than the bash's 4: a container memory limit is a HARD ceiling where
    # a VPS's RAM is soft, and an OOM-killed JVM mid-derive costs a whole
    # permutation. Raise it once you have watched real RSS.
    CONCURRENCY=3 \
    COOLDOWN_HOURS=12 \
    FAILED_COOLDOWN_HOURS=1 \
    # Short-lived batch JVMs: cap the heap and skip the concurrent collector.
    JAVA_OPTS="-Xmx512m -XX:+UseSerialGC"

# Declared so a plain `docker run` without -v still starts; Coolify must mount a
# PERSISTENT volume here or every redeploy loses the dataset and the cooldown.
VOLUME /data

EXPOSE 3000
STOPSIGNAL SIGTERM

# See the note at the top of this file. This is not optional.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./server.ts"]

# Must stay 200 DURING a run: a 7.5-minute derive is not unhealthy, and a
# healthcheck that failed mid-run would have the platform restart the container
# and kill the batch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
