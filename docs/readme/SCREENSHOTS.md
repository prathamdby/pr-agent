# README screenshot checklist

Replace placeholder SVGs under `docs/readme/assets/` with real captures when ready. Recommended width: **1200px** (PNG or WebP).

| File | Command | What to capture |
|------|---------|-----------------|
| `describe.example.svg` | `/describe` | PR **Description** tab showing `## PR Agent Description` block merged into the body |
| `review.example.svg` | `/review` | PR **Conversation** with `## PR Agent Review` summary; optional second shot of **Files changed** with inline P0 to P2 threads |
| `ask.example.svg` | `/ask` | PR conversation or inline diff comment thread with a completed ask answer |
| `review-security.example.svg` | `/review-security` | PR conversation with `## PR Agent Security Review` summary |
| `review-quality.example.svg` | `/review-quality` | PR conversation with `## PR Agent Quality Review` summary |

## Replace placeholders

1. Capture screenshots at ~1200px wide (crop GitHub UI chrome consistently).
2. Save as PNG or WebP in `docs/readme/assets/` (same basename, new extension, or overwrite SVG by updating README paths).
3. Update `README.md` `<img src="...">` paths if filenames change.
4. Delete or keep SVG placeholders in git history only; do not commit sensitive repo content.

## Tips

- Use a public test repo or redact org/repo names if needed.
- Wait for worker completion after slash commands (webhook returns before publish).
- For `/review`, include at least one inline thread if the PR has P0 to P2 findings.
