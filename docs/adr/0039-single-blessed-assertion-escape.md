# ADR 0039 — Single blessed assertion escape

`src/util/escape.ts` (`escape(reason, value)`) is the only sanctioned
`as`-cast site. `typescript/no-unsafe-type-assertion` is deleted with the
other codes in [ADR 0061](0061-tsrs-compiler.md). The 91-hit exemption and
that growth count are gone with it. The helper file is CODEOWNERS-owned,
and every new call needs a baseline bump plus maintainer review.
