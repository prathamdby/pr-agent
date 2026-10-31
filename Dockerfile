# syntax=docker/dockerfile:1

FROM node:24.22.2-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc .node-version ./
COPY site/package.json ./site/package.json
RUN --mount=type=cache,id=npm,target=/root/.npm \
  npm ci --workspaces=false

FROM node:24.22.2-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc .node-version ./
COPY site/package.json ./site/package.json
RUN --mount=type=cache,id=npm,target=/root/.npm \
  npm ci --omit=dev --workspaces=false

FROM deps AS build
COPY tsconfig.base.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:24.22.2-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7224

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

# Optional: if the build context has repo-root models.json (e.g. Dokploy patch),
# place it at /app/models.json. Absent file must not fail the image build.
RUN --mount=type=bind,source=.,target=/build-context,ro \
  if [ -f /build-context/models.json ]; then \
    cp /build-context/models.json /app/models.json && \
    chown node:node /app/models.json; \
  fi

USER node

EXPOSE 7224

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
