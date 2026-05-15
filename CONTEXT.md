# Context glossary

This file is **domain language only** — not a specification of how the system is implemented.

- **Webhook delivery** — A single signed HTTP POST from GitHub to your app, identified by the `X-GitHub-Delivery` header.
- **PR conversation** — The main pull request discussion timeline (GitHub models this as comments on an issue).
- **Inline review thread** — A thread anchored to a specific line/diff review comment on a pull request.
- **Slash command** — A **new** (`created`) comment whose first non-empty line begins with `/` followed by a command token.
- **Command issuer** — Anyone who can participate in the PR comment surface where the command appears.
- **Draft pull request** — A PR still marked draft; this service runs the same automation on draft PRs as on ready PRs.
- **Acknowledgement reaction** — GitHub `eyes` / 👀 signaling that a webhook was accepted and work is in progress (on the PR issue and/or triggering comment).
- **Review run** — One automated LLM + tool pass scoped to a pull request (automated `pull_request` events or a `/review` command).
- **Webhook parse error** — The JSON failed validation at the app boundary (unexpected or missing fields for that event type); the delivery is not treated as processed for deduplication until parsing succeeds.
