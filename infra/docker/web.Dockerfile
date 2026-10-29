# Keep the production web build on the same exact Bun patch as the API image.
# Patch-level resolver/runtime differences have affected this repository, so a
# mixed image pair is not a reproducible deployment. Root engines matches too.
FROM oven/bun:1.4.3 AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
COPY shared/package.json ./shared/package.json

RUN bun install --frozen-lockfile

COPY tsconfig.base.json ./
COPY web ./web
COPY shared ./shared

RUN bun run --cwd web build

# Pin nginx to a specific patch + alpine variant. `nginx:alpine` is a
# moving tag — pinning here keeps web rebuilds reproducible and follows the
# same exact-version discipline as the api Dockerfile. Bump deliberately when
# nginx ships a CVE fix; do not let `:latest`/`:alpine` drift the build
# silently.
FROM nginx:1.31.5-alpine AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF

COPY infra/docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 80
