# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ca-certificates curl less procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/cli.js"]
