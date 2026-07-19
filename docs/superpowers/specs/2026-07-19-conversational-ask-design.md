# Conversational Ask (mention + thread context)

## Goal

Natural back-and-forth with the bot on a PR via `@bot` mention (and `/ask`), with full containing-thread context. Explain-only. Always on — remove `ENABLE_THREAD_REPLIES` and the classify worker.

## Decisions

| Topic    | Choice                                                                           |
| -------- | -------------------------------------------------------------------------------- |
| Trigger  | `@`‑mention of app bot login, or `/ask`                                          |
| Auth     | Same as slash (`SLASH_ALLOWED_ASSOCIATIONS`)                                     |
| Surfaces | Anywhere on PR: inline review threads + PR conversation                          |
| History  | Full containing thread when GitHub exposes one; else the triggering comment only |
| Actions  | Explain only — no severity/dismiss/summary mutations                             |
| Engine   | Extend **Ask run** (one queue, one executor)                                     |
| Flag     | Delete `ENABLE_THREAD_REPLIES` + `agent-work-thread-classify` path               |

## Critical risk (mitigated)

PR conversation webhooks today omit `in_reply_to_id`, and issue-comment “threads” are weaker than review threads. **Mitigation:** load thread context in the **ask worker** (not on the webhook fiber). Inline threads: list review comments and group by root (`in_reply_to_id`). PR conversation: parse optional `in_reply_to_id` on `issue_comment` when present; list issue comments and filter the thread; if no parent/thread info, pass only the triggering comment. Never fail the ask because history fetch failed — soft-degrade to question-only and log.

## Architecture

```
comment created (issue_comment | pull_request_review_comment)
  → web: slash? → existing slash intake
  → else: association allowlist + bot-commenter suppress + body mentions bot login?
       → promoteAskFromWebhookEvent (mention body → question)
  → worker ask: fetch thread transcript → runAskRun → reply
```

Mention detection uses cached `getAppBotIdentity().login` (already used on webhook fiber for bot suppress). Match `@<login>` case-insensitively as a mention token (GitHub login rules). Strip mention tokens from the question text for the model.

`/ask` and mention share `promoteAskFromWebhookEvent` + ask queue. `parseAskQuestionForReplyTarget` gains a mention path: if not `/ask` but body mentions bot, remainder (or full trimmed body after stripping mentions) is the question.

## Thread transcript

Inject as `wrapUntrustedBlock("thread_transcript", …)` alongside `user_question` and optional `code_anchor`. Format: chronological `author_login: body` lines (bot login labeled). Cap total transcript chars with a settings constant; if over cap, keep root/finding comment + newest tail (still “full thread” intent for normal sizes; safety bound only).

## Deletions

- Config/env: `ENABLE_THREAD_REPLIES`, concurrency knobs for classify
- Queue: `agent-work-thread-classify` + worker subscription
- Modules: threadReplyClassify intake/executor and related tests/migrations usage
- Webhook `handleThreadReplyIfNeeded` bare-reply path

## Docs / glossary

- Update CONTEXT.md: Ask run is conversational (thread context); remove thread-reply-classify product framing; document mention trigger
- configuration.md, operations.md, ADR 0008 (stateless → thread-aware), ADR 0022 superseded/removed note
- settings inventory tests

## Tests

- Mention parse (positive/negative, strip login)
- Webhook: mention on issue_comment and review_comment enqueues ask; no mention ignored; unauthorized ignored; bot self ignored
- Ask user content includes transcript
- Soft-degrade when thread fetch fails
- Removal: ENABLE_THREAD_REPLIES / classify queue gone from inventory
