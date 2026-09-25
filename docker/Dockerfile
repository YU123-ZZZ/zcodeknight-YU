# ZcodeKnight — container image.
#
# Two stages so the runtime image carries no build tooling:
#   1. compile the engine into one self-contained binary
#   2. copy just that binary into a slim base
#
# Everything this file needs is IN THIS FOLDER (src/, package.json, bun.lock,
# logo.svg), so the build context is docker/ itself and the folder can be copied
# to any machine with Docker and built there.
#
# The compile runs on `oven/bun`, whose architecture matches the image's, so it
# is a NATIVE build rather than a cross-build. That matters: `bun build
# --compile --target bun-linux-x64` requires Bun to download the Linux runtime,
# which fails on a restricted network — and produces a binary for an
# architecture the build host may not be. Letting BuildKit select the base
# image per platform is both simpler and more reliable.
FROM oven/bun:1.4.2 AS build
WORKDIR /src

# `bun.lock` is copied too: without it `bun install` resolves fresh versions and
# the image can silently differ from a local build. `bunfig.toml` carries the
# registry mirror setting.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --production

COPY src ./src
RUN bun build --compile --define "require.resolve=undefined" src/index.ts --outfile /out/zcodeknight

FROM debian:bookworm-slim
# `ca-certificates` is required: every upstream call is HTTPS.
RUN apt-get update  && apt-get install -y --no-install-recommends ca-certificates curl  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/zcodeknight ./ZcodeKnight

# Static assets the panel serves at runtime. These are NOT compiled into the
# binary — they are read from disk per request — so a binary-only image answers
# 404 for every one of them:
#   logo.svg   the panel mark, shared by the sidebar, login screen and favicon
#              (one file by design; see routes-admin.ts). Present only in the
#              published tree; the clean copy has no mark and its panel is
#              rewritten to text-only branding, so this COPY is conditional.
# The panel HTML itself (src/server/admin.txt, webui.txt) and the system-prompt
# sidecar (src/proxy/zcode_system.json) are `import ... with { type: "text"|"json" }`,
# so Bun inlines them at compile time and they are NOT needed here.
COPY logo.svg ./logo.svg

# The donate/support QR the panel serves at /donate.png. Present only in the
# published (source) tree; the clean copy has no docs/ and omits this line.
COPY docs ./docs

# No config.yaml is baked in. Two reasons:
#   1. `.dockerignore` excludes it (it holds the proxy key and device identity),
#      so a `COPY config.yaml` would fail the build outright.
#   2. The engine writes a template config on first run when the path is
#      missing, which is exactly the behaviour a fresh container wants.
# The compose file mounts the operator's config over this path.
RUN mkdir -p /app/data

# Bind all interfaces inside the container: the engine defaults to 127.0.0.1,
# and a loopback-only bind makes the published port unreachable. Compose sets
# ZCODE_PROXY_HOST=0.0.0.0 for exactly this reason.
#
# The config path is a directory mount point in compose (see docker-compose.yml):
# mounting a single file that does not exist yet makes Docker create a directory
# in its place, which the engine then cannot read. A directory always works and
# the engine writes its template config into it on first run.
ENV ZCODE_PROXY_CONFIG=/app/config/config.yaml
EXPOSE 17800

# Liveness probe against the panel API.
#
# `admin` is accepted by the engine as a built-in fallback key even when
# config.yaml sets a real proxyApiKey (see panel-session.ts:checkAdminKey), so
# this passes on a fresh container AND on a configured one without the operator
# having to tell the healthcheck their key. That is deliberate: the probe's job
# is "is the engine answering", not "is the key right" — a wrong key must not
# make an otherwise healthy container restart-loop.
#
# ZCODE_HEALTH_KEY overrides it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3   CMD curl -fsS -o /dev/null -H "Authorization: Bearer ${ZCODE_HEALTH_KEY:-admin}" http://127.0.0.1:17800/admin/api/overview || exit 1

ENTRYPOINT ["/app/ZcodeKnight", "--cli", "serve"]
