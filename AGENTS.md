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

| Need | Source |
| ---- | ------ |
| Naming, product concepts | [CONTEXT.md](CONTEXT.md) |
| Runtime topology | [README.md](README.md) "How It Works" |
| Env, constants, knob checklist | [docs/configuration.md](docs/configuration.md) · CI: [`test/settingsInventory.test.ts`](test/settingsInventory.test.ts) |
| Modules, imports, prompts, Cloud setup, topology rubric | [docs/development.md](docs/development.md) |
| Behaviour, deploy, scripts | [docs/operations.md](docs/operations.md) |
| Queue health / recovery | [docs/agent-work-ops.md](docs/agent-work-ops.md) |
| Architecture decisions | [docs/adr/](docs/adr/) |

## Same-PR doc updates

| Change | Update |
| ------ | ------ |
| Domain vocabulary or product concept | [CONTEXT.md](CONTEXT.md) |
| Env, default, or code constant | [docs/configuration.md](docs/configuration.md) |
| Module layout, entry points, or import rules | [docs/development.md](docs/development.md) |
| Runtime topology | [README.md](README.md) "How It Works" |
| Behaviour, deploy, or scripts | [docs/operations.md](docs/operations.md) |
| Significant architecture decision | new ADR under [docs/adr/](docs/adr/) |

Skip doc updates when none of the above apply.
