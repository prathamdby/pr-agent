# syntax=docker/dockerfile:1

FROM node:22.22.0-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts=false @nubjs/nub
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=nub-store,target=/root/.local/share/nub/store \
  nub ci

FROM deps AS prod-deps
RUN nub prune --prod

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

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

USER node

EXPOSE 7224

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
