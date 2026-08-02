# pr-agent landing (`pr-agent-landing`)

Marketing site for [pr-agent](https://github.com/prathamdby/pr-agent).

## Agent-followable QA path

From the repo root:

1. Install workspace deps: `nub install` (or `nub ci`)
2. Dev server: `nub run site:dev` → open http://localhost:3000
3. Pages to verify:
   - Home (`/`) — hero, features, pricing, FAQ, quickstart
   - `GET /health` → `{"status":"ok"}` (`curl -sS http://127.0.0.1:3000/health`)
4. OG assets: `nub run site:generate-og`
5. Production build: `nub run site:build`
6. Unit tests: `nub run site:test`

## Deploy observability (Vercel)

After each deploy:

1. Vercel dashboard → project **Deployments** — build status green
2. Open production/preview URL `/health` — JSON `status: ok`
3. Check Vercel **Analytics / Logs** for elevated 5xx or function errors
4. Optional: confirm `x-request-id` is present on responses when hitting server routes

Rollback: promote the previous successful deployment in the Vercel UI (instant rollback).
