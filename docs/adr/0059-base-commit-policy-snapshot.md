# ADR 0059: Base-commit policy snapshot

## Status

Accepted. Supersedes the head-trust rule in decision 2 of
[ADR 0017](0017-mdc-repo-policy.md) and decision 4 of
[ADR 0019](0019-agent-instruction-files.md). Follows
[ADR 0044](0044-review-validated-artifact-recovery.md) for the contract bump.
Schema version stays 6. The contract string moves from `review-2` to `review-3`.

## Context

A review loaded `.pr-agent/*.mdc`, `AGENTS.md`, and `CLAUDE.md` from the pull
request head. Same-repo heads were trusted. Fork heads were untrusted. The
author of the head could change the rules that judged that same head, and a
fork lost binding rules that already existed on the base.

## Decision

1. **The recorded base commit is the policy source.** A review fetches that
   sha inside the existing hardened git session, after the head sha check and
   before credentials are removed. The ref is `refs/pr-agent/policy-base`.
   Allowlisted paths are `.pr-agent/<name>.mdc`, root `AGENTS.md`, and root
   `CLAUDE.md`. The snapshot is a closed union: `ok` with the blobs that
   passed the per-file caps, `absent` when the read succeeded and the
   allowlist was empty, or `unavailable` when the sha was missing or the read
   failed. There is no head fallback, no sparse retry, and no new environment
   variable.
2. **Only an `ok` snapshot binds.** Head copies of those paths render as
   untrusted proposed changes. Forged trusted headers and both binding
   sentences are neutralized inside that block. An `unavailable` snapshot
   publishes the review, sets `publishDegraded` with `repo_policy_unavailable`,
   and says so on the summary. An `absent` snapshot says nothing about policy.
3. **Ask, describe, and triage do not receive a binding policy block.**
   Verification reads `.mdc` rules from the same snapshot. A missing or
   unavailable snapshot uses the new-file starter and adds no verification
   degradation reason.
4. **Provenance is part of the recovery input digest.** Kind, base sha,
   unavailable reason, and the path plus blob sha list travel with the
   contract. A `review-2` artifact does not parse. Replay keeps the stored
   footer paths and base sha.

## Consequences

- In-flight reviews picked up by a new worker bind base policy. Old workers
  still bind head policy until they are upgraded. Upgrade review workers
  together. Web intake does not parse policy.
- A stored `review-2` artifact does not validate. Downgrade fails closed the
  same way.
- Fork pull requests keep the base rules. Head edits wait until merge.

## Reversal

Load policy from the head checkout again and restore the same-repo trust
split. `review-3` artifacts then miss and recompute.
