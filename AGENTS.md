# Agent maintenance index

**pr-agent** is a GitHub PR agent: automated reviews on `pull_request` events plus `/review`, `/describe`, `/ask`, and `/triage` slash commands. It runs as two roles over Postgres + pg-boss: **web** (webhook intake, durable dedupe, job enqueue) and **worker** (ack, review, ask, description, triage, retention queues).

## Always apply

- Use the domain vocabulary from [CONTEXT.md](CONTEXT.md); it is the canonical product language — do not invent synonyms.
- No magic numbers or env defaults in feature modules; everything goes through `src/settings/`. Follow the knob-change checklist in [docs/configuration.md](docs/configuration.md).
- Long prompt prose lives in prompt modules, not settings; see [docs/development.md](docs/development.md).
- Import concrete modules, not removed barrel `index.ts` files; run `nubx knip` after refactors (details in [docs/development.md](docs/development.md)).
- If a change alters runtime topology, update the [README.md](README.md) "How It Works" Mermaid diagram in the same PR (rubric in [docs/development.md](docs/development.md)).
- Docs are part of the change: if your change is critical (see Keep the docs true), update the matching doc in the same PR.

## Where to look

| Read                                                             | When                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [CONTEXT.md](CONTEXT.md)                                         | Domain language — always read before naming things                       |
| [README.md](README.md) "How It Works"                            | Runtime topology (web vs worker, Postgres, pg-boss queues)               |
| [docs/configuration.md](docs/configuration.md)                   | Any tunable, env var, or code constant change                            |
| [docs/development.md](docs/development.md)                       | Module layout, import rules, Cursor Cloud setup, topology-diagram rubric |
| [docs/operations.md](docs/operations.md)                         | Behaviour, deployment, developer scripts                                 |
| [docs/agent-work-ops.md](docs/agent-work-ops.md)                 | Queue health, retry and recovery                                         |
| [docs/adr/](docs/adr/)                                           | Architecture rationale (ADRs numbered 0001-0018)                         |
| [test/settingsInventory.test.ts](test/settingsInventory.test.ts) | CI gate for env/config alignment                                         |

## Keep the docs true

| If you change                                                       | Update in the same PR                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Domain vocabulary or a product concept                              | [CONTEXT.md](CONTEXT.md)                                                          |
| Env var, default, or code constant                                  | [docs/configuration.md](docs/configuration.md) (follow its knob-change checklist) |
| Module layout, public entry points, or import rules                 | [docs/development.md](docs/development.md)                                        |
| Runtime topology (roles, queues, webhook route, executor ownership) | [README.md](README.md) "How It Works" Mermaid diagram                             |
| User-facing behaviour, deployment, or scripts                       | [docs/operations.md](docs/operations.md)                                          |
| A significant architecture decision                                 | new ADR in [docs/adr/](docs/adr/) (next number)                                   |

If none apply, no doc update is needed; do not update docs speculatively.
