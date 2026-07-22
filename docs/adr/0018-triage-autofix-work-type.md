# ADR 0018 — Triage autofix work type

## Status

Accepted.

## Context

PR Agent can publish findings, but a finding has no fixed/open lifecycle. Maintainers must copy prompts into another agent, commit fixes, and manually resolve threads. Sweep, Copilot, and CodeRabbit already offer autofix paths, so the missing loop is visible.

This is the first pr-agent feature that writes to a user branch. It needs a smaller blast radius than review publishing.

## Decision

1. **Fourth work type.** Add `/triage` as a slash-only work type. It consumes prior PR Agent inline findings and emits triage verdicts, not new findings.

2. **Isolated writable checkout.** Triage uses a fresh full clone of the PR head branch. It never mutates the shared PR repository view cache used by review, ask, and description runs.

3. **Same-repo only.** Fork PRs run in report-only mode. The app never tries to push to a fork branch.

4. **Server-executed commits.** The model can edit files through exact-match tools and request `commitFix`; server code validates paths, sensitive paths, commit messages, file count, and diff size. Commits always use `git commit -n`; hooks do not run.

5. **Push-or-nothing publish.** Triage pushes before posting `Fixed in` replies or resolving threads. A non-fast-forward push writes a stale-head report and performs no thread actions. Triage never force-pushes, rebases, or amends.

6. **Dismissed is maintainer-owned.** A dismissed verdict requires human reply evidence and is never auto-resolved.

7. **Current and legacy findings are triage-eligible.** Triage inventory includes specialist findings from current `review` runs plus recognized legacy `review-security`, `review-quality`, and `review-tests` threads (P0–P3 when posted as inline threads). Mode is resolved from the `pr-agent:review-pointer` HTML marker, legacy pointer strings, or `publish_records` backfill. `REVIEW_POINTER_NOTE_LEAD` alone never makes a thread eligible.

8. **Scoped invocation.** PR-conversation `/triage` runs on all unresolved eligible findings. Inline-thread `/triage` runs on one finding. One active triage job per PR remains; thread `/triage` during a full-PR run acks that full triage is already in progress.

9. **Lens discovery is publish-time.** New inline reviews append `<!-- pr-agent:review-pointer lens=<mode> -->` after pointer-body truncation so classification survives long bodies.

## Consequences

- GitHub App setup now needs **Contents: read/write** for `/triage`.
- A bot push fires a normal `synchronize` webhook and automated general review. That is expected validation, not a loop, because `/triage` never auto-runs.
- `publish_records` now tracks `triage_push`, `triage_thread_actions`, and `triage_report` for crash-safe retries.

## Reversal

Remove `/triage`, the triage queue, the writable checkout, and migration `011_triage_work.sql`. Existing review, ask, and description work types keep working.
