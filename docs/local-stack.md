# Local stack

Use the smallest stack that exercises the behavior. `DATABASE_URL` is required for both roles. Start it from [Local development edge cases](operations.md#local-development-edge-cases) and [Development](operations.md#development). The operator install path is [README.md](../README.md).

The web process owns `POST /webhooks` and exposes intake health and readiness probes. The worker owns queue consumers and agent execution, with separate readiness for consumer and Postgres health. Web-only runs accept work but do not publish reviews.

## Test data and external systems

- Use a test GitHub App installation and a disposable PR repository for end-to-end checks.
- Use a dedicated local Postgres database. Do not reuse an operator database or delete shared schemas.
- Keep provider calls scoped to the test PR and the smallest model operation that proves the change.
- Read real repository fixtures when they improve coverage, but do not copy secrets or mutate the source checkout.
