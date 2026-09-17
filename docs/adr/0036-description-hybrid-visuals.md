# Description payload uses markdown prose plus flat typed visuals

The description agent must work on small and frontier models, and GitHub must
render only safe fences. Nested theme trees overfit large models. Freeform
markdown fences are hard to sanitize. The submit contract is markdown
`description` plus flat `visuals[]` entries (`kind` + `content`) drawn
from the make-pr / show-me view menu. The server validates and renders.
Prompt guidance follows make-pr's smallest-useful-view procedure inside that
flat typed list: select only proved sketches that improve comprehension,
prefer `diff` for existing shapes, and keep visuals optional when the
inspected diff has no sketchable shape. HTML artifacts remain out of schema.
`changesDiagram` is not a field.

## Status

Accepted.

## Consequences

- Mermaid is `visuals[].kind === "mermaid"` and reuses the Mermaid sanitizer.
- HTML artifacts from show-me are out of schema.
- Prompt guidance teaches view picking; the schema does not nest themes.
- Body scale product names are `S`, `M`, and `L` (mapped from existing file-count and line-change thresholds).
- Title rewrite defaults on and enforces make-pr default title rules at submit time.
