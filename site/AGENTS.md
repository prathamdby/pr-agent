# Landing site

This file covers `site/`. The root [AGENTS.md](../AGENTS.md) still applies, including the copy approval gate. [DESIGN.md](DESIGN.md) is the design spec. This file says how to change the design system without breaking it or the spec's shape. Run every `nub` command from the repository root.

## Before UI work

Before you add or change a section, a component, a style, a token, or a class recipe:

1. Read DESIGN.md: House rules, the section for what you touch, and Do and don't.
2. Build from what exists: `Section`, `SectionHeading`, `SectionTitle`, `Eyebrow`, `Button`, `ButtonLink`, `CopyButton`, `.btn`, `.card`, `.chip`, `.window`, `.wash`, and the `@theme` tokens in `app/globals.css`.
3. If nothing fits, add the token or recipe in the same change as the first code that needs it, following the rules below.

## Tokens

`app/globals.css` has two layers. `:root` holds `--palette-*` primitives, raw values that only `@theme` reads. `@theme` holds the semantic tokens, and components reach them only through utilities such as `bg-surface` or `text-label`.

- Name a token by purpose, not by hue or value: `--color-text-tertiary`, `--text-label`. Use one word per idea across the set, and pair a surface with its foreground.
- Keep existing names. Renaming a working token costs every caller and helps nobody.
- Add a token only when its role repeats in two or more places or someone would change it site-wide. It lands with its first use, a role comment in `app/globals.css`, and a row in the matching DESIGN.md table.
- A new colour is a primitive in `:root`, then a semantic alias in `@theme`, then the utility. Never put a raw value in a component.
- These stay plain values: a one-off layout offset (comment what it aligns to), a value set by content such as an aspect ratio, math between tokens, and brand art such as the wordmark sky.
- No product words in token names.

## Changing what renders

- An identical-value swap replaces a literal with a token that holds exactly that value. It needs no approval, but prove it with a 0 px screenshot diff.
- Any other visible change to a shipped section is the maintainer's call. Propose it with before and after screenshots and wait. Copy changes stay behind the root copy gate.

## Recipes and components

- A class recipe repeated in two or more places gets one owner: a component in `components/` or a class in `@layer components`. Callers keep their own padding, layout, and ink.
- Component classes live in `@layer components`, so utilities on the same element still win.
- A white surface class that replaces `bg-surface` joins the `.wash :is(.window, .card, .bg-surface) *` selector, so shadows inside it stay neutral on a wash.
- CSS hover rules sit inside `@media (hover: hover)`. Transitions name their properties.

## Keeping DESIGN.md in shape

- Every token, recipe, component, or owning file you add, rename, or remove updates DESIGN.md in the same change.
- Edit inside the existing structure. Add a row to the existing table instead of a new section. A new `##` section also gets a line in Contents, in page order.
- Recipes are the exact class strings from the code, in backticks. Copy them, never paraphrase.
- Token tables keep their columns: token, value, then purpose. The File map keeps one row per file that owns part of the system.
- Match the file's voice: sentence-case headings, short sentences, no em dashes, and its spelling (colour, behaviour).
- Run `nub run fmt` after editing. oxfmt realigns the tables, so do not align them by hand.

## The check

`nub run check:site-design` runs `scripts/check-site-design.mjs` against `scripts/baselines/site-design-baseline.json`. DESIGN.md lists its rules under Verification.

- A red rule is a finding about your change. Fix the code. Never raise a baseline count, weaken a rule, or move a class into a string built at runtime to hide it.
- An `@theme` token missing from DESIGN.md fails `docs-token-parity`, and so does a `--color-*` named in DESIGN.md that does not exist.
- A new rule is shown failing before it lands: plant one violation in a temporary copy, run `node scripts/check-site-design.mjs --root <copy>`, and show it fail, then pass on the clean tree. Do not commit fixtures for it.
- The check reads source text. Check contrast, behaviour, and runtime class names in the browser.

## Verify

1. `nub run check:code`, `nub run check:site-design`, and `nub run --node site:build`. `public/llms.txt` must still equal `renderLlmsTxt()`.
2. Screenshots at 1440, 820, and 390, as DESIGN.md Verification describes.
3. For a refactor, capture before and after, diff the pixels at tolerance 0, and compare the page text and the markdown twin (`curl -H 'Accept: text/markdown'`). An unlisted difference is a defect.

When the same correction comes up twice, turn it into a token, a recipe, or a check rule instead of a note.
