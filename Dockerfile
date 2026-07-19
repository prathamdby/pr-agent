# syntax=docker/dockerfile:1

FROM node:22.22.0-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts=false @nubjs/nub
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version ./
RUN --mount=type=cache,id=nub-store,target=/root/.local/share/nub/store \
  sed -i '/- "site"/d' pnpm-workspace.yaml \
  && nub install --no-frozen-lockfile

FROM deps AS prod-deps
# Nub's virtual store uses absolute symlinks into the PM cache; copying node_modules
# alone breaks between stages. pnpm deploy materializes a self-contained prod tree.
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
# Deploy re-resolves optional platform bindings (oxfmt/oxlint) from the lockfile.
# Those packages already passed nub install's age gate; disable the check here so
# unused host bindings (e.g. darwin) do not fail the linux prod image build.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm deploy --filter=pr-agent --prod --legacy /app/prod \
  --config.minimum-release-age=0

FROM deps AS build
COPY tsconfig.base.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
RUN nub run build

FROM node:22.22.0-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7224

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/prod/package.json ./package.json
COPY --from=prod-deps /app/prod/node_modules ./node_modules
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
