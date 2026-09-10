# OpenCode Code Mode attribution

MIT license from [anomalyco/opencode](https://github.com/anomalyco/opencode)
branch `v2`, package `@opencode/codemode` (`packages/codemode`).

pr-agent does not import OpenCode TypeScript. The original walker targeted
Effect 4 RC and metered wall-clock / tool-call / output-byte limits only. The
`execute({ code })` contract, `CodeModeResult` error taxonomy, and uncatchable
host halt remain. Guest JavaScript now runs in QuickJS WASM
(`src/agent/execution/`), not an Acorn walker.

Copyright (c) 2025 opencode. MIT License: see `LICENSE`.
