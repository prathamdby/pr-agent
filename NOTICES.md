# Third-party notices

## Geist font

The landing page (`site/`) uses [Geist](https://vercel.com/font) by Vercel, Inc.,
self-hosted under the SIL Open Font License, Version 1.1.

## deepsec

Portions of the security review system prompt in `src/agent/prompts/securityPrompt.ts` are adapted from [vercel-labs/deepsec](https://github.com/vercel-labs/deepsec) (`packages/processor/src/prompt/core.ts`), used under the Apache License 2.0.

```
deepsec
Copyright 2026 Vercel, Inc. and contributors

This product includes software developed at Vercel, Inc.
(https://vercel.com/).
```

## thermo-nuclear code quality review skill

Portions of the code-quality review system prompt in `src/agent/prompts/qualityPrompt.ts` are adapted from the thermo-nuclear code quality review skill in [cursor/plugins](https://github.com/cursor/plugins) (`cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md`). The adapted prompt is reworded for pr-agent and is not a verbatim copy.
