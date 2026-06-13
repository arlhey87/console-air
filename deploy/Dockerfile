# syntax=docker/dockerfile:1.7
#
# Dockerfile.subpath — variante que compila Console Air para servirse bajo un
# subpath (p. ej. /akash-console) inyectando `basePath` en next.config.js EN
# TIEMPO DE BUILD. No modifica ningún archivo del repositorio: la transformación
# ocurre dentro de la capa del contenedor sobre la copia de trabajo.
#
# Uso:
#   docker build -f docs/deploy/Dockerfile.subpath \
#     --build-arg BASE_PATH=/akash-console \
#     -t <region>-docker.pkg.dev/<proj>/<repo>/akash-console-air:<ver> .
#
# Equivale al apps/deploy-web/Dockerfile oficial + una línea `sed` que añade
# `basePath` al objeto nextConfig antes de `npm run build`.

# ---- Build stage ----
FROM node:22-bookworm AS builder
WORKDIR /repo

# BASE_PATH debe empezar con "/" y NO terminar con "/". Vacío = sin subpath.
ARG BASE_PATH=/akash-console

RUN npm install -g npm@11.11.0

COPY . .

# Única fuente de verdad del subpath. next.config.js la lee para fijar basePath
ENV NEXT_PUBLIC_BASE_PATH=${BASE_PATH}

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# El build de Next+webpack sobre este monorepo agota el heap por defecto (~2 GB).
ENV NODE_OPTIONS=--max-old-space-size=6144

RUN npm run build

# ---- Runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0

COPY --from=builder /repo/apps/deploy-web/.next/standalone/ ./
COPY --from=builder /repo/apps/deploy-web/.next/static/ ./apps/deploy-web/.next/static/
COPY --from=builder /repo/apps/deploy-web/public/ ./apps/deploy-web/public/

RUN useradd --system --uid 1001 --no-create-home nextjs \
 && chown -R nextjs:nextjs /app
USER nextjs

EXPOSE 3001
CMD ["node", "apps/deploy-web/server.js"]
