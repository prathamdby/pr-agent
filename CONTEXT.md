# Context glossary

This file is **domain language only** — not a specification of how the system is implemented.

- **Webhook delivery** — A single signed HTTP POST from GitHub to your app, identified by the `X-GitHub-Delivery` header.
- **PR conversation** — The main pull request discussion timeline (GitHub models this as comments on an issue).
- **Inline review thread** — A thread anchored to a specific line/diff review comment on a pull request.
- **PR-surface I/O** — The set of GitHub REST calls the app makes during webhook processing: acknowledgement reactions on the PR conversation, an issue comment, or an inline review thread; posting on the PR conversation; replying on an inline review thread; fetching the PR head SHA.
- **Slash command** — A **new** (`created`) comment whose first non-empty line begins with `/` followed by a command token.
- **Command issuer** — Anyone who can participate in the PR comment surface where the command appears.
- **Reply target** — Descriptor for where a slash command's response should appear (PR conversation vs inline review thread).
- **Draft pull request** — A PR still marked draft; this service runs the same automation on draft PRs as on ready PRs.
- **Acknowledgement reaction** — GitHub `eyes` / 👀 signaling that a webhook was accepted and work is in progress (on the PR issue and/or triggering comment).
- **Review run** — One automated LLM + tool pass scoped to a pull request (automated `pull_request` events, `/review`, or `/review-security`).
- **Review lens** — Which investigator prompt drives a review run: **general** (bug-and-correctness; auto `/review`) or **security** (`/review-security` only). Code uses `mode`: `"review"` or `"review-security"`.
- **Review queue** — Bounded in-process work queue (size `REVIEW_CONCURRENCY`) that serializes review runs so a burst of webhook deliveries cannot start unbounded concurrent LLM/tool loops.
- **Webhook parse error** — The JSON failed validation at the app boundary (unexpected or missing fields for that event type); the delivery is not treated as processed for deduplication until parsing succeeds.
- **Review payload** — The structured, validated description of a completed review run (findings plus overview gates), emitted once per review run via `submitReview`.
- **Review summary comment** — A server-rendered comment on the PR conversation, identified by the sentinel `## PR Agent Review`, containing navigation and overview gates—not duplicated finding bodies from inline review threads.
- **Security review summary comment** — Same shape as a review summary comment, identified by `## PR Agent Security Review`; may coexist with a general review summary on the same PR.
- **Probable secondary rate limit** — GitHub returned an auth-shaped error while the installation token is still within its TTL; treated as a likely pacing/abuse limit for logging and cooldown, not a confirmed diagnosis.
- **Truncated change set** — File listing for a review run where some changed files are omitted due to configured caps; the run continues with explicit truncation metadata.
- **Rate-limit circuit** — After repeated classified rate-limit failures in one review run, further GitHub investigation tools are short-circuited; `submitReview` remains available.
- **Ask run** — One automated LLM + tool pass that answers a command issuer's question about PR code; triggered by `/ask` only; produces a plain-text **ask answer** (not a review payload or review summary comment). Each ask run is independent; prior ask runs or thread comments are not used as context.
- **Ask queue** — Bounded in-process work queue (size `ASK_CONCURRENCY`) that serializes ask runs so a burst of `/ask` commands cannot start unbounded concurrent LLM/tool loops.
- **Code anchor** — File path, line range, and diff hunk from an inline review comment; tells an ask run which code the command issuer was looking at.
