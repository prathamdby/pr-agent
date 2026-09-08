# Third-party notices

## deepsec

Portions of the security review system prompt in `src/agent/prompts/securityPrompt.ts` are adapted from [vercel-labs/deepsec](https://github.com/vercel-labs/deepsec) (`packages/processor/src/prompt/core.ts`), used under the Apache License 2.0.

```
deepsec
Copyright 2026 Vercel, Inc. and contributors

This product includes software developed at Vercel, Inc.
(https://vercel.com/).
```

## OpenCode Code Mode

The confined JavaScript investigation model (one `execute({ code })` tool, empty host environment, `tools.*` delegation) follows [anomalyco/opencode](https://github.com/anomalyco/opencode) `@opencode/codemode` on branch `v2`, used under the MIT License. The host interpreter, fuel meter, and `CodeModeResult` taxonomy are pr-agent-owned. License text: [`src/agent/codemode/vendor/LICENSE`](src/agent/codemode/vendor/LICENSE).

```
Copyright (c) 2025 opencode
```

## thermo-nuclear code quality review skill

Portions of the code-quality review system prompt in `src/agent/prompts/qualityPrompt.ts` are adapted from the thermo-nuclear code quality review skill in [cursor/plugins](https://github.com/cursor/plugins) (`cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md`). The adapted prompt is reworded for pr-agent and is not a verbatim copy.
