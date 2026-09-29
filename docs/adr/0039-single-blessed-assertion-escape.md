# ADR 0039 — Single blessed assertion escape

`src/util/escape.ts` (`escape(reason, value)`) is the only sanctioned
`as`-cast site. The rule stays `off` in config so the stock of 91
`no-unsafe-type-assertion` hits keeps the suite green; the baseline counts
growth via `--deny` parsing instead. The helper file is CODEOWNERS-owned,
and every new call needs a baseline bump plus maintainer review.
