# GitHub reaction lifecycle (👀 / 👍 / 👎)

## Goal

Every GitHub interaction PR Agent acknowledges gets a visible reaction lifecycle:

| Phase                  | Reaction | API content |
| ---------------------- | -------- | ----------- |
| Accepted / in progress | 👀       | `eyes`      |
| Terminal success       | 👍       | `+1`        |
| Terminal failure       | 👎       | `-1`        |

## Scope

- All durable agent work: review, ask, description, triage, verification
- Ack-only surfaces that finish in the ack job (help, disabled, usage/too-long, slash dedupe replies)
- Out of scope: CI-refresh jobs (no triggering human comment; surgical summary edit only)

## Design

### API

1. Keep `GITHUB_REACTION_EYES`; add `GITHUB_REACTION_PLUS_ONE` (`+1`) and `GITHUB_REACTION_MINUS_ONE` (`-1`).
2. Generalize `safeReaction` to take a reaction content argument (default remains `eyes` for call-site clarity — callers pass the constant explicitly).
3. Add `reactOnAckTargets` helper that posts one reaction to each `AckTarget`, swallowing per-target failures the same way ack does today.

### Target resolution

Persist optional `ackTargets` on every work-item payload at intake (same targets used for the eyes ack). At complete/fail:

1. Prefer `payload.ackTargets` when present and non-empty.
2. Else fall back: always the PR target; for ask/triage also the triggering comment (from `commentId` + `replyTarget`).

### Hooks

1. **Initial 👀** — unchanged: `executeAckJob` → `safeReaction(..., eyes)`.
2. **Success 👍** — after `markWorkCompleted` in `completeDurableExecution` (skip when `result.rescheduled`).
3. **Failure 👎** — after terminal `markWorkFailed` in `handleDurableExecutionError` (retries do not thumb).
4. **Ack-only 👍** — when the ack job posts a reply and has no durable `workItemId` (help / disabled / usage), react `+1` on its targets after the reply.

### Docs / vocabulary

- Update `CONTEXT.md` **Acknowledgement reaction** to cover the full lifecycle.
- Document new constants in `docs/configuration.md`.
- Light touch in `docs/operations.md` where eyes-only wording appears.

## Non-goals

- Removing prior eyes reactions (GitHub keeps them; thumbs are additive).
- Reacting on cancelled/superseded work.
- Changing check-run or commit-status emoji policy (those stay emoji-free).
