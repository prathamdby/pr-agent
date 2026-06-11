# Coding standards

These standards are for reviewing changes to `pr-agent`. Apply them before generic TypeScript advice.

## Review stance

- Prefer the smallest reversible change that solves the request.
- Read the surrounding module before proposing a pattern.
- Keep unrelated worktree changes untouched.
- Favor direct, named functions over clever abstraction.
- Add comments only for non-obvious reasons that the code cannot express.

## TypeScript and modules

- This repo is strict TypeScript on NodeNext ESM. Local relative imports in `.ts` files must use `.js` extensions.
- Use named exports in production code. Default exports are reserved for config files such as Vitest config.
- Use `import type` for type-only imports.
- Model state with explicit unions and readonly data where the surrounding code does.
- Exhaust discriminated unions with a `never` assignment after `switch`.
- Import concrete modules. Do not add new barrel files. Approved public entry points include `src/settings/index.ts`, `src/prWorkspace/index.ts`, and `src/agentWork/executors/index.ts`.
- Use numeric separators for large numeric constants.

## Boundaries and validation

- Parse external data at the boundary. GitHub webhook payloads and agent payloads use Zod. Environment values are parsed in `src/config.ts`.
- Keep boundary guards at the edge. Internal code should work with parsed types instead of revalidating the same data everywhere.
- Keep webhook signature checks, payload parsing, and dedupe decisions before any durable work scheduling.
- Keep GitHub App private key validation strict. Placeholders must fail at config load.
- Sanitize PR-visible text before posting. Ask and review publish paths must keep outbound secret redaction.

## Configuration and tunables

- All tunables belong in `src/settings/` and `docs/configuration.md`.
- New or renamed env vars must update `src/settings/envKeys.ts`, `src/settings/defaults.ts`, `src/config.ts`, `.env.example`, and `docs/configuration.md`.
- New or changed code constants must update `src/settings/constants.ts` and `docs/configuration.md`.
- Default-only changes must update `src/settings/defaults.ts`, `.env.example` when listed there, and `docs/configuration.md`.
- Do not add env key strings, env defaults, queue names, limits, retry counts, or user-visible shared strings inside feature modules.
- Long investigator prompts stay in `src/review/*Prompt*.ts` and `src/agent/*Prompt*.ts`. Only numeric limits and shared user-visible strings belong in settings.

## Runtime architecture

- `ROLE=web` verifies requests, parses payloads, dedupes webhook deliveries, records durable intake, enqueues pg-boss jobs, and returns.
- `ROLE=web` must not do PR-surface I/O, LLM work, review publishing, labels, or local workspace preparation.
- `ROLE=worker` owns acknowledgement reactions, progress comments, reviews, asks, descriptions, labels, publish retries, and local PR workspaces.
- Mutations that create webhook events, agent work items, and pg-boss jobs must be transactional.
- Treat worker execution as at-least-once. Publishing must record progress and tolerate retries.
- Preserve per-PR and per-lens singleton semantics for review work.
- Keep pure planning separate from I/O. The `agentWork/intake/planner.ts` and `applier.ts` split is the local model.

## Agent and review runs

- Review, ask, and description workers inspect PR code through a local PR workspace prepared by the server.
- Agent-visible workspaces must not expose `.git`, hooks, token files, credentials, symlinks, write tools, or shell tools.
- GitHub PR-file metadata remains the source for changed paths and commentable right-side ranges.
- `submitReview` is the structured publish path for review payloads.
- Review runs are single-pass investigations. Submit all evidenced findings together.
- Auto-review superseding is latest-head-wins for the same PR and lens. Slash review reschedule behavior must stay bounded.
- Description publishing must preserve user-authored PR body content above `## PR Agent Description`.

## GitHub, security, and logging

- Mint installation tokens close to worker use. Do not persist long-lived GitHub credentials.
- Use direct imports from `src/github/reviewErrors.ts` for GitHub review error helpers.
- Keep security-sensitive path gates in ask and local workspace reads.
- Use evlog helpers for structured logs. Do not log raw secrets, private keys, bearer tokens, database URLs, or provider API keys.
- Keep `LOG_REDACT` behavior intact unless a change explicitly updates the security model.

## Testing

- Unit tests live under `test/**/*.test.ts` and use Vitest.
- Name tests by behavior, not implementation mechanics.
- Add focused tests when changing parsing, configuration, scheduling, queue behavior, publish idempotency, sanitization, review schema coercion, or local workspace behavior.
- Put Postgres-backed integration tests under `test/integration/**/*.test.ts` and use `vitest.integration.config.ts`.
- Changes to env inventory must keep `test/settingsInventory.test.ts` aligned.
- Changes to local PR workspace or diff behavior should use real temporary git repositories where possible.

## Formatting and checks

- Format with `pnpm fmt` or check with `pnpm fmt:check`.
- Typecheck with `pnpm typecheck`.
- Lint with type-aware Oxlint via `pnpm lint`.
- The combined code check is `pnpm check:code`.
- `pnpm test` runs the Effect version gate before Vitest.
- After refactors, run `pnpm dlx knip` to catch unused exports and files.

## Documentation

- Keep `CONTEXT.md` as domain language only.
- Update `docs/configuration.md` for tunables.
- Update `docs/operations.md` for runtime behavior, deployment, commands, or operator-visible semantics.
- Update ADRs when a change records or reverses an architecture decision.
- If runtime topology changes, update the Mermaid diagram in `README.md` under "How It Works".
- Do not add dotenv behavior. `pnpm dev` does not load `.env`; local env-file runs use `node --env-file=.env --import tsx src/index.ts`.
