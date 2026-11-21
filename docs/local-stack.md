# Local stack

Use the smallest stack that exercises the behavior. `SQLITE_DIR` (default `./data`) is the only durable state; point it at a dedicated directory. Start from [Local development edge cases](operations.md#local-development-edge-cases) and [Development](operations.md#development). The operator install path is [README.md](../README.md).

One process owns `POST /webhooks`, `/health`, `/ready`, the dispatcher, and agent execution. One process accepts work and publishes reviews. A second process on the same `SQLITE_DIR` fails fast on `pr-agent.lock.sqlite`, so give a second checkout its own directory.

## Test data and external systems

- Use a test GitHub App installation and a disposable PR repository for end-to-end checks.
- Use a dedicated local `SQLITE_DIR`. Never point a local process at an operator's data volume or copy its SQLite files into a shared place.
- `npm run test:integration` needs no Docker or database server; each suite gets a temporary `SQLITE_DIR`.
- Keep provider calls scoped to the test PR and the smallest model operation that proves the change.
- Read real repository fixtures when they improve coverage, but do not copy secrets or mutate the source checkout.
