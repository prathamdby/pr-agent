# OpenCode Code Mode attribution

MIT license from [anomalyco/opencode](https://github.com/anomalyco/opencode)
branch `v2`, package `@opencode/codemode` (`packages/codemode`).

pr-agent does not import OpenCode TypeScript. That walker targets Effect 4 RC
and meters wall-clock / tool-call / output-byte limits only. Issue #580 requires
AST-step fuel, the `CodeModeResult` error taxonomy, and an uncatchable host halt
on lease abort. Those run in the host-owned Acorn walker beside this directory.

Copyright (c) 2025 opencode. MIT License: see `LICENSE`.
