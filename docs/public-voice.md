# Public voice

## Public documentation

Any behavior, env, feature-mode, host, or privacy change updates the matching public copy in the same PR. That includes [README.md](../README.md), [docs/features.md](features.md), [docs/configuration.md](configuration.md), [docs/operations.md](operations.md), [site/lib/llmsKnowledge.ts](../site/lib/llmsKnowledge.ts), and generated `site/public/llms.txt` (`renderLlmsTxt()` must stay identical to the committed file). These documentation updates do not need separate copy approval. Do not leave a later docs PR.

The main site's human-facing copy is permission-gated (see [Non-negotiables](../AGENTS.md#non-negotiables)). When development makes that copy outdated, propose the smallest factual correction and stop until the user explicitly approves the exact wording. Keep its tone and wording otherwise. Continue updating README, docs, and agent-facing documentation without waiting for that approval. Match the voice below on every surface. Do not write a second register for the site or `/llms.txt`.

- Speak to the operator. "A pull request is opened on your project." Not "Someone opens a pull request."
- The README hook stays simple English. No web, worker, database, webhook, queue, Postgres, or HTTP status in the first paragraphs. Those words belong in Installation and later.
- Lead with what lands on the pull request, then why this App: you run it, no per-seat bill, you pick who reads the code.
- Keep this README order: Features, Installation, Verification, Examples, Recommended hosts, Pratham's way of hosting, Local development, Data privacy, Documentation. Do not add a How it works section or a topology mermaid to the README. Topology stays in [docs/topology.md](topology.md).
- The Features table names commands the operator types. State invalid modes next to it. `FEATURE_REVIEW` accepts `manual`, `auto`, or `approval`. `off` crashes. `FEATURE_ASK` and `FEATURE_TRIAGE` accept `off` or `manual`. `auto` aborts.
- Examples is a two-column highlight table. Name and short copy on the left, screenshot on the right. Review first, then Description, then Ask, then Triage. Use `valign="middle"`, `36%` / `64%`, and `width="100%"` on the image. GitHub strips custom font sizes.
- Recommended hosts lists three VPS rows only: Hetzner, Hostinger, DigitalOcean. Do not grow that table. Panels stay Dokploy, Coolify, or a proxy the operator already runs. Do not invent a second production or panel compose file or runtime. Maintainer-local Compose is [docker-compose.dev.yml](../docker-compose.dev.yml).
- Optional extras under Data privacy are separate `<details>` blocks: Logging and PostHog. Do not add a standalone analytics heading.
- Sentence-case headings except `Pratham's way of hosting`. Short sentences. No puffery, no em dashes, no chatbot filler. If a sentence could sit in another project's README unchanged, cut it.
- Long traps stay in `<details>`. The open page stays short.
- After README or docs edits, run `npm run fmt` so `oxfmt --check` stays green.
