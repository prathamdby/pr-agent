# pr-agent

**Vocabulary** — [CONTEXT.md](CONTEXT.md). Naming a product concept.
**Topology** — [README.md](README.md) "How It Works". Web, worker, or queue edges.
**Feature** — [docs/features.md](docs/features.md). A `FEATURE_*` setting.
**Knob** — [docs/configuration.md](docs/configuration.md). An env, default, or code constant.
**Module** — [docs/development.md](docs/development.md). Layout, imports, prompts, or the topology-diagram rubric.
**Behaviour** — [docs/operations.md](docs/operations.md). Deploy, scripts, or runtime behaviour.
**Queue** — [docs/agent-work-ops.md](docs/agent-work-ops.md). Durable-work health or recovery.
**ADR** — [docs/adr/](docs/adr/). A significant architecture decision.
**Cursor Cloud** — [docs/cursor-cloud.md](docs/cursor-cloud.md). Cloud VM services or setup.

Same PR: update every pointer whose branch matched the change.

## Check

Before every push, run the backend check job from [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

```bash
nub run check:effect-versions
nub run check:prod-deps
nub run check:code
nub run test
nub run build
```

Done when every command exits 0. Format with `nub run fmt` if `fmt:check` fails. Also run `nub run test:integration` when the change touches durable work, webhooks, or DB paths.
