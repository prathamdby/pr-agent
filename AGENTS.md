# AGENTS.md

Indexer for agents working on **pr-agent**. Open the linked source; do not treat this file as the rulebook.

## What this is

- **Navigation only** — pointers to product language, design, and deeper docs.
- **Progressive disclosure** — read the entry you need; leave the rest closed.
- If a rule already lives elsewhere, **link it; do not restate it**.

## Product (always)

**pr-agent** — GitHub PR agent: automated reviews on `pull_request` events plus `/review`, `/describe`, `/ask`, and `/triage`. Roles: **web** (webhook intake) and **worker** (queues). Topology: [README.md](README.md) "How It Works".

**Language / design:** [CONTEXT.md](CONTEXT.md) is the canonical domain vocabulary. Use those terms; do not invent synonyms.

## Open when

| Need                                       | Source                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Naming, product concepts                   | [CONTEXT.md](CONTEXT.md)                                                                                                |
| Runtime topology                           | [README.md](README.md) "How It Works"                                                                                   |
| Feature catalog (`FEATURE_*`)              | [docs/features.md](docs/features.md)                                                                                    |
| Env, constants, knob checklist             | [docs/configuration.md](docs/configuration.md) · CI: [`test/settingsInventory.test.ts`](test/settingsInventory.test.ts) |
| Modules, imports, prompts, topology rubric | [docs/development.md](docs/development.md)                                                                              |
| Behaviour, deploy, scripts                 | [docs/operations.md](docs/operations.md)                                                                                |
| Queue health / recovery                    | [docs/agent-work-ops.md](docs/agent-work-ops.md)                                                                        |
| Architecture decisions                     | [docs/adr/](docs/adr/)                                                                                                  |
| Cursor Cloud services / gotchas            | [docs/cursor-cloud.md](docs/cursor-cloud.md)                                                                            |

## Same-PR doc updates

| Change                                       | Update                                         |
| -------------------------------------------- | ---------------------------------------------- |
| Domain vocabulary or product concept         | [CONTEXT.md](CONTEXT.md)                       |
| Env, default, or code constant               | [docs/configuration.md](docs/configuration.md) |
| Module layout, entry points, or import rules | [docs/development.md](docs/development.md)     |
| Runtime topology                             | [README.md](README.md) "How It Works"          |
| Behaviour, deploy, or scripts                | [docs/operations.md](docs/operations.md)       |
| Significant architecture decision            | new ADR under [docs/adr/](docs/adr/)           |
| Cursor Cloud setup                           | [docs/cursor-cloud.md](docs/cursor-cloud.md)   |

Skip doc updates when none of the above apply.

## Before ship (local CI gate)

Run the backend **check** job from [`.github/workflows/ci.yml`](.github/workflows/ci.yml) locally before every push or PR update. Do not ship a fix that fails these steps.

```bash
nub run check:effect-versions
nub run check:prod-deps
nub run check:code
nub run test
nub run build
```

`check:code` is typecheck + lint + fmt. Fix format with `nub run fmt` when `fmt:check` fails. Integration and docker jobs need services; run `nub run test:integration` when the change touches durable work, webhooks, or DB paths.
