# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=26
ARG BUN_VERSION=1.3.6

FROM oven/bun:${BUN_VERSION}-alpine AS bun

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

FROM base AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    APP_PORT=9503
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node package.json tsconfig.json ./
RUN mkdir -p data src/logs && chown -R node:node data src/logs
USER node
EXPOSE 9503
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:${APP_PORT}/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/main.js"]
