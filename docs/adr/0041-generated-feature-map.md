# ADR 0041 — Generated feature map with drift test

`docs/feature-map.md` is generated from `src/agentWork/types.ts`,
`src/agentWork/worker.ts` registration calls, and the queue constants by
`scripts/gen-feature-map.mjs`, formatted with the repo `oxfmt`, and
asserted by `test/featureMap.test.ts`. Hand edits always fail the test.
The map covers all nine lanes: five durable work types plus the
ack, ci-projection, retention, and code-index auxiliary lanes.
