# syntax=docker/dockerfile:1.7
# Multi-stage build for atelier-api. Pinned to oven/bun:1.4.4 exact tag so
# the runtime image matches the Bun version pinned in root package.json
# engines. Two details matter here:
#   - the runtime base (debian:trixie under the hood) has no wget/curl, so
#     the previous wget-based HEALTHCHECK silently marked the container
#     unhealthy and blocked atelier-web from starting (depends_on
#     service_healthy)
#   - Bun's default `isolated` linker for v1 workspaces puts api's runtime
#     deps under /app/api/node_modules/, NOT /app/node_modules/. The
#     previous Dockerfile only copied root node_modules, so `bun run
#     src/server.ts` failed with `Cannot find module 'hono'` on a clean
#     build context (or "worked" by accident if the host had a stale local
#     install of node_modules to leak through the build context).
# Both fixes land below.

FROM oven/bun:1.4.4 AS deps

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
COPY shared/package.json ./shared/package.json
COPY patches ./patches

RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4 AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF

WORKDIR /app
ENV NODE_ENV=production

# Copy BOTH the root and the per-workspace node_modules. With Bun's
# isolated linker, runtime deps for the api workspace (hono, pino, ulid,
# zod, @atelier/shared symlink) live under /app/api/node_modules/ and the
# root /app/node_modules/ holds only shared cache + dev tooling. Copying
# only the root would crash the api at startup.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
# The `shared` workspace has one runtime third-party dep (`zod`, whose mini
# build backs the sse-error.ts and moderation.ts wire schemas). Under Bun's isolated linker
# that lands in /app/shared/node_modules, not the root — so copy it too, or the
# api crashes at boot with `Cannot find package 'zod' from .../shared/...`.
COPY --from=deps /app/shared/node_modules ./shared/node_modules

# --chown=1000:1000 on every source copy. COPY preserves the build context's
# mode bits and lands the files as root:root, so a context file written under a
# restrictive umask (0600) is unreadable by the `USER 1000:1000` runtime below.
# A build from a working tree whose recently touched files are 0600 otherwise
# crash-loops with `error: EACCES reading "/app/api/src/server.ts"`; a
# `git archive` context (always 0644/0755) never shows it. Owning the files as the runtime uid makes the image immune
# to the context's umask either way.
COPY --chown=1000:1000 package.json bun.lock bunfig.toml ./
COPY --chown=1000:1000 api ./api
COPY --chown=1000:1000 shared ./shared

WORKDIR /app/api

# HEIC decode for transparent reference-image transcoding. Sharp's bundled
# libvips decodes AVIF/GIF/TIFF/WebP/PNG/JPEG in-process but NOT HEIC (no
# libde265 in the prebuilt). heif-convert (libheif-examples) + the libde265
# decode plugin add HEVC/HEIC support; api/src/storage/heicDecode.ts shells out
# to `heif-convert`. AVIF/GIF/etc. never touch this path. Trixie ships
# heif-convert in libheif-examples; if a future base renames it to heif-dec,
# update systemHeicDecoder accordingly (same positional `input output` args).
# ffmpeg: video (I2V / MiniMax H3) poster-frame extraction. api/src/storage/
# posterFrame.ts shells out to `ffmpeg` to grab frame 0 of an mp4 tile, which
# the thumb route Sharp-encodes to WebP. Only the video path uses it; image
# thumbs stay in-process via libvips.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libheif1 \
      libheif-plugin-libde265 \
      libheif-examples \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*

USER 1000:1000
EXPOSE 8787

# HEALTHCHECK uses the Bun runtime to fetch /api/health. The base image
# ships only the bun binary — no wget, no curl, no busybox. `bun -e` runs
# a one-shot script with the same network stack the api itself uses, which
# also doubles as a smoke test that Bun.fetch is functional.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "src/server.ts"]
