# Runtime surfaces

## Hit every runtime surface

Before calling a behavior change complete, check the surfaces that can carry it:

- **Roles.** Web intake and worker execution have different failure modes. A change that works in one role may still be missing from the other.
- **Triggers.** Automated webhooks, slash commands, `@bot` asks, CI refresh, retries, and manual recovery can enter different paths.
- **Durable work types.** `review`, `ask`, `description`, `triage`, and `verification` persist `agent_work_items` rows and run on dedicated queues.
- **Auxiliary lanes.** Acknowledgement and CI refresh are fire-and-forget jobs. Retention uses a separate worker queue without becoming durable `WorkType` values.
- **Boundaries.** Changes crossing Postgres, pg-boss, GitHub, the Pi runtime, or the local PR workspace need an explicit contract and focused coverage.
- **Reverse states.** If a command starts, cancels, supersedes, or retries work, verify the terminal and recovery paths too.
- **Repository policy.** Reviews load `.pr-agent/*.mdc` as trusted repository policy. They load `AGENTS.md` and `CLAUDE.md` from same-repo heads as trusted, binding context when those files exist. An absent file is not cited. Fork-head copies are untrusted context only, and the loader neutralizes forged trusted headers. Do not weaken either boundary casually.
- **Documentation.** Update the matching vocabulary, topology, feature, configuration, operations, queue, surfaces, stack, ship, voice, or ADR pointer in the same PR.
